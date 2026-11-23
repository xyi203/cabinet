import assert from "node:assert/strict";
import { test } from "node:test";
const { openDb, useDb, getKv } = await import("../server/db/index.ts");
useDb(openDb(":memory:"));
const { draftWithAsk } = await import("../server/drafts/make.ts");
const { inflight, DraftError } = await import("../server/drafts/store.ts");

test("排队的消息上交代一句：记下来交给起草，不直接发给对方", () => {
	assert.throws(() => draftWithAsk("om_none", "去查一下"), DraftError);
	inflight.set("om_q", { chatId: "oc_1", chatMode: "group", label: "x", text: "第 4 点你查一下", since: 0 });
	assert.equal(draftWithAsk("om_q", "去查一下 db 数据"), "started");
	assert.equal(getKv("draft-ask:om_q", null), "去查一下 db 数据");
	inflight.delete("om_q");
});

test("交代的话起草完也留着：排队的事时间线上就有「你 → 助手」", async () => {
	const { taskViews } = await import("../server/tasks.ts");
	inflight.set("om_r", { chatId: "oc_1", chatMode: "group", label: "x", text: "successUrl 存哪了", since: 1 });
	draftWithAsk("om_r", "先查订单表");
	const v = taskViews([]).find((x) => x.id === "q:om_r");
	assert.deepEqual(
		v?.events.flatMap((e) => (e.k === "ask" ? [e.text] : [])),
		["先查订单表"],
	);
	inflight.delete("om_r");
});
