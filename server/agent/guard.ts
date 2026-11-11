// agent 的工具守卫：读文件只能在允许目录里；带 Yi 登录态的命令（git、skill-rules.json 登记的命令族、skill 脚本）判成 放行 / 要审批 / 拒绝，
// 其余命令直接在本机执行（管道、&&、重定向都行）。
// 由 durable 的 beforeTool 钩子调用（server/agent/driver.ts）；钩子抛错时 durable 也会拦截（fail-closed）。
// 每个会话用自己的策略创建一份守卫，同一进程里并行的 agent 互不影响。
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

/** MCP 工具名：只能是 [A-Za-z0-9_-]，最长 64（部分模型接口的上限）。注册（mcp.ts）和放行（这里）用同一个规则 */
export const mcpToolName = (server: string, tool: string) => `mcp__${server}__${tool}`.replace(/[^\w-]/g, "_").slice(0, 64);

/** 只读的 MCP 工具（声明了 readOnlyHint，或 skill-rules.json 的 _mcpRead 里列了）：mcp.ts 注册时填 */
export const mcpReadOnly = new Set<string>();
/** 两段式的 MCP 写工具（skill-rules.json 的 _mcpPreview）：confirmed 不是 true 时只出预览、不落地，放行；真正提交才审批 */
export const mcpPreview = new Set<string>();

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
const gitReadOnly = new Set([
	"log",
	"show",
	"diff",
	"blame",
	"status",
	"branch",
	"tag",
	"rev-parse",
	"ls-files",
	"ls-tree",
	"cat-file",
	"grep",
]);
// --filters 让 cat-file 跑仓库配置的 smudge 过滤器（外部程序）
// --template 会把模板里的 hooks 带进新仓库，--remote 让 archive 去远端执行，--separate-git-dir 能把 .git 放到任意位置
const gitBannedArg =
	/^(--output|--ext-diff|--textconv|--filters|--no-index|-c$|--exec|--upload-pack|--config|--open-files-in-pager|-O|--template|--remote(=|$)|--separate-git-dir)/;
// MR 审查要拉 MR 的 head（review skill）：不带「:目标」，只落到 FETCH_HEAD，不动本地分支
const mrRef = /^refs\/merge-requests\/\d+\/head$/;

// 开发任务在自己的 worktree 里可以做的本地 git 写操作；push / fetch / 切分支 / reset 一律不放
const gitLocalWrite = new Set(["add", "commit", "restore", "rm", "mv"]);

/**
 * agent 取代码跑单测、复现用的目录：clone、worktree 只能放这里，这里的仓库可以随便切版本，不碰 Yi 自己的 checkout。
 * 用固定路径而不是 $TMPDIR：命令里带变量的 git 会被当成藏了受管命令拦下
 */
export const WORK_TMP = path.join(realpathSync("/tmp"), "cabinet-work");
// 只在临时仓库里放开的 git 子命令：切版本、清理、拉代码都只影响那份副本；push 仍然不行
const gitWorkWrite = new Set(["checkout", "switch", "reset", "clean", "fetch", "apply", "stash"]);

// lark-cli 用的是 Yi 的飞书账号：--output 会落盘，拒绝；--as 只许 user。
// 默认身份是 auto（可能落到机器人身份），飞书 skill 也要求写 --as user，所以 user 放行，换成 bot 等别的身份拒绝
export function larkBadArg(rest: string[]): string | undefined {
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i];
		if (/^(--output|-o$)/.test(a)) return "lark-cli 不允许 --output（会写本地文件）";
		if ((a === "--as" && rest[i + 1] !== "user") || (a.startsWith("--as=") && a !== "--as=user"))
			return "lark-cli 只允许 --as user（用 Yi 的身份），不能换成别的身份";
	}
	return undefined;
}

interface ScriptRule {
	argv0: string[];
	read: string[][];
	write: string[][];
	deny: string[][];
}

/**
 * 只是查用法：带 --help / -h，其余都是子命令词（不带取值、路径、其他选项）；或者只有 --version。
 * agent 每轮新会话都要先查一遍 CLI 怎么用，这类调用之前每次都要 Yi 审批（一天 5 次 --help、1 次 --version）
 */
