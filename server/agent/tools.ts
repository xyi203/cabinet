// durable 自带 read / bash；这里补上只读的 grep / find / ls，参数里的路径由守卫按允许目录检查
import { defineTool } from "@earendil-works/pi-durable";
import { arr, bool, num, obj, opt, str, unknown } from "@earendil-works/pi-schema";
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { SHOW_UI_HELP } from "../a2ui/catalog.ts";
import { buildSurface, setPendingUi } from "../a2ui/surface.ts";
import { LOOKUP_HELP, lookup } from "../lookup.ts";
import { reflect } from "../memory/hindsight.ts";
import { recall, render } from "../memory/recall.ts";

const MAX_OUTPUT = 50_000;
const cwdOf = (api: { env?: { cwd?: string } | undefined }) => (api.env as any)?.cwd ?? process.cwd();

function run(cmd: string, args: string[], cwd: string): Promise<string> {
	return new Promise((resolve, reject) =>
		execFile(cmd, args, { cwd, maxBuffer: 10 * 1024 * 1024, timeout: 60_000 }, (err, stdout, stderr) => {
			// rg 没有匹配时退出码 1，不算错误
			if (err && (err as any).code !== 1) reject(new Error(stderr.trim() || err.message));
			else resolve(stdout);
		}),
	);
}

