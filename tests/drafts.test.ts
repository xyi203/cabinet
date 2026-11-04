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