export function helpOnly(rest: string[]): boolean {
	if (rest.length === 1 && (rest[0] === "--version" || rest[0] === "-V")) return true;
	if (!rest.some((a) => a === "--help" || a === "-h")) return false;
	return rest.every((a) => a === "--help" || a === "-h" || /^\+?[a-z][\w-]*$/i.test(a));
}

const words = (list?: string[]) => (list ?? []).map((w) => w.split(/\s+/));

// 跑 skill 脚本时前面常带的解释器：skill 文档里经常写 /usr/bin/python3 scripts/xxx
const INTERPRETERS = new Set(["python3", "/usr/bin/python3", "python", "bash", "sh", "node"]);

/** 审批时「批准，以后不再问」要记进 skill-rules.json 的一条：rule 已有就往它的 read 里加，没有就新建 */
export interface Learn {
	rule: string;
	/** 新建规则时的 argv0（skill 目录写成 {skills}） */
	argv0: string[];
	/** 要放行的子命令（一个或两个词） */
	sub: string;
	isNew: boolean;
}

/**
 * 子命令：参数里的第一个词（以 - 开头就当没有子命令，免得把某个参数的值当成子命令记进规则）；
 * lark-cli 那种「docs +fetch」、或者规则里已有两个词的，带上第二个
 */
function subcommand(rest: string[], rule?: ScriptRule): string {
	const [first, second] = rest;
	if (!first || first.startsWith("-")) return "";
	const two =
		second &&
		!second.startsWith("-") &&
		(second.startsWith("+") || [...(rule?.read ?? []), ...(rule?.write ?? [])].some((w) => w.length > 1 && w[0] === first));
	return two ? `${first} ${second}` : first;
}

/** 把一条子命令记成只读：写回 skill-rules.json（格式统一成 tab 缩进的 JSON），下一次运行起生效 */
export function rememberRead(l: Learn, file = RULES_FILE) {
	const raw = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
	const r = raw[l.rule] ?? { argv0: l.argv0 };
	const read: string[] = r.read ?? [];
	if (!read.includes(l.sub)) read.push(l.sub);
	raw[l.rule] = { ...r, read };
	writeFileSync(file, `${JSON.stringify(raw, null, "\t")}\n`);
}

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

