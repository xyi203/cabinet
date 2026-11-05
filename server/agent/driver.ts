// agent 驱动：pi-durable。对话、模型轮次、工具调用先落库再执行，进程崩溃或重启后从断点接着跑。
// - 每个会话 key（话题、MR、群聊等）对应一个 durable conversation，映射存在 kv 表
// - 提交带 requestId（如飞书消息 id），重启后同一条消息再来时接回原来那次运行，不会重复起草
// - 守卫用 ToolTask 的 beforeTool 钩子；每个 conversation 的策略同时存进 kv，重启恢复的运行也受约束
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	type Conversation,
	ConversationIdle,
	createRegistry,
	defineExtension,
	type Extension,
	type ToolRegistration,
	GenerationTask,
	Harness,
	hook,
	LiveDoc,
	section,
	ToolTask,
	UsageDoc,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CODEMODE_TOOL_NAME, createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { createBashTool, createEditTool, createReadTool, createWriteTool, type ImageProcessor } from "@earendil-works/pi-durable/tools";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { emit } from "../bus.ts";
import {
	CONFIG_DIR,
	PATHS,
	PI_FALLBACK_MODEL,
	PI_MODEL,
	PI_THINKING,
	PI_TIMEOUT,
	READ_ROOTS,
	SESSION_IDLE_DAYS,
	SKILLS_DIR,
} from "../config.ts";
import { type RecallScope, recallBlock } from "../memory/recall.ts";
import { deleteKv, getKv, listKv, setKv } from "../db/index.ts";
import { openTursoDurable } from "../db/turso.ts";
import type { Usage } from "../db/schema.ts";
import { Guard, mcpToolName } from "./guard.ts";
import { closeMcp, loadServers, mcpNamespaces, mcpTools } from "./mcp.ts";
import { QUOTA_RE, log, now } from "../util.ts";
import { models, resolveModel, textOf } from "./models.ts";
import { type AgentConfig, loadAgents } from "./router.ts";
import { findTool, grepTool, lookupTool, lsTool, memoryTool } from "./tools.ts";

const ctx = BACKGROUND_CONTEXT;

export interface RunOptions {
	cwd: string;
	/** 会话 key，同一 key 接着上次聊；为空时新开一个只用这一次的会话 */
	sessionId?: string | null;
	/** 幂等键：同一 requestId 只运行一次，重启后再提交会接回原来的运行 */
	requestId?: string;
	prompt: string;
	agent?: AgentConfig;
	/** 追加到 agent 指令的文件 */
	extraSystem?: string[];
	label?: string;
	chatId?: string;
	agentName?: string;
	/** 允许写的目录（开发任务的 worktree） */
	writeRoots?: string[];
	/** 给链式召回工具 lookup：只有结果先经 Yi 过目的运行才给（起草、改写、agent 任务），群里的问答不给 */
	lookup?: boolean;
	/** 按这段文字召回长期记忆，带在这一轮的输入里；不给就不带 */
	memory?: { query: string; scope: RecallScope };
}

export interface RunResult {
	text: string;
	usage: Usage;
	/** 实际使用的会话 key，执行日志按它查 */
	sessionId: string;
}

/**
 * 一次提交的接回凭据：第一次提交后记在 kv 的 run:<requestId>。重启后同一个 requestId 再来时直接挂回这次提交，
 * 不重新配置（会把已经换上的备用模型改回去）、不重新召回、不重新提交；before 是提交前的用量，花费按它算全。
 * 调用方处理完结果后用 forgetRun 清掉；清掉之后再来，durable 仍按 requestId 认出原来的提交（只是要重新准备一遍）。
 */
interface RunRecord {
	key: string;
	/** 提交所在的 durable 会话：接回时用它，不按 key 重新找（key 闲置太久会换新会话） */
	convId: number;
	submissionId: string;
	/** 换成备用模型后的 continue 提交：它没有 requestId，只能靠这里接回 */
	continueId?: string;
	before: Usage;
	at: number;
}
const runKey = (requestId: string) => `run:${requestId}`;