const text = (s: string) => ({
	output: [{ type: "text" as const, text: s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n…（已截断）` : s || "（无结果）" }],
});

export const grepTool = defineTool({
	name: "grep",
	description: "在文件内容里搜索正则（ripgrep），返回 文件:行号:内容。path 默认当前目录，glob 过滤文件名，例如 *.go",
	parameters: obj({ pattern: str(), path: opt(str()), glob: opt(str()), ignoreCase: opt(bool()), limit: opt(num()) }),
	execute: async (args, api) => {
		const rgArgs = ["--line-number", "--no-heading", "--color=never", "--max-columns=300", "-m", String(args.limit ?? 100)];
		if (args.ignoreCase) rgArgs.push("-i");
		if (args.glob) rgArgs.push("-g", args.glob);
		rgArgs.push("-e", args.pattern, "--", args.path ?? ".");
		return text(await run("rg", rgArgs, cwdOf(api)));
	},
});

export const findTool = defineTool({
	name: "find",
	description: "按文件名 glob 查找文件（遵守 .gitignore），例如 pattern=**/*_test.go",
	parameters: obj({ pattern: str(), path: opt(str()), limit: opt(num()) }),
	execute: async (args, api) => {
		const out = await run("rg", ["--files", "-g", args.pattern, "--", args.path ?? "."], cwdOf(api));
		return text(
			out
				.split("\n")
				.filter(Boolean)
				.slice(0, args.limit ?? 500)
				.join("\n"),
		);
	},
});

export const lsTool = defineTool({
	name: "ls",
	description: "列出目录内容，目录名后带 /",
	parameters: obj({ path: opt(str()) }),
	execute: async (args, api) => {
		const dir = path.resolve(cwdOf(api), args.path ?? ".");
		const items = await readdir(dir, { withFileTypes: true });
		return text(
			items
				.map((d) => (d.isDirectory() ? `${d.name}/` : d.name))
				.toSorted()
				.join("\n"),
		);
	},
});

// 注入的记忆不够用、或者想找以前的排查经验时，agent 自己查。结果是已有记忆，沉淀时不当新证据（见 memory/extract.ts）
export const memoryTool = defineTool({
	name: "memory",
	description:
		"查 Yi 的长期记忆（约定、Yi 的偏好、以前的排查经验与事实）：注入的记忆不够用、或者想找以前的经验时，用一句话查。" +
		"deep=true 时让记忆库综合推理后回答（慢，几十秒），适合「上次这类问题最后怎么定的、为什么」。约定在条件成立时照做；线索先核实再用。",
	parameters: obj({ query: str(), deep: opt(bool()) }),
	execute: async (args) => {
		if (args.deep)
			return text(`〔记忆库综合回答：依据已有记忆，不是新证据，易变的事实先核实〕\n${(await reflect(args.query, [])) || "没有相关记忆"}`);
		const r = await recall(args.query, "any");
		const block = render(r);
		const note = r.degraded.length ? `；部分来源不可用：${r.degraded.join("；")}` : "";
		return text(`〔记忆查询结果：已有记忆，不是新证据${note}〕\n${block || "没有相关记忆"}`);
	},
});

// 链式召回：按 ID 查消息、分派、草稿、任务、事件流，结果里带着下一跳的 ID。只给结果先经 Yi 过目的运行（见 lookup.ts）
export const lookupTool = defineTool({
	name: "lookup",
	description:
		"按 ID 查 cabinet 记下的事：某条消息（trigger）被分派给了谁、产出了什么草稿或任务、结果如何；某个事件流（会话、话题、MR）里最近的消息。" +
		"每个结果只给摘要，末尾「相关」列出下一跳的 ID，需要就接着查。提示里出现的 ID（trigger、route、draft、dev-、thread、gitlab:）都能查；" +
		"meego:<工作项 id>、doc:<文档 token> 列出这个工作项、文档在各处被提到的消息。" +
		LOOKUP_HELP,
	parameters: obj({ id: str() }),
	execute: async (args) => text(lookup(args.id)),
});

// 结论的结构化报告（A2UI）：只在看板上显示，不发出去；暂存到这次运行结束，由 runPi 交给调用方落库
export const showUiTool = defineTool({
	name: "show_ui",
	description: SHOW_UI_HELP,
	parameters: obj({ components: arr(unknown()) }),
	execute: async (args, api) => {
		const built = buildSurface(args.components);
		if ("error" in built) return { output: [{ type: "text" as const, text: `校验没通过，改了再调：\n${built.error}` }], isError: true };
		setPendingUi(String(api.conversationId), built.messages);
		return text("已收下，会和文字结论一起显示在看板上。");
	},
});

// 定时任务：list 只读、直接执行；其余守卫判成「要审批」，由 approvals.ts 在 Yi 批准后执行（scheduletool.ts），这里不会走到
export const scheduleTool = defineTool({
	name: "schedule",
	description:
		"管理定时任务：到点交给助手按 prompt 跑一次，结论私聊 Yi。action 默认 create。" +
		"list：列出现有的定时任务和 id（只读，直接返回）；Yi 要改、停、删某个定时任务时先 list 找到 id。" +
		"create：新建，要 name、prompt，再给 cron（重复跑）或 at（只跑一次 / 几次）二选一。" +
		"update：改已有的，要 id，只传要改的字段（name、cron 或 at、prompt、until、model、thinking），没传的不动。" +
		"pause / resume / end / delete：暂停、恢复、结束（不再跑，记录留着）、删除，只要 id。" +
		"除了 list 都会先发审批卡片给 Yi，批准后才生效；不要换个写法重复提交。" +
		"cron 是 5 段「分 时 日 月 周」，本机时区，例如每个工作日 9 点是 `0 9 * * 1-5`、每月 1 号 10 点是 `0 10 1 * *`。" +
		"「今天 18 点看一次」「明天 9 点提醒我」这种只跑一次的用 at，写本机时间 `YYYY-MM-DD HH:mm`，几次用逗号隔开，跑完自动结束，不要用 cron 凑。" +
		"prompt 写清到点要做什么、看哪些数据、结论要什么样，要能脱离这次对话独立看懂。" +
		"按 cron 只跑有限几天的给 until（本机时间 `YYYY-MM-DD HH:mm`，写最后一次之后），到点自动停用；不给的话日和月写死的 cron 每年这一天都会再跑。" +
		"Yi 指定了模型（「用 codex 6.2 sol」「用 opus」）就给 model，写模型 id（如 `codex/gpt-6.2-sol`、`claude/claude-opus-5-5`），到点直接用这个模型跑，" +
		"不要在 prompt 里让自己再去调 codex exec；update 时 model 写 default 是回到助手默认。thinking 是思考强度（low / medium / high / xhigh / max）。" +
		"都不给就用助手的默认配置。id 写错、模型写错会退回并说明。",
	parameters: obj({
		action: opt(str()),
		id: opt(str()),
		name: opt(str()),
		cron: opt(str()),
		at: opt(str()),
		prompt: opt(str()),
		until: opt(str()),
		model: opt(str()),
		thinking: opt(str()),
	}),
	execute: async (args) => {
		if ((args.action ?? "").trim() === "list") {
			const { listScheduleText } = await import("../scheduletool.ts");
			return text(listScheduleText());
		}
		throw new Error("改定时任务需要 Yi 审批，不能直接执行");
	},
});