const joinWords = (l: string[][]) => l.map((x) => x.join(" ")).join("/");

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
		if (/[;&|<>`$\\(){}\n*?]/.test(ch))
			return "bash 只允许单条命令，不支持管道、重定向、变量和通配符：去掉 `| head`、`2>&1`、`&&`、`cd`（长输出会自动存成文件），看文件、搜代码改用 read / grep / find / ls 工具";
		cur += ch;
	}
	if (quote) return "引号没有闭合";
	if (cur || has) out.push(cur);
	return out;
}

/**
 * 复合命令按 |、||、&&、;、& 和换行切成几段（引号里的不算），每段去掉重定向（> 文件、2>&1、< 文件）后单独判。
 * 只用于判定，执行的还是原命令
 */
export function splitCommands(cmd: string): string[] {
	const out: string[] = [];
	let cur = "",
		quote = "";
	for (let i = 0; i < cmd.length; i++) {
		const ch = cmd[i];
		if (quote) {
			if (ch === quote) quote = "";
			cur += ch;
			continue;
		}
		if (ch === "'" || ch === '"') quote = ch;
		// 2>&1、&> 文件 是重定向，不是后台执行
		const redirect = ch === "&" && (cmd[i - 1] === ">" || cmd[i + 1] === ">");
		if (!redirect && (ch === "|" || ch === "&" || ch === ";" || ch === "\n")) {
			out.push(cur);
			cur = "";
			continue;
		}
		cur += ch;
	}
	out.push(cur);
	return out.map((c) => c.replace(/(\d*|&)>>?\s*(&\d+|[^\s'"]+)|<\s*[^\s'"]+/g, " ").trim()).filter(Boolean);
}

// 能把别的命令包起来执行的：bash -c "glab …"、xargs glab、python -c "os.system('glab …')" 这类要看参数里带没带受管命令
const WRAPPERS = new Set([
	"bash",
	"sh",
	"zsh",
	"fish",
	"env",
	"xargs",
	"eval",
	"exec",
	"command",
	"nohup",
	"timeout",
	"time",
	"watch",
	"nice",
	"sudo",
	"python",
	"python3",
	"node",
	"php",
	"perl",
	"ruby",
]);

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
	readonly skillsDir: string;
	/** bash 配了 "*"：没登记的 skill 脚本可以走审批（否则直接拒绝） */
	readonly anyScript: boolean;

	constructor(policy: GuardPolicy) {
		// 根目录不存在时直接丢弃，不能让守卫构造失败
		this.writeRoots = real(policy.writeRoots ?? []);
		try {
			mkdirSync(WORK_TMP, { recursive: true });
		} catch {
			// 建不了就不给这个目录，real() 会把它丢掉
		}
		this.roots = [...real(policy.roots), ...this.writeRoots, ...real([WORK_TMP])];
		this.commands = (policy.commands ?? []).map((c) => c.trim().split(/\s+/));
		this.scripts = loadRules(policy.skillsDir, policy.rules);
		this.skillsDir = real([policy.skillsDir])[0] ?? policy.skillsDir;
		this.anyScript = policy.bash === "*" || policy.bash.includes("*");
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
		// 没给这个 agent 的命令族也改写：改成绝对路径才认得出来，按「这个 agent 不能用」拒绝，而不是当成普通命令放行
		for (const rule of Object.values(this.scripts)) {
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
		if (args.some((a) => gitBannedArg.test(a))) return "不允许的 git 参数";
		const inWork = (p: string | undefined) => (p ? this.resolveInside(cwd, p, [WORK_TMP]) : undefined);
		const positional = args.slice(2).filter((a) => !a.startsWith("-"));
		// 取代码跑单测：clone 和 worktree 只能放到 WORK_TMP；archive 只能输出到标准输出（--output 已禁）
		if (args[1] === "clone")
			return positional.length >= 2 && inWork(positional.at(-1)) ? undefined : `git clone 要写明目标目录，而且只能放在 ${WORK_TMP} 下`;
		if (args[1] === "worktree") {
			const [op, target] = positional;
			if (op === "list" || op === "prune") return undefined;
			if (op === "add" && args.some((a) => /^(-b|-B|--orphan)$/.test(a))) return "git worktree add 不能建分支，用 --detach";
			if ((op === "add" || op === "remove") && inWork(target)) return undefined;
			return `git worktree 只能 list / prune，add / remove 的目录只能在 ${WORK_TMP} 下`;
		}
		if (args[1] === "archive") return undefined;
		// WORK_TMP 里的仓库是 agent 自己的副本：切版本、拉代码随便，push 照样不行
		if (gitWorkWrite.has(args[1]) && inWork(cwd)) return undefined;
		// 只读 agent 核对发布区间要先拉 tag、审 MR 要拉 MR 的 head：fetch 只许 --tags / --prune / -q、origin 和 MR 的 ref
		if (args[1] === "fetch" && !this.writeRoots.length)
			return args.slice(2).every((a) => ["--tags", "--prune", "-q", "--quiet", "origin"].includes(a) || mrRef.test(a))
				? undefined
				: "git fetch 只允许 --tags / --prune、origin 和 refs/merge-requests/<iid>/head";
		// 查看远端地址：remote、remote -v、remote get-url <名字>
		if (args[1] === "remote")
			return args.length === 2 || (args.length === 3 && args[2] === "-v") || (args.length === 4 && args[2] === "get-url")
				? undefined
				: "git remote 只允许查看（-v、get-url）";
		const localWrite = this.enabled.has("git-local") && gitLocalWrite.has(args[1]);
		if (localWrite && !this.writable(cwd, ".")) return "git 写操作只能在开发任务自己的 worktree 里执行";
		if (!gitReadOnly.has(args[1]) && !localWrite) return `不允许的 git 子命令: ${args[1]}`;
		if (
			(args[1] === "branch" || args[1] === "tag") &&
			args.slice(2).some((a) => !a.startsWith("-") || /^-(d|D|m|M|f)$|^--(delete|move|force)/.test(a))
		) {
			return "git branch/tag 只允许列出";
		}
		return undefined;
	}

	/**
	 * 没登记命令规则的 skill 脚本（可以带解释器）：脚本在 agent 能读的 skill 目录里才算。
	 * 返回 skill 名、脚本路径和规则里要写的 argv0
	 */
	skillScript(args: string[], cwd: string): { skill: string; file: string; argv0: string[]; rest: string[] } | undefined {
		const interp = INTERPRETERS.has(args[0]) && args[1] ? args[0] : undefined;
		const raw = interp ? args[1] : args[0];
		if (!raw?.includes("/")) return undefined;
		// 只要在 skill 目录里就算 skill 脚本（不管这个 agent 能不能读它），这样没开放的脚本也会被认出来
		const file = this.resolveInside(cwd, raw, [this.skillsDir]);
		if (!file || !file.startsWith(this.skillsDir + path.sep)) return undefined;
		const [skill, dir] = path.relative(this.skillsDir, file).split(path.sep);
		if (dir !== "scripts") return undefined;
		const spec = `{skills}/${path.relative(this.skillsDir, file)}`;
		return { skill, file, argv0: interp ? [interp, spec] : [spec], rest: args.slice(interp ? 2 : 1) };
	}

	/** 这条命令能不能在审批时顺手记成只读：没登记的子命令、没登记的 skill 脚本可以；规则里明确是写操作或拒绝的不行 */
	learnable(cmd: string, cwd: string): Learn | undefined {
		const tokens = tokenize(this.normalizeScriptPath(cmd));
		if (typeof tokens === "string" || !tokens.length) return undefined;
		const args = tokens.map((t) => t.replace(/^~(?=$|\/)/, homedir()));
		for (const [name, rule] of Object.entries(this.scripts)) {
			const head = args.slice(0, rule.argv0.length).map((a) => (a.includes("/") ? path.resolve(cwd, a) : a));
			if (head.join("\0") !== rule.argv0.join("\0")) continue;
			const rest = args.slice(rule.argv0.length);
			if (hits(rest, rule.deny) || hits(rest, rule.write) || hits(rest, rule.read)) return undefined;
			if (name === "glab" || name === "meegle" || name === "lark-cli") {
				// 这几个有额外的参数检查（glab api、--params、--as），不自动学
				if (name !== "lark-cli" || larkBadArg(rest)) return undefined;
			}
			const sub = subcommand(rest, rule);
			return sub ? { rule: name, argv0: [], sub, isNew: false } : undefined;
		}
		const s = this.skillScript(args, cwd);
		if (!s) return undefined;
		const sub = subcommand(s.rest);
		if (!sub) return undefined;
		const base = path.basename(s.file).replace(/\.\w+$/, "");
		const taken = this.scripts[base] !== undefined;
		return { rule: taken ? `${s.skill}-${base}` : base, argv0: s.argv0, sub, isNew: true };
	}

	/** 命令规则：deny > write > read；没列出的子命令走审批（可以记成只读）。glab api 只有 GET 算读，meegle 带 --params、lark-cli 换身份或落盘一律拒绝 */
	ruleVerdict(name: string, rule: ScriptRule, rest: string[]): Verdict {
		if (hits(rest, rule.deny)) return deny(`${name} 不允许这个子命令`);
		const larkBad = name === "lark-cli" ? larkBadArg(rest) : undefined;
		if (larkBad) return deny(larkBad);
		if (name === "meegle" && rest.includes("--params")) return deny("meegle 不允许 --params");
		if (helpOnly(rest)) return ALLOW;
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
		// 没登记的子命令不直接拒绝：交给 Yi 审批，确认是只读的可以点「批准，以后不再问」记进规则
		const sub = subcommand(rest, rule);
		return approve(`${name}${sub ? ` ${sub}` : ""} 还没登记是读还是写（直接放行的有：${joinWords(rule.read) || "无"}）`);
	}

	/**
	 * 一条命令的判定。带 Yi 登录态、或者会改仓库的命令（git、开发任务的构建命令、登记的命令族、skill 脚本）照规则判；其余直接放行。
	 * 复合命令逐段判：任何一段要审批或被拒，整条拒绝（要审批的只能单独一条，审批卡片上才看得清执行的是什么）
	 */
	bashVerdict(cmd: string, cwd: string): Verdict {
		const tokens = tokenize(cmd.trim());
		if (typeof tokens !== "string") return tokens.length ? this.single(tokens, cmd, cwd) : deny("空命令");
		for (const seg of splitCommands(cmd)) {
			const t = tokenize(seg);
			// 带变量、$(…)、通配符的段：只看它有没有把受管命令藏在里面
			const v = typeof t === "string" ? (this.hidesGoverned(seg) ? deny(this.hiddenReason(seg)) : ALLOW) : this.single(t, seg, cwd);
			if (v.kind === "deny") return v;
			if (v.kind === "approve") return deny(`${v.reason}：要审批的命令只能单独写一条，不能和别的命令连在一起`);
		}
		return ALLOW;
	}

	/** 单条命令：受管的照规则判；包装命令（bash -c、xargs、python -c……）里藏了受管命令的拒绝；其余放行 */
	single(tokens: string[], text: string, cwd: string): Verdict {
		const v = this.governed(tokens, cwd);
		if (v) return v;
		if (WRAPPERS.has(path.basename(tokens[0])) && this.hidesGoverned(text.slice(text.indexOf(tokens[0]) + tokens[0].length)))
			return deny(this.hiddenReason(text));
		return ALLOW;
	}

	/** 受管命令的名字：git、登记命令族的命令名（glab、lark-cli、archery……）、skill 脚本目录 */
	private governedNames(): string[] {
		const names = Object.values(this.scripts).map((r) => path.basename(r.argv0[r.argv0.length - 1]));
		return ["git", ...new Set(names)];
	}

	hidesGoverned(text: string): boolean {
		if (text.includes(this.skillsDir)) return true;
		return this.governedNames().some((n) => new RegExp(`(^|[\\s'"\`(/|;&$])${escapeRe(n)}(?=$|[\\s'"\`);|&])`).test(text));
	}

	private hiddenReason(text: string) {
		const n = this.governedNames().find((x) => new RegExp(`(^|[^\\w-])${escapeRe(x)}([^\\w-]|$)`).test(text)) ?? "skill 脚本";
		return `${n} 带着 Yi 的登录态，要单独、直接地写（不放进 bash -c、xargs、$(…)、变量里），守卫才能判断是读还是写`;
	}

	/** 受规则管的命令给出判定；不归规则管的返回 undefined（直接放行） */
	governed(tokens: string[], cwd: string): Verdict | undefined {
		let args = tokens.map((t) => t.replace(/^~(?=$|\/)/, homedir()));
		const reason = (r: string | undefined): Verdict => (r ? deny(r) : ALLOW);
		if (args[0] === "git")
			return this.enabled.has("git") || this.enabled.has("git-local") ? reason(this.checkGit(args, cwd)) : deny("这个 agent 不能用 git");
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
			const head = args.slice(0, rule.argv0.length).map((a) => (a.includes("/") ? path.resolve(cwd, a) : a));
			if (head.join("\0") !== rule.argv0.join("\0")) continue;
			if (!this.enabled.has(name)) return deny(`这个 agent 不能用 ${name}`);
			return this.ruleVerdict(name, rule, args.slice(rule.argv0.length));
		}
		// skill 目录里还没登记规则的脚本：多半要用 Yi 的登录态，交给 Yi 审批（可以顺手记成只读）
		const script = this.skillScript(args, cwd);
		if (script) {
			if (!this.anyScript) return deny(`这个 agent 不能跑 skill 脚本：${path.basename(script.file)}`);
			if (helpOnly(script.rest)) return ALLOW;
			const sub = subcommand(script.rest);
			return approve(`${script.skill} 的脚本 ${path.basename(script.file)}${sub ? ` ${sub}` : ""} 还没登记命令规则`);
		}
		return undefined;
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
			case "show_ui":
				// 只把报告暂存给看板显示，不碰外部
				return ALLOW;
			case "schedule":
				// 新建定时任务：到点会以 Yi 的名义跑 agent，算写操作
				return approve("新建定时任务");
			case "lookup":
				// 只读，但能看到私聊和草稿：只给结果先经 Yi 过目的会话
				return this.lookup ? ALLOW : deny("这个会话不能用 lookup");
			case "bash":
				input.command = this.normalizeScriptPath(String(input.command ?? ""));
				return this.bashVerdict(String(input.command), cwd);
			default:
				// codemode 只是在沙箱里跑脚本，脚本里调的每个工具会再过一遍这里
				if (toolName === "codemode" && this.mcp.length) return ALLOW;
				if (this.mcp.some((prefix) => toolName.startsWith(prefix))) {
					if (mcpReadOnly.has(toolName) || (mcpPreview.has(toolName) && input.confirmed !== true)) return ALLOW;
					return approve(`${toolName} 没有声明只读，按写操作处理`);
				}
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