/** 这个 requestId 上次提交过、还能接回 */
export const hasRun = (requestId: string) => getKv<RunRecord | null>(runKey(requestId), null) !== null;
export const forgetRun = (requestId: string) => deleteKv(runKey(requestId));

/** 启动时清掉很久以前的接回凭据（调用方没来得及清的） */
export function pruneRuns(maxAge = 3 * 86400) {
	for (const { key, value } of listKv<RunRecord>("run:")) if (now() - value.at > maxAge) deleteKv(key);
}

export interface RunningInfo {
	label: string;
	started: number;
	chatId?: string;
	agent?: string;
	sessionId?: string | null;
}

/** 运行中的会话，看板据此显示「进行中」 */
export const running = new Map<string, RunningInfo>();

// read 打开的图片会作为工具结果留在会话里，之后每一轮都重发：先压到 Claude 视觉推荐的长边 1568px，
// base64 不超过 300KB（原图常有几百 KB，Photon 会依次降 JPEG 质量、再缩尺寸直到放得下）
const IMAGE_LIMITS = { maxWidth: 1568, maxHeight: 1568, maxBytes: 300_000 };
let photon: Promise<ImageProcessor> | undefined;
const images: ImageProcessor = {
	prepare: async (bytes, mimeType, limits) =>
		(await (photon ??= createNodePhotonImages())).prepare(bytes, mimeType, {
			maxWidth: Math.min(limits.maxWidth, IMAGE_LIMITS.maxWidth),
			maxHeight: Math.min(limits.maxHeight, IMAGE_LIMITS.maxHeight),
			maxBytes: Math.min(limits.maxBytes, IMAGE_LIMITS.maxBytes),
		}),
};

// edit / write 只有开发任务会选，守卫限制只能写它自己的 worktree
const TOOLS = {
	read: createReadTool({ images }),
	bash: createBashTool(),
	grep: grepTool,
	find: findTool,
	ls: lsTool,
	edit: createEditTool(),
	write: createWriteTool(),
	memory: memoryTool,
	lookup: lookupTool,
};
type ToolName = keyof typeof TOOLS;
const DEFAULT_TOOLS: ToolName[] = ["read", "grep", "find", "ls", "bash", "memory"];

// ---------- 守卫策略：conversation -> 只读策略 ----------

interface StoredPolicy {
	roots: string[];
	bash: string[] | "*";
	cwd: string;
	runId: string;
	writeRoots?: string[];
	commands?: string[];
	lookup?: boolean;
	mcp?: string[];
}

const guardOf = (p: StoredPolicy) =>
	new Guard({
		roots: p.roots,
		bash: p.bash,
		skillsDir: SKILLS_DIR,
		writeRoots: p.writeRoots,
		commands: p.commands,
		lookup: p.lookup,
		mcp: p.mcp,
	});
const policies = new Map<string, { guard: Guard; cwd: string; runId: string }>();

function policyOf(convId: string) {
	let p = policies.get(convId);
	if (!p) {
		// 重启后恢复的运行：内存里没有，从库里取；取不到就拦截（fail-closed）
		const stored = getKv<StoredPolicy | null>(`conv-policy:${convId}`, null);
		if (!stored) return undefined;
		p = { guard: guardOf(stored), cwd: stored.cwd, runId: stored.runId };
		policies.set(convId, p);
	}
	return p;
}

const readText = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").trim() : "");

