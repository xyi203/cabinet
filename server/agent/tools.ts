// durable 自带 read / bash；这里补上只读的 grep / find / ls，参数里的路径由守卫按允许目录检查
import { defineTool } from "@earendil-works/pi-durable";
import { arr, bool, num, obj, opt, str, unknown } from "@earendil-works/pi-schema";
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { SHOW_UI_HELP } from "../a2ui/catalog.ts";
import { buildSurface, setPendingUi } from "../a2ui/surface.ts";
import { LOOKUP_HELP, lookup } from "../lookup.ts";
import { render, search } from "../memory/recall.ts";

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

// 注入的记忆不够用、或者想找以前的排查经验时，agent 自己查。结果是已有记忆，提取时不当新证据（见 memory/extract.ts）
export const memoryTool = defineTool({
	name: "memory",
	description:
		"查 Yi 的长期记忆（约定与历史线索）：注入的记忆不够用、或者想找以前的排查经验时，用关键词或一句话查。约定在条件成立时照做；线索先核实再用。",
	parameters: obj({ query: str() }),
	execute: async (args) => {
		const { items, degraded } = await search(args.query, { anyScope: true, topK: 10 });
		const block = render({ conventions: [], references: items });
		return text(`〔记忆查询结果：已有记忆，不是新证据${degraded ? `；向量检索不可用，只用了关键词` : ""}〕\n${block || "没有相关记忆"}`);
	},
});

// 链式召回：按 ID 查消息、分派、草稿、任务、事件流，结果里带着下一跳的 ID。只给结果先经 Yi 过目的运行（见 lookup.ts）
export const lookupTool = defineTool({
	name: "lookup",
	description:
		"按 ID 查 cabinet 记下的事：某条消息（trigger）被分派给了谁、产出了什么草稿或任务、结果如何；某个事件流（会话、话题、MR）里最近的消息。" +
		"每个结果只给摘要，末尾「相关」列出下一跳的 ID，需要就接着查。提示里出现的 ID（trigger、route、draft、dev-、thread、gitlab:）都能查。" +
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

// 新建定时任务：守卫一律判成「要审批」，由 approvals.ts 在 Yi 批准后建；这里的 execute 不会被走到
export const scheduleTool = defineTool({
	name: "schedule",
	description:
		"Yi 让你定期做某件事时（「每天 9 点…」「每周一…」），新建一个定时任务：到点交给助手按 prompt 跑一次，结论私聊 Yi。" +
		"会先发审批卡片给 Yi，批准后才生效。cron 是 5 段「分 时 日 月 周」，本机时区，例如每个工作日 9 点是 `0 9 * * 1-5`。" +
		"prompt 写清到点要做什么、看哪些数据、结论要什么样，要能脱离这次对话独立看懂。" +
		"只跑有限几次的（「今天 19:25、20:25 各看一次」）一定给 until（本机时间 `YYYY-MM-DD HH:mm`，写最后一次之后），到点自动停用，不用让 Yi 手动删；" +
		"不给的话日和月写死的 cron 每年这一天都会再跑。",
	parameters: obj({ name: str(), cron: str(), prompt: str(), until: opt(str()) }),
	execute: async () => {
		throw new Error("新建定时任务需要 Yi 审批，不能直接执行");
	},
});
