// agent 的工具白名单：只读文件 + 按 agent 配置放行的只读命令，其余一律拦截。
// 由 durable 的 beforeTool 钩子调用（server/agent/driver.ts）；钩子抛错时 durable 也会拦截（fail-closed）。
// 每个会话用自己的策略创建一份守卫，同一进程里并行的 agent 互不影响。
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface GuardPolicy {
	/** 允许读的目录（不存在的会被丢弃） */
	roots: string[];
	/** 放行的命令族：git / glab / meegle / archery / superset / sls / git-local */
	bash: string[];
	skillsDir: string;
	/** 允许 edit / write 的目录：只有开发任务有，是它自己的 worktree */
	writeRoots?: string[];
	/** 允许执行的构建/测试命令前缀，例如 "go test"；只能在 writeRoots 里执行 */
	commands?: string[];
}

// 即使在允许的目录里，这些也不读：凭证、密钥、本地配置
const secretPattern =
	/(^|\/)(\.env[^/]*|\.ssh|\.aws|\.kube|\.netrc|\.npmrc|\.git-credentials|id_[a-z0-9]+|[^/]*\.(pem|key|p12)|credentials[^/]*)(\/|$)/i;

// 只放行这些 git 子命令；--output/--ext-diff 会写文件或执行外部程序，--no-index 能读仓库外任意文件
const gitReadOnly = new Set(["log", "show", "diff", "blame", "status", "branch", "tag", "rev-parse", "ls-files", "grep"]);
const gitBannedArg = /^(--output|--ext-diff|--textconv|--no-index|-c$|--exec|--upload-pack|--config|--open-files-in-pager|-O)/;

// 开发任务在自己的 worktree 里可以做的本地 git 写操作；push / fetch / 切分支 / reset 一律不放
const gitLocalWrite = new Set(["add", "commit", "restore", "rm", "mv"]);

const meegleReadOnly = new Set([
	"workitem get",
	"workitem query",
	"comment list",
	"project search",
	"user search",
	"url decode",
	"workflow get-node",
	"relation list",
	"mywork todo",
]);

// glab 用的是 Yi 的 GitLab 账号：只看不改。api 只允许 GET，带字段参数会被 glab 自动改成 POST
const glabReadOnly = new Set(["mr view", "mr diff", "mr list", "mr notes", "repo view", "ci view", "ci status"]);

interface ScriptRule {
	argv0: string[];
	allow: string[];
	deny: string[];
}

