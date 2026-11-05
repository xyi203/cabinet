import assert from "node:assert/strict";
import { test } from "node:test";
const { openDb, useDb } = await import("../server/db/index.ts");
useDb(openDb(":memory:"));
const { buildInbox } = await import("../server/tasks.ts");

const draft = (id: string, status: string, created: number) =>
	({ id, status, created, text: id, chatMode: "p2p", chatName: "", senderName: "张三" }) as any;

test("待你处理：有人在等的排最前，建议不回和有冲突的记忆放最后", () => {
	const items = buildInbox(
		[draft("d1", "pending", 10), draft("d2", "noreply", 20), draft("d3", "sent", 30)],
		[{ id: "fail-x", type: "draft", status: "blocked", title: "x", label: "张三", created: 5, error: "超时" } as any],
		[
			{ id: "dev-1", agent: "alert", status: "review", title: "告警 · 订单群 · 3 条", updated: 1 } as any,
			{ id: "dev-2", agent: "dev", status: "review", title: "加筛选", updated: 40 } as any,
			{ id: "dev-3", agent: "dev", status: "done", title: "旧的", updated: 50 } as any,
		],
		[{ id: 7, content: "回张三用英文", kind: "preference", updated: 3 } as any],
	);
	assert.deepEqual(
		items.map((i) => [i.level, i.kind, i.ref]),
		[
			["now", "draft", "d1"],
			["now", "failure", "fail-x"],
			["now", "dev", "dev-1"],
			["soon", "dev", "dev-2"],
			["later", "draft", "d2"],
			["later", "memory", "7"],
		],
	);
	assert.equal(items.find((i) => i.ref === "dev-1")!.why, "告警结论待看");
});

test("失败的 agent 任务只列一次（按 agent 任务列，不当成问答失败）", () => {
	const items = buildInbox(
		[],
		[{ id: "dev-9", type: "dev", status: "blocked", title: "查数据", label: "general", created: 5, error: "超时" } as any],
		[{ id: "dev-9", agent: "general", status: "failed", title: "查数据", updated: 6 } as any],
		[],
	);
	assert.deepEqual(
		items.map((i) => [i.kind, i.ref, i.why]),
		[["dev", "dev-9", "agent 任务失败"]],
	);
});

test("看板任务：查询类 agent 任务点了完成算已完成，不再挂在审核中；卡片按真实 agent 显示", async () => {
	const { db, schema } = await import("../server/db/index.ts");
	const { buildTasks } = await import("../server/tasks.ts");
	const t = Math.floor(Date.now() / 1000);
	const row = (id: string, agent: string, status: string) => ({
		id,
		agent,
		model: null,
		thinking: null,
		draftId: null,
		title: id,
		request: id,
		context: "",
		instructions: "",
		repo: "",
		base: "",
		branch: "",
		worktree: "",
		status,
		summary: "",
		error: null,
		mrUrl: null,
		session: null,
		runs: 1,
		usage: null,
		created: t,
		updated: t,
		routeId: null,
		notify: false,
	});
	db()
		.insert(schema.devTasks)
		.values([row("dev-a", "general", "done"), row("dev-b", "general", "review")] as any)
		.run();
	const tasks = buildTasks([], []);
	const a = tasks.find((x) => x.id === "dev-a")!;
	const b = tasks.find((x) => x.id === "dev-b")!;
	assert.deepEqual([a.status, a.sub, a.agent], ["done", "已完成", "general"]);
	assert.deepEqual([b.status, b.sub], ["in_review", "待看"]);
});

test("对话页的聊天不进任务看板，也不进待你处理", async () => {
	const { db, schema } = await import("../server/db/index.ts");
	const { buildTasks, buildInbox } = await import("../server/tasks.ts");
	const t = Math.floor(Date.now() / 1000);
	const base = {
		agent: "assistant",
		model: null,
		thinking: null,
		draftId: null,
		request: "查一下",
		context: "",
		instructions: "",
		repo: "",
		base: "",
		branch: "",
		worktree: "",
		summary: "",
		error: null,
		mrUrl: null,
		session: null,
		runs: 1,
		usage: null,
		created: t,
		updated: t,
		routeId: null,
		notify: false,
	};
	db()
		.insert(schema.devTasks)
		.values({ ...base, id: "dev-chat", title: "聊天", status: "review", chat: true } as any)
		.run();
	assert.equal(
		buildTasks([], []).some((x) => x.id === "dev-chat"),
		false,
	);
	const chat = { ...base, id: "dev-chat", title: "聊天", status: "failed", chat: true } as any;
	assert.equal(
		buildInbox([], [], [chat], []).some((i) => i.ref === "dev-chat"),
		false,
	);
});
