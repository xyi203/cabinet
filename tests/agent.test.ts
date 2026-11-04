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
