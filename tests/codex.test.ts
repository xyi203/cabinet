import assert from "node:assert/strict";
import { test } from "node:test";
const { openDb, useDb, getKv } = await import("../server/db/index.ts");
useDb(openDb(":memory:"));
const { runCodex, useCodexClient, codexSteps, codexDoneKey } = await import("../server/agent/codex.ts");

/** 假的 codex：记下每次是新开还是接着哪个 thread、收到的输入，按给定事件流回放 */
function fake(events: any[]) {
	const calls: { kind: "start" | "resume"; id?: string; input?: string; options: any }[] = [];
	const thread = (c: (typeof calls)[number]) => ({
		runStreamed: async (input: string) => {
			c.input = input;
			return {
				events: (async function* () {
					yield* events;
				})(),
			};
		},
	});
	const client = {
		startThread: (options: any) => {
			const c = { kind: "start" as const, options };
			calls.push(c);
			return thread(c) as any;
		},
		resumeThread: (id: string, options: any) => {
			const c = { kind: "resume" as const, id, options };
			calls.push(c);
			return thread(c) as any;
		},
	};
	return { client, calls };
}

const turn = (text: string) => [
	{ type: "thread.started", thread_id: "th-1" },
	{ type: "turn.started" },
	{
		type: "item.started",
		item: { id: "i1", type: "command_execution", command: "php -l a.php", aggregated_output: "", status: "in_progress" },
	},
	{
		type: "item.completed",
		item: {
			id: "i1",
			type: "command_execution",
			command: "php -l a.php",
			aggregated_output: "No syntax errors",
			exit_code: 0,
			status: "completed",
		},
	},
	{ type: "item.completed", item: { id: "e1", type: "error", message: "failed to parse hooks config" } },
	{ type: "item.completed", item: { id: "i2", type: "agent_message", text } },
	{
		type: "turn.completed",
		usage: { input_tokens: 1000, cached_input_tokens: 600, cache_write_input_tokens: 0, output_tokens: 50, reasoning_output_tokens: 20 },
	},
];

const agent = { model: "codex/gpt-6.1-sol", thinking: "high", prompt: "agents/assistant.md" };

test("codex 跑一轮：最后一条消息是结果，命令转成执行日志，用量按缓存拆开，thread 记下来", async () => {
	const { client, calls } = fake(turn("【无需回复】已回 Get"));
	useCodexClient(client);
	const r = await runCodex({ key: "mr-1", requestId: "draft:1", prompt: "审一下 MR", cwd: "/tmp", agent });
	assert.equal(r.text, "【无需回复】已回 Get");
	assert.equal(r.model, "gpt-6.1-sol");
	assert.deepEqual(r.usage, { input: 400, output: 50, cacheRead: 600, cost: 0 });
	assert.equal(calls[0].kind, "start");
	assert.equal(calls[0].options.model, "gpt-6.1-sol", "去掉网关的 codex/ 前缀");
	assert.equal(calls[0].options.sandboxMode, "danger-full-access");
	assert.equal(calls[0].options.approvalPolicy, "never");
	assert.match(calls[0].input ?? "", /MR 预审/, "新 thread 的第一轮带上档位提示词");
	assert.match(calls[0].input ?? "", /审一下 MR$/);
	const steps = codexSteps("mr-1") ?? [];
	assert.deepEqual(
		steps.map((s) => [s.kind, s.tool, (s.args as { command?: string } | undefined)?.command, s.error]),
		[
			["call", "bash", "php -l a.php", false],
			["text", undefined, undefined, undefined],
		],
	);
	assert.equal(getKv("codex-thread:mr-1", null), "th-1");
});

test("同一请求重启后再来直接拿结果，不再调 codex；复审接着同一个 thread、只给这一轮的输入", async () => {
	const { client, calls } = fake(turn("第二轮"));
	useCodexClient(client);
	const again = await runCodex({ key: "mr-1", requestId: "draft:1", prompt: "审一下 MR", cwd: "/tmp", agent });
	assert.equal(again.text, "【无需回复】已回 Get");
	assert.equal(calls.length, 0);
	const r = await runCodex({ key: "mr-1", requestId: "revise:1", prompt: "按增量复审", cwd: "/tmp", agent });
	assert.equal(r.text, "第二轮");
	assert.equal(calls[0].kind, "resume");
	assert.equal(calls[0].id, "th-1");
	assert.equal(calls[0].input, "按增量复审");
	assert.ok(getKv(codexDoneKey("revise:1"), null));
});

test("codex 失败或没有输出时报错，不记成跑完", async () => {
	const { client } = fake([
		{ type: "thread.started", thread_id: "th-2" },
		{ type: "turn.failed", error: { message: "quota" } },
	]);
	useCodexClient(client);
	await assert.rejects(runCodex({ key: "mr-2", requestId: "draft:2", prompt: "x", cwd: "/tmp", agent }), /codex 失败 quota/);
	assert.equal(getKv(codexDoneKey("draft:2"), null), null);
	useCodexClient(fake([{ type: "turn.completed", usage: null }]).client);
	await assert.rejects(runCodex({ key: "mr-3", prompt: "x", cwd: "/tmp", agent }), /codex 无输出/);
});