// skill 自带的查询脚本：只放行查询类子命令，login/auth 这类会改本地凭据的不放
function scriptRules(skillsDir: string): Record<string, ScriptRule> {
	return {
		archery: {
			argv0: [path.join(skillsDir, "archery/scripts/archery")],
			allow: ["instances", "databases", "tables", "desc", "query"],
			deny: ["login", "workflow", "submit", "execute", "approve", "cancel"],
		},
		superset: {
			argv0: [path.join(skillsDir, "superset/scripts/superset")],
			allow: ["query", "datasets", "dataset", "columns"],
			deny: ["auth"],
		},
		sls: { argv0: ["python3", path.join(skillsDir, "sls/scripts/sls_query.py")], allow: ["query", "check", "logstores"], deny: [] },
	};
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// 按 shell 规则切词：引号内的括号、空格当普通字符；未加引号的管道/重定向/分号等，以及任何 $ 和反引号都拒绝
export function tokenize(cmd: string): string[] | string {
	const out: string[] = [];
	let cur = "",
		quote = "",
		has = false;
	for (const ch of cmd) {
		if (quote) {
			if (ch === quote) quote = "";
			else if (quote === '"' && (ch === "$" || ch === "`" || ch === "\\")) return "双引号里不允许 $、反引号和转义";
			else cur += ch;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			has = true;
			continue;
		}
		if (/\s/.test(ch)) {
			if (cur || has) out.push(cur);
			cur = "";
			has = false;
			continue;
		}
		if (/[;&|<>`$\\(){}\n*?]/.test(ch)) return "bash 只允许单条命令，不支持管道、重定向、变量和通配符";
		cur += ch;
	}
	if (quote) return "引号没有闭合";
	if (cur || has) out.push(cur);
	return out;
}

const real = (list: string[]) =>
	list.flatMap((p) => {
		try {
			return p ? [realpathSync(p)] : [];
		} catch {
			return [];
		}
	});

export class Guard {
	readonly roots: string[];
	readonly enabled: Set<string>;
	readonly scripts: Record<string, ScriptRule>;
	readonly writeRoots: string[];
	readonly commands: string[][];

	constructor(policy: GuardPolicy) {
		// 根目录不存在时直接丢弃，不能让守卫构造失败
		this.writeRoots = real(policy.writeRoots ?? []);
		this.roots = [...real(policy.roots), ...this.writeRoots];
		this.commands = (policy.commands ?? []).map((c) => c.trim().split(/\s+/));
		this.enabled = new Set(policy.bash);
		this.scripts = scriptRules(policy.skillsDir);
	}

	resolveInside(cwd: string, p: string | undefined, roots = this.roots): string | undefined {
		const expanded = (p ?? ".").replace(/^~(?=$|\/)/, homedir());
		let full = path.resolve(cwd, expanded);
		try {
			full = realpathSync(full); // 解开软链，防止借链接读到根目录之外
		} catch {
			// 新建的文件还不存在：按已存在的上级目录解析，防止借软链目录写到外面
			let dir = path.dirname(full);
			const rest = [path.basename(full)];
			while (dir !== path.dirname(dir)) {
				try {
					full = path.join(realpathSync(dir), ...rest);
					break;
				} catch {
					rest.unshift(path.basename(dir));
					dir = path.dirname(dir);
				}
			}
		}
		const inside = roots.some((r) => full === r || full.startsWith(r + path.sep));
		return inside && !secretPattern.test(full) ? full : undefined;
	}

	/** 写操作只能落在 writeRoots（开发任务自己的 worktree）里 */
	writable(cwd: string, p: string | undefined) {
		return this.writeRoots.length ? this.resolveInside(cwd, p, this.writeRoots) : undefined;
	}

	// skill 文档里的脚本多写成相对路径（scripts/archery）或只写名字，而 agent 的 cwd 不在 skill 目录：
	// 统一改写成绝对路径，既能正确执行，也能按绝对路径做白名单匹配
	normalizeScriptPath(cmd: string): string {
		const trimmed = cmd.trim();
		for (const [name, rule] of Object.entries(this.scripts)) {
			if (!this.enabled.has(name)) continue;
			const abs = rule.argv0[rule.argv0.length - 1];
			const prefix = rule.argv0.length > 1 ? `${rule.argv0[0]} ` : "";
			const re = new RegExp(`^${escapeRe(prefix)}(?:\\./)?(?:scripts/)?${escapeRe(path.basename(abs))}(?=\\s|$)`);
			if (re.test(trimmed)) return trimmed.replace(re, `${prefix}${abs}`);
		}
		return trimmed;
	}

	checkGit(args: string[], cwd: string): string | undefined {
		// 仓库常在工作目录的子目录里：允许 git -C <允许目录内的路径>
		if (args[1] === "-C") {
			const target = this.resolveInside(cwd, args[2]);
			if (!target) return `git -C 的路径不在允许范围内: ${args[2]}`;
			args = [args[0], ...args.slice(3)];
			cwd = target;
		}
		const localWrite = this.enabled.has("git-local") && gitLocalWrite.has(args[1]);
		if (localWrite && !this.writable(cwd, ".")) return "git 写操作只能在开发任务自己的 worktree 里执行";
		if (!gitReadOnly.has(args[1]) && !localWrite) return `不允许的 git 子命令: ${args[1]}`;
		if (args.some((a) => gitBannedArg.test(a))) return "不允许的 git 参数";
		if (
			(args[1] === "branch" || args[1] === "tag") &&
			args.slice(2).some((a) => !a.startsWith("-") || /^-(d|D|m|M|f)$|^--(delete|move|force)/.test(a))
		) {
			return "git branch/tag 只允许列出";
		}
		return undefined;
	}

	checkGlab(args: string[]): string | undefined {
		if (args[1] === "api") {
			const method = args.findIndex((a) => a === "-X" || a === "--method");
			if (method >= 0 && args[method + 1]?.toUpperCase() !== "GET") return "glab api 只允许 GET";
			if (args.some((a) => /^(-f|-F|--field|--raw-field|--input|-X.+|--method=(?!GET))/i.test(a))) return "glab api 不允许带请求体";
			return undefined;
		}
		return glabReadOnly.has(`${args[1]} ${args[2]}`) ? undefined : `不允许的 glab 命令: ${args[1]} ${args[2]}`;
	}

	checkBash(cmd: string, cwd: string): string | undefined {
		const tokens = tokenize(cmd.trim());
		if (typeof tokens === "string") return tokens;
		let args = tokens.map((t) => t.replace(/^~(?=$|\/)/, homedir()));
		if (!args.length) return "空命令";
		if (args[0] === "git" && (this.enabled.has("git") || this.enabled.has("git-local"))) return this.checkGit(args, cwd);
		// go -C <目录> test 这类写法：目录在 worktree 内就当作在那里执行
		if (args[1] === "-C" && this.commands.some((c) => c[0] === args[0])) {
			const dir = this.writable(cwd, args[2]);
			if (!dir) return `${args[0]} -C 的目录不在 worktree 内: ${args[2]}`;
			args = [args[0], ...args.slice(3)];
			cwd = dir;
		}
		const command = this.commands.find((c) => c.every((t, i) => args[i] === t));
		if (command) {
			// 构建/测试会执行仓库代码：只在开发任务的 worktree 里跑，路径参数也不能指到外面
			if (!this.writable(cwd, ".")) return `${command.join(" ")} 只能在开发任务的 worktree 里执行`;
			const bad = args
				.slice(command.length)
				.find((a) => (a.startsWith("/") || a.startsWith("~") || a.includes("..")) && !this.writable(cwd, a.replace(/^-[\w-]+=/, "")));
			return bad ? `参数里的路径不在 worktree 内: ${bad}` : undefined;
		}
		if (args[0] === "glab" && this.enabled.has("glab")) return this.checkGlab(args);
		if (args[0] === "meegle" && this.enabled.has("meegle")) {
			// meegle 用的是 Yi 的账号，写操作（评论、建单、流转）只由 cabinet 在 Yi 确认后执行
			const sub = `${args[1]} ${args[2]}`;
			return meegleReadOnly.has(sub) && !args.includes("--params") ? undefined : `不允许的 meegle 命令: ${sub}`;
		}
		for (const [name, rule] of Object.entries(this.scripts)) {
			if (!this.enabled.has(name)) continue;
			const head = args.slice(0, rule.argv0.length).map((a) => (a.includes("/") ? path.resolve(cwd, a) : a));
			if (head.join("\0") !== rule.argv0.join("\0")) continue;
			const rest = args.slice(rule.argv0.length);
			if (rest.some((a) => rule.deny.includes(a))) return `${name} 不允许这个子命令`;
			return rest.some((a) => rule.allow.includes(a)) ? undefined : `${name} 只允许查询类子命令: ${rule.allow.join("/")}`;
		}
		const allowed = [...this.enabled, ...this.commands.map((c) => c.join(" "))];
		return `这个 agent 不允许执行: ${args[0]}（可用：${allowed.join(", ")}）`;
	}

	/** 返回拦截原因；放行返回 undefined。bash 命令会被就地改写成绝对路径 */
	check(toolName: string, input: Record<string, unknown>, cwd: string): string | undefined {
		switch (toolName) {
			case "read":
			case "grep":
			case "find":
			case "ls":
				return this.resolveInside(cwd, input.path as string | undefined) ? undefined : `路径不在允许范围内: ${input.path ?? "."}`;
			case "edit":
			case "write":
				return this.writable(cwd, input.path as string | undefined) ? undefined : `只能修改开发任务 worktree 里的文件: ${input.path}`;
			case "memory":
				// 只读，只查 cabinet 自己的记忆库
				return undefined;
			case "bash":
				input.command = this.normalizeScriptPath(String(input.command ?? ""));
				return this.checkBash(String(input.command), cwd);
			default:
				return `工具 ${toolName} 未在白名单中`;
		}
	}
}
