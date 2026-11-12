import assert from "node:assert/strict";
import { test } from "node:test";
const { openDb, useDb, db, schema } = await import("../server/db/index.ts");
useDb(openDb(":memory:"));
const { decide, receive } = await import("../server/pipeline.ts");
const { approvalLink, boardUrl, devLink, draftLink, failureLink, opsLink } = await import("../server/boardlink.ts");

const t0 = Math.floor(Date.now() / 1000);
const msg = (id: string, thread: string) =>
	receive({ channel: "lark", externalId: id, thread, actorId: "ou_zs", actorName: "张三", text: id, at: t0 });
const taskOf = (routeId: number) =>
	db()
		.select()
		.from(schema.routes)
		.all()
		.find((r) => r.id === routeId)!.taskId!;
const approval = (id: string, extra: Partial<typeof schema.approvals.$inferInsert> = {}) => ({
	id,
	created: t0,
	status: "pending",
	tool: "bash",
	args: {},
	...extra,
});

test("参数按 URL 编码，没有参数就是首页", () => {
	assert.match(boardUrl(), /^http:\/\/127\.0\.0\.1:\d+\/$/);
	assert.match(boardUrl({ task: "apv:a1" }), /\/\?task=apv%3Aa1$/);
	assert.match(opsLink(), /\/\?view=ops&tab=%E8%87%AA%E6%A3%80$/);
});

test("草稿和 agent 任务链到所在的那件事，查不到分别退回首页和 dev", () => {
	const r = decide([msg("m1", "lark:oc_1#t1")], { agent: "assistant", rule: "分诊", actionKind: "draft" });
	db()
		.insert(schema.drafts)
		.values({
			id: "d1",
			chatId: "oc_1",
			chatMode: "group",
			chatName: "群",
			replyTo: "m1",
			senderName: "张三",
			text: "x",
			status: "pending",
			created: t0,
			routeId: r,
		})
		.run();
	const r2 = decide([msg("m2", "lark:oc_2#t1")], { agent: "assistant", rule: "分诊", actionKind: "dev", actionId: "dv1" });
	db()
		.insert(schema.devTasks)
		.values({
			id: "dv1",
			agent: "assistant",
			title: "t",
			repo: "",
			base: "",
			branch: "",
			worktree: "",
			status: "review",
			created: t0,
			updated: t0,
			routeId: r2,
		})
		.run();
	assert.match(draftLink("d1"), new RegExp(`/\\?task=${encodeURIComponent(taskOf(r))}$`));
	assert.equal(draftLink("", r), draftLink("d1"), "还没入库的草稿按分派找");
	assert.match(devLink("dv1"), new RegExp(`/\\?task=${encodeURIComponent(taskOf(r2))}$`));
	assert.equal(draftLink("nope"), boardUrl());
	assert.equal(devLink("nope"), boardUrl({ dev: "nope" }));
});

test("审批：按 agent 任务或被回复的消息挂到那件事，挂不上的待审批是 apv:，批完退回首页", () => {
	const r = decide([msg("m10", "lark:oc_3#t1")], { agent: "assistant", rule: "分诊", actionKind: "dev", actionId: "dv10" });
	db()
		.insert(schema.devTasks)
		.values({
			id: "dv10",
			agent: "assistant",
			title: "t",
			repo: "",
			base: "",
			branch: "",
			worktree: "",
			status: "review",
			created: t0,
			updated: t0,
			routeId: r,
		})
		.run();
	const want = `/?task=${encodeURIComponent(taskOf(r))}`;
	assert.ok(approvalLink(approval("a1", { devTaskId: "dv10" }) as any).endsWith(want));
	assert.ok(approvalLink(approval("a2", { draftReplyTo: "m10" }) as any).endsWith(want));
	assert.ok(approvalLink(approval("a3") as any).endsWith("/?task=apv%3Aa3"));
	assert.equal(approvalLink(approval("a4", { status: "done" }) as any), boardUrl());
});

test("起草失败：消息已分派就链到那件事，否则是合成的 fail-<消息>", () => {
	const r = decide([msg("m20", "lark:oc_4#t1")], { agent: "assistant", rule: "分诊", actionKind: "draft" });
	assert.ok(failureLink("fail-m20").endsWith(`/?task=${encodeURIComponent(taskOf(r))}`));
	assert.ok(failureLink("fail-m99").endsWith("/?task=fail-m99"));
});