const Cabinet = defineExtension({
	name: "cabinet",
	tools: Object.values(TOOLS),
	sections: [
		section("rules", () => readText(PATHS.system) || undefined, { tag: false }),
		// 长期记忆不进系统段：每轮按当前消息召回，带在输入里（见 runPi 的 memory）
		section("cwd", (input) => input.env?.cwd),
	],
	hooks: [
		// 每轮模型回复都推给看板：开发任务这类长运行，中间的说明也能实时看到
		hook(GenerationTask, {
			afterResponse: (message, api) => {
				const p = policyOf(String(api.conversationId));
				const text = textOf(message.content).trim();
				if (p && text) emit({ type: "text", runId: p.runId, text: text.slice(0, 3000), t: now() });
			},
		}),
		hook(ToolTask, {
			beforeTool: (call, api) => {
				const p = policyOf(String(api.conversationId));
				if (!p) return { block: "找不到这个会话的权限配置，已拦截" };
				const args = { ...(call.arguments as Record<string, unknown>) };
				const reason = p.guard.check(call.name, args, p.cwd);
				if (reason) return { block: reason };
				emit({ type: "tool_start", runId: p.runId, callId: call.id, tool: call.name, args, t: now() });
				// bash 命令可能被改写成 skill 脚本的绝对路径
				return { arguments: args as any };
			},
			afterTool: (call, result, api) => {
				const p = policyOf(String(api.conversationId));
				if (p)
					emit({
						type: "tool_end",
						runId: p.runId,
						callId: call.id,
						tool: call.name,
						result: textOf(result.output).slice(0, 2000),
						error: Boolean(result.isError),
						t: now(),
					});
				return undefined;
			},
		}),
	],
});

// ---------- Harness ----------

let _harness: Promise<Harness> | undefined;
/** 已注册的 MCP 工具，按 agent 的 mcp 配置挑给各次运行 */
let mcp: ToolRegistration[] = [];
/** mcp 工具和 codemode 扩展：只给配了 mcp 的 agent 选上，其他会话不出现 codemode 段 */
let mcpExtensions: Extension[] = [];

export function harness(): Promise<Harness> {
	return (_harness ??= (async () => {
		const registry = createRegistry();
		registry.install(Cabinet);
		// MCP 工具要在打开前注册：resume 接回的运行会按名字找工具
		const servers = [...new Set(Object.values(loadAgents().agents).flatMap((a) => expandMcp(a.mcp)))];
		if (servers.length) {
			mcp = await mcpTools(servers);
			mcpExtensions = [
				defineExtension({ name: "mcp", tools: mcp }),
				// models: false：脚本里不给 models.*（分类、生图要另外花钱，也用不上）
				createCodemodeExtension({ sandbox: new CodemodeSandbox(), namespaces: mcpNamespaces(servers), models: false }),
			];
			for (const e of mcpExtensions) registry.install(e);
		}
		const h = await Harness.open(
			await SqliteStorage.open(openTursoDurable(PATHS.agentDb)),
			{
				models: models(),
				registry,
				env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? process.cwd() }),
				identity: { attribution: null },
				settings: {
					retry: { maxRetries: 2 },
					toolExecution: "parallel",
					// 失败的运行不连带排在后面的输入：每次起草都是独立的一次提交
					afterFailedRun: "withdraw",
				},
				onReport: (r: any) => log("durable 报告", r.kind, r.reason ?? "", String(r.error?.message ?? r.error ?? "").slice(0, 200)),
			},
			ctx,
		);
		// 上次进程没跑完的运行接着跑；结果由同一 requestId 的重新提交接回
		h.resume();
		return h;
	})());
}

export async function closeHarness() {
	const h = _harness;
	_harness = undefined;
	policies.clear();
	if (h) await (await h).close(ctx);
	await closeMcp();
}

/** 会话 key -> durable conversation。闲置超过 SESSION_IDLE_DAYS 的换新会话：durable 的记录不可删改，
 * 旧会话留在库里（看板的执行日志按时间段取，不受影响），只是不再接着用，免得早已过时的上下文和图片每轮重发 */
