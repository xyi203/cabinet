// agent 的工具守卫：读文件只能在允许目录里；命令按 config/skill-rules.json 判成 放行 / 要审批 / 拒绝。
// 由 durable 的 beforeTool 钩子调用（server/agent/driver.ts）；钩子抛错时 durable 也会拦截（fail-closed）。
// 每个会话用自己的策略创建一份守卫，同一进程里并行的 agent 互不影响。
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

/** MCP 工具名：只能是 [A-Za-z0-9_-]，最长 64（部分模型接口的上限）。注册（mcp.ts）和放行（这里）用同一个规则 */
export const mcpToolName = (server: string, tool: string) => `mcp__${server}__${tool}`.replace(/[^\w-]/g, "_").slice(0, 64);

/** 只读的 MCP 工具（声明了 readOnlyHint，或 skill-rules.json 的 _mcpRead 里列了）：mcp.ts 注册时填 */
export const mcpReadOnly = new Set<string>();

/** 放行；要 Yi 审批（审批上线前当拒绝处理）；拒绝 */
export type Verdict = { kind: "allow" } | { kind: "approve"; reason: string } | { kind: "deny"; reason: string };
const ALLOW: Verdict = { kind: "allow" };
const deny = (reason: string): Verdict => ({ kind: "deny", reason });
const approve = (reason: string): Verdict => ({ kind: "approve", reason });

export const RULES_FILE = path.resolve(import.meta.dirname, "../../config/skill-rules.json");

export interface GuardPolicy {
	/** 允许读的目录（不存在的会被丢弃） */
	roots: string[];
	/** 放行的命令族：skill-rules.json 里的名字，加 git / git-local；"*"（或数组里的 "*"）= 全部规则 + git */
	bash: string[] | "*";
	skillsDir: string;
	/** 这个会话能不能用 lookup（链式召回）：群里问答的会话不能 */
	lookup?: boolean;
	/** 允许 edit / write 的目录：只有开发任务有，是它自己的 worktree */
	writeRoots?: string[];
	/** 允许执行的构建/测试命令前缀，例如 "go test"；只能在 writeRoots 里执行 */
	commands?: string[];
	/** 能用的 MCP server：只放行 mcp__<server>__ 开头的工具 */
	mcp?: string[];
	/** 命令规则，不给就读 RULES_FILE（测试里直接传） */
	rules?: Record<string, RuleSpec>;
}

/** skill-rules.json 里的一条：argv0 是命令本身，read / write / deny 是子命令（多个词的按连续出现匹配） */
export interface RuleSpec {
	argv0: string[];
	read?: string[];
	write?: string[];
	deny?: string[];
}

// bash / read 输出太长时 durable 把完整输出存到系统临时目录（<tmp>/tmp-xxx/pi-output-<id>.log），提示里给的就是这个路径：
// 只放行这一种文件，临时目录里的其他文件照样不能读
const SPILL_RE = (() => {
	let tmp = tmpdir();
	try {
		tmp = realpathSync(tmp);
	} catch {
		// 用原路径
	}
	return new RegExp(`^${tmp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/tmp-[\\w-]+/pi-output-[\\w-]+\\.log$`);
})();

// 即使在允许的目录里，这些也不读：凭证、密钥、本地配置
const secretPattern =
	/(^|\/)(\.env[^/]*|\.ssh|\.aws|\.kube|\.netrc|\.npmrc|\.git-credentials|id_[a-z0-9]+|[^/]*\.(pem|key|p12)|credentials[^/]*)(\/|$)/i;

// 只放行这些 git 子命令；--output/--ext-diff 会写文件或执行外部程序，--no-index 能读仓库外任意文件
const gitReadOnly = new Set(["log", "show", "diff", "blame", "status", "branch", "tag", "rev-parse", "ls-files", "grep"]);
const gitBannedArg = /^(--output|--ext-diff|--textconv|--no-index|-c$|--exec|--upload-pack|--config|--open-files-in-pager|-O)/;

// 开发任务在自己的 worktree 里可以做的本地 git 写操作；push / fetch / 切分支 / reset 一律不放
const gitLocalWrite = new Set(["add", "commit", "restore", "rm", "mv"]);

