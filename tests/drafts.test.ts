import assert from "node:assert/strict";
import { test } from "node:test";
const { openDb, useDb, schema } = await import("../server/db/index.ts");
useDb(openDb(":memory:"));
const { db } = await import("../server/db/index.ts");
const { applyDraftAction } = await import("../server/drafts/actions.ts");
const { DraftError, getDraft, pickDraft } = await import("../server/drafts/store.ts");

const base = {
	chatId: "oc_1",
	chatMode: "p2p",
	replyTo: "om_src",
	senderId: "ou_a",
	text: "在吗",
	draft: "在",
	created: Date.now() / 1000,
};

test("同一条草稿并发操作只有一个生效", async () => {
	db()
		.insert(schema.drafts)
		.values({ ...base, id: "om_d1", status: "pending" })
		.run();
	const results = await Promise.allSettled([1, 2, 3, 4, 5].map(() => applyDraftAction("om_d1", "complete")));
	assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
	assert.ok(results.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason instanceof DraftError));
	assert.equal(getDraft("om_d1")!.status, "completed");
	await assert.rejects(applyDraftAction("om_d1", "discard"), DraftError);
});

test("建议不回复的草稿不能直接发", async () => {
	db()
		.insert(schema.drafts)
		.values({ ...base, id: "om_d2", status: "noreply", created: base.created + 1 })
		.run();
	await assert.rejects(applyDraftAction("om_d2", "send"), /建议不回复/);
	assert.equal(getDraft("om_d2")!.status, "noreply");
});

test("没引用时「发」只挑最近的待确认草稿", () => {
	assert.equal(pickDraft(undefined, ["pending"]), undefined);
	assert.equal(pickDraft(undefined, ["pending", "noreply"])!.id, "om_d2");
	assert.equal(pickDraft("om_d1", ["pending"])!.id, "om_d1");
});

test("没引用时不会挑中只在看板上的表情草稿", () => {
	db()
		.insert(schema.drafts)
		.values({ ...base, id: "quiet_om_x_1", status: "noreply", created: base.created + 2 })
		.run();
	assert.equal(pickDraft(undefined, ["pending", "noreply"])!.id, "om_d2");
	assert.equal(pickDraft("quiet_om_x_1", ["noreply"])!.id, "quiet_om_x_1");
});

test("改版前接回的起草：旧 agent 名交给 assistant 的对应档位", async () => {
	const { stageAgent } = await import("../server/drafts/make.ts");
	const s = (agent: string, tier?: string) => stageAgent({ source: { agent } as any, tier });
	assert.deepEqual(s("ask"), { name: "assistant", tier: "deep" });
	assert.deepEqual(s("cr"), { name: "assistant", tier: "mr" });
	assert.deepEqual(s("chat"), { name: "assistant", tier: "ack" });
	// chat 改派到 general 之后又被打断：stage 记着 answer
	assert.deepEqual(s("general", "answer"), { name: "assistant", tier: "answer" });
	assert.deepEqual(s("assistant", "deep"), { name: "assistant", tier: "deep" });
});

test("看板操作草稿的路由也认安静草稿的 id（quiet_ 开头）", async () => {
	const { DRAFT_ACTION_RE, DRAFT_DISPATCH_RE } = await import("../server/api.ts");
	assert.equal(
		DRAFT_ACTION_RE.exec("/api/drafts/quiet_om_x100b618b2c9948a0cfc842c6ffd120c_mw2zbl32/send")?.[1],
		"quiet_om_x100b618b2c9948a0cfc842c6ffd120c_mw2zbl32",
	);
	assert.equal(DRAFT_ACTION_RE.exec("/api/drafts/om_abc/complete")?.[2], "complete");
	assert.ok(DRAFT_DISPATCH_RE.test("/api/drafts/quiet_om_abc_x/dispatch"));
	assert.equal(DRAFT_ACTION_RE.exec("/api/drafts/../etc/send"), null);
});

test("启动时把停在发送中 / 改写中的草稿复位：建议不回复的回到 noreply，其余回到待发送", async () => {
	const { recoverDrafts } = await import("../server/drafts/store.ts");
	const rows = [
		{ id: "om_r1", status: "sending", draft: "好的" },
		{ id: "om_r2", status: "revising", draft: "好的" },
		{ id: "om_r3", status: "revising", draft: "【无需回复】对方只是知会" },
		{ id: "om_r4", status: "sent", draft: "好的" },
	];
	for (const r of rows)
		db()
			.insert(schema.drafts)
			.values({ ...base, ...r })
			.run();
	assert.equal(recoverDrafts(), 3);
	assert.deepEqual(
		rows.map((r) => getDraft(r.id)!.status),
		["pending", "pending", "noreply", "sent"],
	);
	assert.equal(recoverDrafts(), 0);
});

test("哪些档位要等 Yi 批准：默认只有 deep 和 MR 直接处理", async () => {
	const { needsApproval } = await import("../server/drafts/make.ts");
	const { RULE_DEFAULTS } = await import("../server/rules.ts");
	assert.deepEqual(RULE_DEFAULTS.approval.auto, ["deep"]);
	const auto = RULE_DEFAULTS.approval.auto;
	assert.equal(needsApproval("deep", false, auto), false);
	assert.equal(needsApproval("ack", false, auto), true);
	assert.equal(needsApproval("answer", false, auto), true);
	// 没有档位的按默认档（answer）算
	assert.equal(needsApproval(undefined, false, auto), true);
	// MR 预审、催复审总是直接处理
	assert.equal(needsApproval("mr", false, auto), false);
	assert.equal(needsApproval("answer", true, auto), false);
	assert.equal(needsApproval("ack", false, ["*"]), false);
	assert.equal(needsApproval("deep", false, []), true);
});

test("轮询连续失败时间隔翻倍，最多 60 秒", async () => {
	const { backoff } = await import("../server/poller.ts");
	assert.deepEqual(
		[0, 1, 2, 3, 4, 10].map((n) => backoff(n, 5)),
		[5, 10, 20, 40, 60, 60],
	);
});

test("云文档评论：评论串能订阅接续，草稿发回 doc 渠道", async () => {
	const { subscribable } = await import("../server/pipeline.ts");
	const { channelOfDraft } = await import("../server/channels/index.ts");
	const { docUrl } = await import("../server/doc.ts");
	assert.deepEqual(subscribable("doc:7706", []), ["doc:7706"]);
	assert.equal(channelOfDraft({ chatMode: "doc" }).name, "doc");
	assert.equal(channelOfDraft({ chatMode: "group" }).name, "lark");
	assert.equal(docUrl("sheet", "abc"), "https://www.feishu.cn/sheets/abc");
});
