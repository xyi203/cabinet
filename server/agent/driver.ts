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
	GenerationTask,
	Harness,
	hook,
	LiveDoc,
	section,
	ToolTask,
	UsageDoc,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { emit } from "../bus.ts";
import { CONFIG_DIR, PATHS, PI_FALLBACK_MODEL, PI_MODEL, PI_THINKING, PI_TIMEOUT, READ_ROOTS, SKILLS_DIR } from "../config.ts";
import { type RecallScope, recallBlock } from "../memory/recall.ts";
import { getKv, setKv } from "../db/index.ts";
import { openTursoDurable } from "../db/turso.ts";
import type { Usage } from "../db/schema.ts";
import { Guard } from "./guard.ts";
import { QUOTA_RE, log, now } from "../util.ts";
import { models, resolveModel, textOf } from "./models.ts";
import type { AgentConfig } from "./router.ts";
import { findTool, grepTool, lsTool, memoryTool } from "./tools.ts";

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
	/** 按这段文字召回长期记忆，带在这一轮的输入里；不给就不带 */
	memory?: { query: string; scope: RecallScope };
}

export interface RunResult {
	text: string;
	usage: Usage;
	/** 实际使用的会话 key，执行日志按它查 */
	sessionId: string;
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

// edit / write 只有开发任务会选，守卫限制只能写它自己的 worktree
const TOOLS = {
	read: createReadTool(),
	bash: createBashTool(),
	grep: grepTool,
	find: findTool,
	ls: lsTool,
	edit: createEditTool(),
	write: createWriteTool(),
	memory: memoryTool,
};
type ToolName = keyof typeof TOOLS;
const DEFAULT_TOOLS: ToolName[] = ["read", "grep", "find", "ls", "bash", "memory"];

// ---------- 守卫策略：conversation -> 只读策略 ----------

interface StoredPolicy {
	roots: string[];
	bash: string[];
	cwd: string;
	runId: string;
	writeRoots?: string[];
	commands?: string[];
}

const guardOf = (p: StoredPolicy) =>
	new Guard({ roots: p.roots, bash: p.bash, skillsDir: SKILLS_DIR, writeRoots: p.writeRoots, commands: p.commands });
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

export function harness(): Promise<Harness> {
	return (_harness ??= (async () => {
		const registry = createRegistry();
		registry.install(Cabinet);
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
}

async function conversationFor(key: string): Promise<Conversation> {
	const h = await harness();
	const id = getKv<number | null>(`conv:${key}`, null);
	if (id) {
		const conv = await h.conversation(id as any, ctx);
		if (conv) return conv;
	}
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

function skillsHint(skills: string[]) {
	if (!skills.length) return "";
	const lines = skills.map((s) => {
		const file = path.join(SKILLS_DIR, s, "SKILL.md");
		const desc = /^description:\s*(.+)$/m.exec(readText(file))?.[1] ?? "";
		return `- ${s}：${desc}（说明在 ${file}，用之前先 read）`;
	});
	return `# 可用的 skill\n\n${lines.join("\n")}`;
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

export async function runPi(opts: RunOptions): Promise<RunResult> {
	const agent = opts.agent ?? {};
	const toolNames = (agent.tools ?? DEFAULT_TOOLS).filter((t): t is ToolName => t in TOOLS);
	// 不复用会话的 agent 也要按 requestId 固定 key：durable 在同一个 conversation 里认 requestId，重启后才接得回
	const key = opts.sessionId || (opts.requestId ? `once-${opts.requestId}` : `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
	const info: RunningInfo = { label: opts.label ?? "", started: now(), chatId: opts.chatId, agent: opts.agentName, sessionId: key };
	running.set(key, info);
	emit({ type: "run_start", runId: key, label: info.label, chatId: opts.chatId, agent: opts.agentName, t: now() });
	let ok = false;
	try {
		const h = await harness();
		const conv = await conversationFor(key);
		const skills = toolNames.includes("read") ? (agent.skills ?? []) : [];
		// agent 用到的 skill 目录也要能读，否则连 SKILL.md 都打不开
		const roots = [...READ_ROOTS, PATHS.images, ...skills.map((s) => path.join(SKILLS_DIR, s))];
		const policy: StoredPolicy = {
			roots,
			bash: agent.bash ?? ["git"],
			cwd: opts.cwd,
			runId: key,
			writeRoots: opts.writeRoots,
			commands: opts.writeRoots ? agent.commands : undefined,
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
		const spec = agent.model ?? PI_MODEL;
		await conv.configure(
			{
				model: resolveModel(spec),
				thinkingLevel: (agent.thinking ?? PI_THINKING) as any,
				tools: toolNames.map((t) => TOOLS[t]),
				cwd: opts.cwd,
				instructions,
			},
			ctx,
		);
		const before = await usageNow(h, conv.id);
		const memory = opts.memory ? await recallBlock(opts.memory.query, opts.memory.scope) : "";
		const content = memory ? `${memory}\n\n---\n\n${opts.prompt}` : opts.prompt;
		let settled = await waitSettled(await conv.submit({ type: "input", content, requestId: opts.requestId }, ctx), conv);
		// 额度/限流这类错误换模型也能跑：同一会话里换成备用模型接着做，前面已经查到的内容不丢
		const fallback = agent.fallbackModel ?? PI_FALLBACK_MODEL;
		if (settled.status === "unanswered" && fallback && fallback !== spec) {
			const failure = (await h.snapshot(LiveDoc, conv.id, ctx))?.runFailure as any;
			if (QUOTA_RE.test(String(failure?.detail ?? ""))) {
				log(`模型 ${spec} 不可用（${String(failure.detail).slice(0, 80)}），换用 ${fallback}`, opts.label ?? "");
				await conv.configure({ model: resolveModel(fallback) }, ctx);
				settled = await waitSettled(await conv.submit({ type: "continue" }, ctx), conv);
			}
		}
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
}

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
			if (m.role === "user") items.push({ kind: "user", t, text: textOf(m.content) });
			else if (m.role === "assistant") {
				for (const c of m.content ?? []) {
					if (c.type === "text" && c.text?.trim()) items.push({ kind: "assistant", t, text: c.text });
					else if (c.type === "toolCall") {
						const item: TranscriptItem = { kind: "tool", t, tool: c.name, args: c.arguments ?? {} };
						calls.set(c.id, item);
						items.push(item);
					}
				}
			} else if (m.role === "toolResult") {
				const item = calls.get(m.toolCallId);
				if (item) Object.assign(item, { result: textOf(m.content).slice(0, 2000), error: Boolean(m.isError), done: t });
			}
		}
	}
	return items;
}
