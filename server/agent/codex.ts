// 用 Codex（@openai/codex-sdk，底层是本机的 codex CLI）跑一次 agent：agents.json 里配了 runner: "codex" 的档位走这里，目前是 MR 预审。
// 同样的模型和思考强度，codex 自己会派子代理、读大量上下文、实际跑代码复现，评审明显比 pi 的单线程深（MR 80 那次对比见提交说明）。
// 不加限制：沙箱全开、可联网、命令不用审批；评审意见照样由 Yi 在卡片上确认后才发到 MR（提示词里约定）。
// 同一个会话 key（同一个 MR）对应同一个 codex thread，复审接着聊；跑完的结果按 requestId 记下，重启后同一请求直接拿结果，跑到一半的整次重跑。
import { Codex, type ModelReasoningEffort, type ThreadEvent, type ThreadItem } from "@openai/codex-sdk";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { emit } from "../bus.ts";
import { CONFIG_DIR, PATHS, TASK_TIMEOUT } from "../config.ts";
import { getKv, setKv } from "../db/index.ts";
import type { Usage } from "../db/schema.ts";
import { recallBlock } from "../memory/recall.ts";
import { log, now } from "../util.ts";
import type { Step } from "./driver.ts";
import type { AgentConfig } from "./router.ts";

export interface CodexRun {
	/** 会话 key：同一个 key 接着同一个 codex thread */
	key: string;
	requestId?: string;
	prompt: string;
	cwd: string;
	agent: AgentConfig;
	extraSystem?: string[];
	memory?: { query: string; scope: any };
	timeout?: number;
}

const threadKey = (key: string) => `codex-thread:${key}`;
const doneKey = (requestId: string) => `codex-run:${requestId}`;
/** 调用方处理完结果后由 driver.forgetRun 一起清掉 */
export const codexDoneKey = doneKey;
const stepsKey = (key: string) => `codex-steps:${key}`;
const MAX_STEPS = 400;

const readText = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").trim() : "");

