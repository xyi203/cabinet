// agent 驱动端到端：真的 Harness + Turso 存储 + 守卫钩子，只把模型换成假的
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";

const dir = mkdtempSync(path.join(tmpdir(), "cabinet-agent-"));
process.env.DATA_DIR = path.join(dir, "data");
process.env.DEFAULT_CWD = path.join(dir, "work");
process.env.PI_FALLBACK_MODEL = "";
// 测试不依赖本机的 Ollama：只用关键词
process.env.EMBED_URL = "";
const work = process.env.DEFAULT_CWD;
await import("node:fs").then((fs) => fs.mkdirSync(work, { recursive: true }));
writeFileSync(path.join(work, "a.txt"), "hello");

const { useModels } = await import("../server/agent/models.ts");
const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
const models = createModels();
models.setProvider(faux.provider);
useModels(models);
const { openDb, useDb } = await import("../server/db/index.ts");
useDb(openDb(":memory:"));
const { runPi, closeHarness, conversationTranscript } = await import("../server/agent/driver.ts");

after(() => closeHarness());

test("一轮对话：工具调用经守卫，越界读被拦，结果落在 Turso 里", async () => {
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("read", { path: path.join(work, "a.txt") }), fauxToolCall("read", { path: "/etc/hosts" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("读到了 hello"),
	]);
	const res = await runPi({
		cwd: work,
		sessionId: "t1",
		requestId: "req-1",
		prompt: "读一下 a.txt",
		agent: { model: "faux-1", tools: ["read"] },
	});
	assert.equal(res.text, "读到了 hello");
	const items = await conversationTranscript("t1");
	const tools = items.filter((i) => i.kind === "tool");
	assert.equal(tools.length, 2);
	assert.match(tools[0].result ?? "", /hello/);
	assert.equal(tools[1].error, true);
	assert.match(tools[1].result ?? "", /不在允许|不允许|拦截|禁止/);
});

test("同一个 requestId 重新提交接回原来的运行，不再调模型", async () => {
	const calls = faux.state.callCount;
	const res = await runPi({
		cwd: work,
		sessionId: "t1",
		requestId: "req-1",
		prompt: "读一下 a.txt",
		agent: { model: "faux-1", tools: ["read"] },
	});
	assert.equal(res.text, "读到了 hello");
	assert.equal(faux.state.callCount, calls);
});

test("重启后从 Turso 读回对话", async () => {
	await closeHarness();
	const { conversationTranscript: again } = await import("../server/agent/driver.ts");
	const items = await again("t1");
	assert.ok(items.some((i) => i.kind === "assistant" && i.text === "读到了 hello"));
});

test("记忆：约定拼进这一轮的输入，agent 能用 memory 工具查", async () => {
	const { rememberFromYi } = await import("../server/memory/store.ts");
	rememberFromYi(
		"回 PM 的排期问题不要直接承诺日期",
		{ kind: "preference", application: "convention", appliesWhen: "有人问上线或排期时间时" },
		{ kind: "yi", ref: "om_m", quote: "以后排期别直接承诺", at: 1 },
		"test",
		true,
	);
	let input = "";
	faux.setResponses([
		(ctx) => {
			input = JSON.stringify(ctx.messages.at(-1));
			return fauxAssistantMessage([fauxToolCall("memory", { query: "排期" })], { stopReason: "toolUse" });
		},
		fauxAssistantMessage("好"),
	]);
	await runPi({
		cwd: work,
		sessionId: "t-mem",
		requestId: "req-mem",
		prompt: "王五问：周三能上线吗",
		agent: { model: "faux-1" },
		memory: { query: "周三能上线吗", scope: {} },
	});
	assert.match(input, /适用的长期约定/);
	assert.match(input, /排期问题不要直接承诺日期/);
	const tool = (await conversationTranscript("t-mem")).find((i) => i.kind === "tool");
	assert.equal(tool?.error, false);
	assert.match(tool?.result ?? "", /记忆查询结果[\s\S]*排期问题/);
});

test("跑到一半进程退出：重启后挂回原来那次提交，不重新配置、不重新提交", async () => {
	const { hasRun } = await import("../server/agent/driver.ts");
	let entered!: () => void;
	const inFlight = new Promise<void>((r) => (entered = r));
	// 第一次调模型时一直不返回，模拟进程在模型调用中途退出
	faux.setResponses([
		(_context, options) => {
			entered();
			// 关 harness 时请求被中断：和进程退出时模型请求断掉一样
			return new Promise((_, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
		},
	]);
	const first = runPi({ cwd: work, sessionId: "t-crash", requestId: "req-crash", prompt: "查一下", agent: { model: "faux-1", tools: [] } });
	first.catch(() => {});
	await inFlight;
	assert.ok(hasRun("req-crash"));
	await closeHarness();

	// 重启：durable 自己把没跑完的那一轮接着跑；这次提交用了不存在的模型和别的提示——要是重新配置或重新提交就会露馅
	faux.setResponses([fauxAssistantMessage("接回后的回答")]);
	const res = await runPi({
		cwd: work,
		sessionId: "t-crash",
		requestId: "req-crash",
		prompt: "完全不同的提示",
		agent: { model: "no-such-model", tools: [] },
	});
	assert.equal(res.text, "接回后的回答");
	const items = await conversationTranscript("t-crash");
	const users = items.filter((i) => i.kind === "user");
	assert.equal(users.length, 1);
	assert.match(users[0].text ?? "", /查一下/);
	assert.doesNotMatch(users[0].text ?? "", /完全不同/);
});

test("跑完了但结果还没处理就退出：接回直接拿原来的答案，不再调模型", async () => {
	faux.setResponses([fauxAssistantMessage("第一次的答案")]);
	await runPi({ cwd: work, sessionId: "t-done", requestId: "req-done", prompt: "问", agent: { model: "faux-1", tools: [] } });
	await closeHarness();
	const calls = faux.state.callCount;
	const res = await runPi({
		cwd: work,
		sessionId: "t-done",
		requestId: "req-done",
		prompt: "问",
		agent: { model: "no-such-model", tools: [] },
	});
	assert.equal(res.text, "第一次的答案");
	assert.equal(faux.state.callCount, calls);
	const { forgetRun, hasRun } = await import("../server/agent/driver.ts");
	forgetRun("req-done");
	assert.equal(hasRun("req-done"), false);
});