async function conversationFor(key: string): Promise<Conversation> {
	const h = await harness();
	const id = getKv<number | null>(`conv:${key}`, null);
	// 没有记录的老会话当作刚用过，不在升级后第一次就被换掉
	const last = getKv<number | null>(`conv-at:${key}`, null) ?? now();
	const stale = SESSION_IDLE_DAYS > 0 && now() - last > SESSION_IDLE_DAYS * 86400;
	setKv(`conv-at:${key}`, now());
	if (id && !stale) {
		const conv = await h.conversation(id as any, ctx);
		if (conv) return conv;
	}
	if (id && stale) log(`会话 ${key} 闲置超过 ${SESSION_IDLE_DAYS} 天，换新会话`);
	const conv = await h.createConversation({ ownership: { kind: "ownerless" } }, ctx);
	setKv(`conv:${key}`, conv.id);
	return conv;
}

export function conversationId(key: string): number | undefined {
	return getKv<number | null>(`conv:${key}`, null) ?? undefined;
}

function sumUsage(state: any): Usage {
	const u: Usage = { input: 0, output: 0, cacheRead: 0, cost: 0 };
	for (const m of Object.values<any>(state?.models ?? {})) {
		u.input += m.input ?? 0;
		u.output += m.output ?? 0;
		u.cacheRead += m.cacheRead ?? 0;
		u.cost += m.cost?.total ?? 0;
	}
	return u;
}

async function usageNow(h: Harness, convId: Conversation["id"]) {
	return sumUsage(await h.snapshot(UsageDoc, convId, ctx));
}

/** skills: "*" 展开成 SKILLS_DIR 下全部有 SKILL.md 的目录 */
export function expandSkills(skills: AgentConfig["skills"], dir = SKILLS_DIR): string[] {
	if (skills !== "*") return skills ?? [];
	try {
		return readdirSync(dir)
			.filter((s) => existsSync(path.join(dir, s, "SKILL.md")))
			.toSorted();
	} catch {
		return [];
	}
}

/** mcp: "*" 展开成 MCP_CONFIG 里的全部 server */
export const expandMcp = (servers: AgentConfig["mcp"]): string[] => (servers === "*" ? Object.keys(loadServers()) : (servers ?? []));

/** 描述可能是多行的 YAML 折叠块：取 description 之后到下一个字段前的文字，截到一句话 */
export function skillDescription(text: string, max = 120): string {
	const m = /^description:\s*(?:[>|][-+]?\s*)?([\s\S]*?)(?=^\S[\w-]*:|^---)/m.exec(text);
	const desc = (m?.[1] ?? "").replace(/\s+/g, " ").trim();
	return desc.length > max ? `${desc.slice(0, max)}…` : desc;
}

function skillsHint(skills: string[]) {
	if (!skills.length) return "";
	const lines = skills.map((s) => `- ${s}：${skillDescription(readText(path.join(SKILLS_DIR, s, "SKILL.md")))}`);
	return `# 可用的 skill\n\n用到哪个先 read 它的说明 \`${SKILLS_DIR}/<名字>/SKILL.md\`，按说明里的只读子命令用；命令会按 config/skill-rules.json 判定，写操作要 Yi 审批。\n\n${lines.join("\n")}`;
}

async function waitSettled(submission: { wait(c: typeof ctx): Promise<any> }, conv: Conversation) {
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), PI_TIMEOUT * 1000);
	try {
		return await submission.wait(withAbortSignal(ac.signal, ctx));
	} catch (e) {
		if (ac.signal.aborted) {
			await conv.abort(ctx).catch(() => {});
			throw new Error(`pi 超时 ${PI_TIMEOUT}s`, { cause: e });
		}
		throw e;
	} finally {
		clearTimeout(timer);
	}
}

/** 选哪些扩展、开哪些工具：配了 mcp 的 agent 加上 codemode 工具和它那几个 server 的工具（连接失败没注册上的就没有） */
function withMcp(agent: AgentConfig, base: ToolRegistration[]) {
	const prefixes = expandMcp(agent.mcp).map((s) => mcpToolName(s, ""));
	const own = mcp.filter((t) => prefixes.some((p) => t.name.startsWith(p)));
	if (!own.length) return { extensions: [Cabinet], tools: base };
	const codemode = mcpExtensions.flatMap((e) => e.tools ?? []).filter((t) => t.name === CODEMODE_TOOL_NAME);
	return { extensions: [Cabinet, ...mcpExtensions], tools: [...base, ...codemode, ...own] };
}