/** agents.json 里写的是 magpie 网关的模型名（codex/gpt-6.1-sol），codex CLI 要的是去掉前缀的 */
const codexModel = (spec?: string) => (spec ? spec.replace(/^codex\//, "") : undefined);

let client: Pick<Codex, "startThread" | "resumeThread"> | undefined;
/** 测试用：换成假的 codex 客户端 */
export const useCodexClient = (c: Pick<Codex, "startThread" | "resumeThread">) => void (client = c);

/** 执行日志：codex 的步骤不在 durable 里，存在 kv，看板的 StepLog 按时间取（见 driver.conversationLog） */
export function codexSteps(key: string, start?: number, end?: number): Step[] | undefined {
	const all = getKv<Step[] | null>(stepsKey(key), null);
	if (!all) return undefined;
	const lo = (start ?? 0) - 5;
	const hi = (end ?? now()) + 5;
	return all.filter((s) => s.t >= lo && s.t <= hi);
}

/** 这次运行用 codex：跑完的直接给结果；新跑的流式转成看板事件和执行日志 */
export async function runCodex(run: CodexRun): Promise<{ text: string; usage: Usage; model: string }> {
	const model = codexModel(run.agent.model) ?? "gpt-6.1-sol";
	if (run.requestId) {
		const done = getKv<{ text: string; usage: Usage } | null>(doneKey(run.requestId), null);
		if (done) {
			log("接回已跑完的 codex 运行", run.key, run.requestId);
			return { ...done, model };
		}
	}
	client ??= new Codex();
	const options = {
		model,
		modelReasoningEffort: (run.agent.thinking ?? "high") as ModelReasoningEffort,
		sandboxMode: "danger-full-access" as const,
		approvalPolicy: "never" as const,
		networkAccessEnabled: true,
		workingDirectory: run.cwd,
		skipGitRepoCheck: true,
	};
	const existing = getKv<string | null>(threadKey(run.key), null);
	const thread = existing ? client.resumeThread(existing, options) : client.startThread(options);
	// 规则和档位提示词只在新 thread 的第一轮给；接着聊的只给这一轮的输入
	const instructions = existing
		? ""
		: [
				readText(PATHS.system),
				run.agent.prompt ? readText(path.join(CONFIG_DIR, run.agent.prompt)) : "",
				...(run.extraSystem ?? []).map(readText),
			]
				.filter(Boolean)
				.join("\n\n");
	const memory = run.memory ? await recallBlock(run.memory.query, run.memory.scope) : "";
	const input = [instructions, memory, run.prompt].filter(Boolean).join("\n\n---\n\n");

	const ac = new AbortController();
	// 完整评审要派子代理、实际跑代码，起草默认的 10 分钟不够：没指定时按 agent 任务的上限
	const limit = run.timeout ?? TASK_TIMEOUT;
	const timer = setTimeout(() => ac.abort(), limit * 1000);
	const steps = getKv<Step[]>(stepsKey(run.key), []);
	const started = new Map<string, Step>();
	const save = () => setKv(stepsKey(run.key), steps.slice(-MAX_STEPS));
	let text = "";
	let usage: Usage = { input: 0, output: 0, cacheRead: 0, cost: 0 };
	try {
		const { events } = await thread.runStreamed(input, { signal: ac.signal });
		for await (const ev of events as AsyncGenerator<ThreadEvent>) {
			if (ev.type === "thread.started") setKv(threadKey(run.key), ev.thread_id);
			else if (ev.type === "item.started") onStart(ev.item);
			else if (ev.type === "item.completed") onDone(ev.item);
			else if (ev.type === "turn.completed" && ev.usage) {
				const u = ev.usage;
				// codex 走的是 Yi 的 ChatGPT 账号，没有按 token 计费，花费记 0
				usage = { input: u.input_tokens - u.cached_input_tokens, output: u.output_tokens, cacheRead: u.cached_input_tokens, cost: 0 };
			} else if (ev.type === "turn.failed") throw new Error(`codex 失败 ${ev.error.message}`);
			else if (ev.type === "error") throw new Error(`codex 出错 ${ev.message}`);
		}
	} catch (e) {
		if (ac.signal.aborted) throw new Error(`codex 超时 ${limit}s`, { cause: e });
		throw e;
	} finally {
		clearTimeout(timer);
		save();
	}
	if (!text.trim()) throw new Error("codex 无输出");
	if (run.requestId) setKv(doneKey(run.requestId), { text: text.trim(), usage });
	return { text: text.trim(), usage, model };

	function onStart(item: ThreadItem) {
		if (item.type !== "command_execution" && item.type !== "mcp_tool_call") return;
		const s: Step = { t: now(), kind: "call", ...call(item) };
		started.set(item.id, s);
		steps.push(s);
		emit({ type: "tool_start", runId: run.key, callId: item.id, tool: s.tool ?? "", args: s.args, t: s.t });
	}

	function onDone(item: ThreadItem) {
		if (item.type === "agent_message") {
			// 最后一条就是给 cabinet 的回复；中间的说明也推给看板
			text = item.text;
			steps.push({ t: now(), kind: "text", text: item.text });
			emit({ type: "text", runId: run.key, text: item.text.slice(0, 3000), t: now() });
			save();
			return;
		}
		if (item.type === "error") {
			// 配置告警（比如 hooks.json 解析失败）这类不影响运行，记一笔
			log("codex 提示", run.key, item.message.slice(0, 200));
			return;
		}
		if (item.type !== "command_execution" && item.type !== "mcp_tool_call") return;
		const s = started.get(item.id) ?? { t: now(), kind: "call" as const, ...call(item) };
		if (!started.has(item.id)) steps.push(s);
		const result = item.type === "command_execution" ? item.aggregated_output : JSON.stringify(item.result ?? item.error ?? "");
		const error = item.type === "command_execution" ? item.exit_code !== 0 : item.status === "failed";
		Object.assign(s, { result: String(result ?? "").slice(0, 2000), error, done: now() });
		emit({ type: "tool_end", runId: run.key, callId: item.id, tool: s.tool ?? "", result: s.result ?? "", error, t: now() });
		save();
	}
}

function call(item: ThreadItem): { tool: string; args: Record<string, unknown> } {
	if (item.type === "command_execution") return { tool: "bash", args: { command: item.command } };
	if (item.type === "mcp_tool_call")
		return { tool: `${item.server}.${item.tool}`, args: (item.arguments as Record<string, unknown>) ?? {} };
	return { tool: item.type, args: {} };
}