// lark-cli 用的是 Yi 的飞书账号：--as 能换身份，--output 会落盘
const larkBannedArg = /^(--output|-o$|--as$|--as=)/;

interface ScriptRule {
	argv0: string[];
	read: string[][];
	write: string[][];
	deny: string[][];
}

const words = (list?: string[]) => (list ?? []).map((w) => w.split(/\s+/));

export function loadRules(skillsDir: string, specs?: Record<string, RuleSpec>): Record<string, ScriptRule> {
	const raw: Record<string, RuleSpec> = specs ?? (existsSync(RULES_FILE) ? JSON.parse(readFileSync(RULES_FILE, "utf8")) : {});
	return Object.fromEntries(
		Object.entries(raw)
			.filter(([k]) => !k.startsWith("_"))
			.map(([name, r]) => [
				name,
				{ argv0: r.argv0.map((a) => a.replace("{skills}", skillsDir)), read: words(r.read), write: words(r.write), deny: words(r.deny) },
			]),
	);
}

/** 子命令词组在参数里连续出现 */
const hits = (rest: string[], list: string[][]) => list.find((w) => rest.some((_, i) => w.every((x, k) => rest[i + k] === x)));

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
	readonly lookup: boolean;
	/** 放行的 MCP 工具名前缀 */
	readonly mcp: string[];

	constructor(policy: GuardPolicy) {
		// 根目录不存在时直接丢弃，不能让守卫构造失败
		this.writeRoots = real(policy.writeRoots ?? []);
		this.roots = [...real(policy.roots), ...this.writeRoots];
		this.commands = (policy.commands ?? []).map((c) => c.trim().split(/\s+/));
		this.scripts = loadRules(policy.skillsDir, policy.rules);
		const all = ["git", ...Object.keys(this.scripts)];
		this.enabled = new Set(policy.bash === "*" ? all : policy.bash.flatMap((b) => (b === "*" ? all : [b])));
		this.lookup = Boolean(policy.lookup);
		this.mcp = (policy.mcp ?? []).map((s) => mcpToolName(s, ""));
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
		if (SPILL_RE.test(full)) return full;
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
			if (!path.isAbsolute(abs)) continue;
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

	/** 命令规则：deny > write > read，没列出的拒绝。glab api 只有 GET 算读，meegle 带 --params、lark-cli 换身份或落盘一律拒绝 */
	ruleVerdict(name: string, rule: ScriptRule, rest: string[]): Verdict {
		if (hits(rest, rule.deny)) return deny(`${name} 不允许这个子命令`);
		if (name === "lark-cli" && rest.some((a) => larkBannedArg.test(a))) return deny("lark-cli 不允许这个参数");
		if (name === "meegle" && rest.includes("--params")) return deny("meegle 不允许 --params");
		if (name === "glab" && rest[0] === "api") {
			const m = rest.findIndex((a) => a === "-X" || a === "--method");
			const write =
				(m >= 0 && rest[m + 1]?.toUpperCase() !== "GET") ||
				rest.some((a) => /^(-f|-F|--field|--raw-field|--input|-X.+|--method=(?!GET))/i.test(a));
			return write ? approve("glab api 的写请求") : ALLOW;
		}
		const w = hits(rest, rule.write);
		if (w) return approve(`${name} ${w.join(" ")} 是写操作`);
		if (hits(rest, rule.read)) return ALLOW;
		const list = (l: string[][]) => l.map((x) => x.join(" ")).join("/");
		// 把要审批的写子命令也列出来：只列只读的，agent 会以为写操作也一律被拒、不去走审批
		return deny(
			`${name} 不允许这个子命令。直接放行：${list(rule.read)}${rule.write.length ? `；要 Yi 审批的写操作：${list(rule.write)}` : ""}`,
		);
	}

	bashVerdict(cmd: string, cwd: string): Verdict {
		const tokens = tokenize(cmd.trim());
		if (typeof tokens === "string") return deny(tokens);
		let args = tokens.map((t) => t.replace(/^~(?=$|\/)/, homedir()));
		if (!args.length) return deny("空命令");
		const reason = (r: string | undefined): Verdict => (r ? deny(r) : ALLOW);
		if (args[0] === "git" && (this.enabled.has("git") || this.enabled.has("git-local"))) return reason(this.checkGit(args, cwd));
		// go -C <目录> test 这类写法：目录在 worktree 内就当作在那里执行
		if (args[1] === "-C" && this.commands.some((c) => c[0] === args[0])) {
			const dir = this.writable(cwd, args[2]);
			if (!dir) return deny(`${args[0]} -C 的目录不在 worktree 内: ${args[2]}`);
			args = [args[0], ...args.slice(3)];
			cwd = dir;
		}
		const command = this.commands.find((c) => c.every((t, i) => args[i] === t));
		if (command) {
			// 构建/测试会执行仓库代码：只在开发任务的 worktree 里跑，路径参数也不能指到外面
			if (!this.writable(cwd, ".")) return deny(`${command.join(" ")} 只能在开发任务的 worktree 里执行`);
			const bad = args
				.slice(command.length)
				.find((a) => (a.startsWith("/") || a.startsWith("~") || a.includes("..")) && !this.writable(cwd, a.replace(/^-[\w-]+=/, "")));
			return bad ? deny(`参数里的路径不在 worktree 内: ${bad}`) : ALLOW;
		}
		for (const [name, rule] of Object.entries(this.scripts)) {
			if (!this.enabled.has(name)) continue;
			const head = args.slice(0, rule.argv0.length).map((a) => (a.includes("/") ? path.resolve(cwd, a) : a));
			if (head.join("\0") !== rule.argv0.join("\0")) continue;
			return this.ruleVerdict(name, rule, args.slice(rule.argv0.length));
		}
		const allowed = [...this.enabled, ...this.commands.map((c) => c.join(" "))];
		return deny(`这个 agent 不允许执行: ${args[0]}（可用：${allowed.join(", ")}）`);
	}

	checkBash(cmd: string, cwd: string): string | undefined {
		const v = this.bashVerdict(cmd, cwd);
		return v.kind === "allow" ? undefined : v.reason;
	}

	/** 一次工具调用的判定。bash 命令会被就地改写成绝对路径 */
	verdict(toolName: string, input: Record<string, unknown>, cwd: string): Verdict {
		switch (toolName) {
			case "read":
			case "grep":
			case "find":
			case "ls":
				return this.resolveInside(cwd, input.path as string | undefined) ? ALLOW : deny(`路径不在允许范围内: ${input.path ?? "."}`);
			case "edit":
			case "write":
				return this.writable(cwd, input.path as string | undefined) ? ALLOW : deny(`只能修改开发任务 worktree 里的文件: ${input.path}`);
			case "memory":
				// 只读，只查 cabinet 自己的记忆库
				return ALLOW;
			case "lookup":
				// 只读，但能看到私聊和草稿：只给结果先经 Yi 过目的会话
				return this.lookup ? ALLOW : deny("这个会话不能用 lookup");
			case "bash":
				input.command = this.normalizeScriptPath(String(input.command ?? ""));
				return this.bashVerdict(String(input.command), cwd);
			default:
				// codemode 只是在沙箱里跑脚本，脚本里调的每个工具会再过一遍这里
				if (toolName === "codemode" && this.mcp.length) return ALLOW;
				if (this.mcp.some((prefix) => toolName.startsWith(prefix)))
					return mcpReadOnly.has(toolName) ? ALLOW : approve(`${toolName} 没有声明只读，按写操作处理`);
				return deny(`工具 ${toolName} 未在白名单中`);
		}
	}

	/** 返回拦截原因；放行返回 undefined。要审批的写操作在审批上线前也拦截，原因里说清楚 */
	check(toolName: string, input: Record<string, unknown>, cwd: string): string | undefined {
		const v = this.verdict(toolName, input, cwd);
		if (v.kind === "allow") return undefined;
		if (v.kind === "approve")
			return `${v.reason}，需要 Yi 审批；审批功能还没上线，这次不执行。把要执行的命令和理由写进给 Yi 的结论或备注里，由 Yi 自己执行`;
		return v.reason;
	}
}