export async function runPi(opts: RunOptions): Promise<RunResult> {
	const agent = opts.agent ?? {};
	const base = (agent.tools ?? DEFAULT_TOOLS).filter((t): t is ToolName => t in TOOLS && t !== "lookup");
	// agent 显式配成不带工具（tools: []）的不加
	const toolNames: ToolName[] = opts.lookup && base.length ? [...base, "lookup"] : base;
	// 不复用会话的 agent 也要按 requestId 固定 key：durable 在同一个 conversation 里认 requestId，重启后才接得回
	const key = opts.sessionId || (opts.requestId ? `once-${opts.requestId}` : `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
	const info: RunningInfo = { label: opts.label ?? "", started: now(), chatId: opts.chatId, agent: opts.agentName, sessionId: key };
	running.set(key, info);
	emit({ type: "run_start", runId: key, label: info.label, chatId: opts.chatId, agent: opts.agentName, t: now() });
	let ok = false;
	try {
		const h = await harness();
		const spec = agent.model ?? PI_MODEL;
		const fallback = agent.fallbackModel ?? PI_FALLBACK_MODEL;
		// 重启接回：上次已经提交过，直接挂回那次提交，不重新配置、不重新召回、不重新提交（见 RunRecord）
		const rec = opts.requestId ? getKv<RunRecord | null>(runKey(opts.requestId), null) : null;
		const resumed = rec?.key === key ? await h.submission((rec.continueId ?? rec.submissionId) as any, ctx) : undefined;
		const recConv = resumed && rec?.convId ? await h.conversation(rec.convId as any, ctx) : undefined;
		const conv = recConv ?? (await conversationFor(key));
		let submission: NonNullable<typeof resumed>;
		let record: RunRecord;
		if (resumed && rec) {
			log("接回运行", key, opts.requestId, rec.continueId ? "（备用模型那一段）" : "");
			submission = resumed;
			record = rec;
		} else {
			const skills = toolNames.includes("read") ? expandSkills(agent.skills) : [];
			// agent 用到的 skill 目录也要能读，否则连 SKILL.md 都打不开
			// 消息里的截图存在 PATHS.images，agent 用 read 打开
			const roots = [...READ_ROOTS, PATHS.images, ...skills.map((s) => path.join(SKILLS_DIR, s))];
			const policy: StoredPolicy = {
				roots,
				bash: agent.bash ?? ["git"],
				cwd: opts.cwd,
				runId: key,
				writeRoots: opts.writeRoots,
				commands: opts.writeRoots ? agent.commands : undefined,
				lookup: toolNames.includes("lookup"),
				mcp: expandMcp(agent.mcp),
			};
			setKv(`conv-policy:${String(conv.id)}`, policy);
			policies.set(String(conv.id), { guard: guardOf(policy), cwd: opts.cwd, runId: key });
			const instructions = [
				agent.prompt ? readText(path.join(CONFIG_DIR, agent.prompt)) : "",
				...(opts.extraSystem ?? []).map(readText),
				skillsHint(skills),
			]
				.filter(Boolean)
				.join("\n\n");
			await conv.configure(
				{
					model: resolveModel(spec),
					thinkingLevel: (agent.thinking ?? PI_THINKING) as any,
					...withMcp(
						agent,
						toolNames.map((t) => TOOLS[t]),
					),
					cwd: opts.cwd,
					instructions,
				},
				ctx,
			);
			const before = await usageNow(h, conv.id);
			const memory = opts.memory ? await recallBlock(opts.memory.query, opts.memory.scope) : "";
			const content = memory ? `${memory}\n\n---\n\n${opts.prompt}` : opts.prompt;
			submission = await conv.submit({ type: "input", content, requestId: opts.requestId }, ctx);
			record = { key, convId: Number(conv.id), submissionId: String(submission.id), before, at: now() };
			if (opts.requestId) setKv(runKey(opts.requestId), record);
		}
		let settled = await waitSettled(submission, conv);
		// 额度/限流这类错误换模型也能跑：同一会话里换成备用模型接着做，前面已经查到的内容不丢。已经换过的不再换
		if (settled.status === "unanswered" && !record.continueId && fallback && fallback !== spec) {
			const failure = (await h.snapshot(LiveDoc, conv.id, ctx))?.runFailure as any;
			if (QUOTA_RE.test(String(failure?.detail ?? ""))) {
				log(`模型 ${spec} 不可用（${String(failure.detail).slice(0, 80)}），换用 ${fallback}`, opts.label ?? "");
				await conv.configure({ model: resolveModel(fallback) }, ctx);
				const cont = await conv.submit({ type: "continue" }, ctx);
				// continue 没有 requestId：记下它的 ID，这一段里重启也接得回
				record = { ...record, continueId: String(cont.id) };
				if (opts.requestId) setKv(runKey(opts.requestId), record);
				settled = await waitSettled(cont, conv);
			}
		}
		const before = record.before;
		if (settled.status !== "done" || (settled.type !== "input" && settled.type !== "continue")) {
			const failure = (await h.snapshot(LiveDoc, conv.id, ctx))?.runFailure as any;
			throw new Error(`pi 失败 ${settled.reason ?? settled.status} ${failure?.detail ?? ""}`.trim());
		}
		const entry = await conv.commit((tx) => tx.entry(AssistantEntry, settled.answer), ctx);
		const text = textOf((entry?.model?.[0] as AssistantMessage | undefined)?.content).trim();
		if (!text) throw new Error("pi 无输出");
		const after = await usageNow(h, conv.id);
		const usage: Usage = {
			input: after.input - before.input,
			output: after.output - before.output,
			cacheRead: after.cacheRead - before.cacheRead,
			cost: after.cost - before.cost,
		};
		ok = true;
		return { text, usage, sessionId: key };
	} finally {
		running.delete(key);
		emit({ type: "run_end", runId: key, ok, t: now() });
	}
}

export interface Step {
	t: number;
	kind: "call" | "text";
	tool?: string;
	args?: unknown;
	text?: string;
	result?: string;
	error?: boolean;
	done?: number;
}

/** 执行日志：从 durable 的对话记录里取这一段时间的工具调用、结果和回答 */
export async function conversationLog(key: string, start?: number, end?: number): Promise<Step[] | undefined> {
	const id = conversationId(key);
	if (!id) return undefined;
	const conv = await (await harness()).conversation(id as any, ctx);
	if (!conv) return undefined;
	const lo = ((start ?? 0) - 5) * 1000;
	const hi = ((end ?? now()) + 5) * 1000;
	const page = await conv.entries({ order: "descending" }, 300, undefined, ctx);
	const steps: Step[] = [];
	const calls = new Map<string, Step>();
	for (const e of page.items.toReversed()) {
		for (const m of (e.model ?? []) as any[]) {
			const t = m.timestamp ?? 0;
			if (t < lo || t > hi) continue;
			if (m.role === "assistant") {
				for (const c of m.content ?? []) {
					if (c.type === "toolCall") {
						const step: Step = { t: t / 1000, kind: "call", tool: c.name, args: c.arguments ?? {} };
						calls.set(c.id, step);
						steps.push(step);
					} else if (c.type === "text" && c.text?.trim()) steps.push({ t: t / 1000, kind: "text", text: c.text.slice(0, 3000) });
				}
			} else if (m.role === "toolResult") {
				const step = calls.get(m.toolCallId) ?? { t: t / 1000, kind: "call" as const, tool: m.toolName, args: {} };
				Object.assign(step, { result: textOf(m.content).slice(0, 2000), error: Boolean(m.isError), done: t / 1000 });
				if (!calls.has(m.toolCallId)) steps.push(step);
			}
		}
	}
	return steps;
}

/**
 * 往正在运行的会话里插话：在当前这一轮工具调用结束后加入运行。会话空闲时返回 false，由调用方开新一轮。
 */
export async function steer(key: string, text: string): Promise<boolean> {
	const id = conversationId(key);
	if (!id) return false;
	const conv = await (await harness()).conversation(id as any, ctx);
	if (!conv) return false;
	try {
		await conv.submit({ type: "input", content: text, whenBusy: "steer", whenIdle: "reject" }, ctx);
		return true;
	} catch (e) {
		if (e instanceof ConversationIdle) return false;
		throw e;
	}
}

/** 停止会话当前的运行；等待中的 runPi 会以失败返回 */
export async function abortRun(key: string) {
	const id = conversationId(key);
	if (!id) return;
	const conv = await (await harness()).conversation(id as any, ctx);
	await conv?.abort(ctx);
}

export interface TranscriptItem {
	kind: "user" | "assistant" | "tool";
	t: number;
	text?: string;
	tool?: string;
	args?: unknown;
	result?: string;
	error?: boolean;
	done?: number;
	/** 看板预览：工具结果里的图片是 data URL，文字里提到的本地截图是 /api/images/<文件名> */
	images?: string[];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const LOCAL_IMAGE_RE = new RegExp(`${escapeRe(PATHS.images)}/([\\w.-]+\\.(?:png|jpe?g|gif|webp))`, "gi");

/** 文字里提到的本地截图（PATHS.images 下的文件），换成看板能取的地址 */
export function localImageUrls(text: string): string[] {
	return [...new Set([...text.matchAll(LOCAL_IMAGE_RE)].map((m) => `/api/images/${m[1]}`))];
}

const withImages = (item: TranscriptItem, urls: string[]) => (urls.length ? { ...item, images: urls } : item);

/** 完整对话：用户消息、agent 回复、工具调用及结果，按时间顺序 */
export async function conversationTranscript(key: string, limit = 400): Promise<TranscriptItem[]> {
	const id = conversationId(key);
	if (!id) return [];
	const conv = await (await harness()).conversation(id as any, ctx);
	if (!conv) return [];
	const page = await conv.entries({ order: "descending" }, limit, undefined, ctx);
	const items: TranscriptItem[] = [];
	const calls = new Map<string, TranscriptItem>();
	for (const e of page.items.toReversed()) {
		for (const m of (e.model ?? []) as any[]) {
			const t = (m.timestamp ?? 0) / 1000;
			if (m.role === "user") {
				const text = textOf(m.content);
				items.push(withImages({ kind: "user", t, text }, localImageUrls(text)));
			} else if (m.role === "assistant") {
				for (const c of m.content ?? []) {
					if (c.type === "text" && c.text?.trim()) items.push(withImages({ kind: "assistant", t, text: c.text }, localImageUrls(c.text)));
					else if (c.type === "toolCall") {
						const item: TranscriptItem = { kind: "tool", t, tool: c.name, args: c.arguments ?? {} };
						calls.set(c.id, item);
						items.push(item);
					}
				}
			} else if (m.role === "toolResult") {
				const item = calls.get(m.toolCallId);
				// read 打开的截图、MCP 返回的图都在工具结果里（read 已压到 300KB 以内），原样给看板
				const pics = ((m.content ?? []) as any[])
					.filter((c) => c.type === "image" && c.data)
					.map((c) => `data:${c.mimeType};base64,${c.data}`);
				if (item)
					Object.assign(
						item,
						{ result: textOf(m.content).slice(0, 2000), error: Boolean(m.isError), done: t },
						pics.length ? { images: pics } : {},
					);
			}
		}
	}
	return items;
}
