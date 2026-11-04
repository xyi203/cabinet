import assert from "node:assert/strict";
import { test } from "node:test";
const { openDb, useDb, schema } = await import("../server/db/index.ts");
useDb(openDb(":memory:"));
const { db } = await import("../server/db/index.ts");
const { decide, lineage, linkAction, receive, recentLineage, refsOf, settle } = await import("../server/pipeline.ts");
const { applyDraftAction } = await import("../server/drafts/actions.ts");

const msg = (id: string, text = "看下这个") => ({
	channel: "lark" as const,
	externalId: id,
	thread: "lark:oc_1",
	actorId: "ou_a",
	text,
	at: 1,
});

test("同一事件重复到达只记一次，内容不被覆盖", () => {
	assert.equal(receive(msg("om_1", "原文")), "lark:om_1");
	receive(msg("om_1", "重推的"));
	const rows = db().select().from(schema.triggers).all();
	assert.equal(rows.length, 1);
	assert.equal(rows[0].text, "原文");
	assert.equal(rows[0].status, "received");
});

test("正文里的 MR 链接记成跨渠道的引用", () => {
	assert.deepEqual(
		refsOf("帮忙看下 https://gitlab.shoplazza.site/a/b/-/merge_requests/12 和 https://gitlab.shoplazza.site/a/b/-/merge_requests/12"),
		["gitlab:a/b!12"],
	);
});

test("一次分派可以带一批 trigger，结果沿 route 串回每一条", () => {
	const ids = [receive(msg("om_2")), receive(msg("om_3"))];
	const routeId = decide(ids, { agent: "ask", rule: "分诊：排查", session: "ask-oc_1", actionKind: "draft" });
	linkAction(routeId, "om_dm1");
	settle({ actionKind: "draft", actionId: "om_dm1", routeId, outcome: "sent", effect: "outward" });
	for (const id of ids) {
		const l = lineage(id)!;
		assert.equal(l.trigger.status, "routed");
		assert.equal(l.route!.actionId, "om_dm1");
		assert.deepEqual(l.route!.triggers, ids);
		assert.deepEqual(
			l.results.map((r) => r.outcome),
			["sent"],
		);
	}
});

test("决定不处理的 trigger 标成跳过", () => {
	const id = receive(msg("om_4"));
	decide([id], { rule: "跳过：Yi 已亲自回复", actionKind: "none" });
	assert.equal(lineage(id)!.trigger.status, "skipped");
	assert.equal(lineage(id)!.results.length, 0);
	assert.ok(recentLineage().some((l) => l.trigger.id === id && l.route?.rule.startsWith("跳过")));
});

test("草稿走完写一条结果，挂在起草它的 route 上", async () => {
	const id = receive(msg("om_5"));
	const routeId = decide([id], { agent: "chat", rule: "分诊：寒暄", actionKind: "draft" });
	db()
		.insert(schema.drafts)
		.values({
			id: "om_dm5",
			chatId: "oc_1",
			chatMode: "p2p",
			replyTo: "om_5",
			senderId: "ou_a",
			text: "在吗",
			draft: "在",
			status: "pending",
			created: 1,
			routeId,
		})
		.run();
	await applyDraftAction("om_dm5", "discard");
	const results = lineage(id)!.results;
	assert.equal(results.length, 1);
	assert.equal(results[0].outcome, "discarded");
	assert.equal(results[0].effect, "internal");
});

const { lookup } = await import("../server/lookup.ts");

test("链式召回：从 trigger 沿 ID 走到分派、草稿、事件流和 MR", () => {
	const tid = receive({
		channel: "lark",
		externalId: "om_chain",
		thread: "lark:oc_chain",
		actorId: "ou_b",
		actorName: "李四",
		text: "帮忙看下 https://gitlab.shoplazza.site/shop/order/-/merge_requests/7",
		at: 100,
	});
	const routeId = decide([tid], { agent: "cr", rule: "MR 链接", actionKind: "draft" });
	db()
		.insert(schema.drafts)
		.values({
			id: "om_dmc",
			chatId: "oc_chain",
			chatMode: "group",
			chatName: "订单组",
			replyTo: "om_chain",
			senderId: "ou_b",
			senderName: "李四",
			text: "帮忙看下",
			draft: "LGTM",
			status: "pending",
			created: 101,
			routeId,
		})
		.run();
	linkAction(routeId, "om_dmc");

	const t = lookup(tid);
	assert.match(t, /李四/);
	assert.match(t, new RegExp(`route:${routeId}`));
	assert.match(t, /draft:om_dmc/);
	assert.match(t, /thread:lark:oc_chain/);
	assert.match(t, /gitlab:shop\/order!7/);

	assert.match(lookup(`route:${routeId}`), /lark:om_chain/);
	const d = lookup("draft:om_dmc");
	assert.match(d, /LGTM/);
	assert.match(d, /lark:om_chain/);
	assert.match(lookup("thread:lark:oc_chain"), /lark:om_chain/);
	// 别的事件流里提到同一个 MR 也能找到
	assert.match(lookup("gitlab:shop/order!7"), /lark:om_chain/);
	assert.match(lookup("nothing:here"), /ID 的写法/);
});

const { subscribable, subscribe, subscriber } = await import("../server/pipeline.ts");

test("订阅：话题、工作项和 MR 能订阅，整个群不订阅", () => {
	assert.deepEqual(subscribable("lark:oc_1", []), []);
	assert.deepEqual(subscribable("lark:oc_1#omt_9", ["gitlab:a/b!1"]), ["gitlab:a/b!1", "lark:oc_1#omt_9"]);
	assert.deepEqual(subscribable("meego:123", []), ["meego:123"]);
});

test("订阅直通：同一个 MR 在别的渠道出现也进同一个会话，MR 优先于话题，过期的不算", () => {
	subscribe(["lark:oc_2#omt_1"], { agent: "ask", session: "ask-oc_2" });
	subscribe(["gitlab:shop/order!8", "lark:oc_3#omt_2"], {
		agent: "cr",
		session: "cr-shop_order-8",
		info: { mrProject: "shop/order", mrIid: "8" },
	});
	// 飞书项目评论里提到同一个 MR：没有话题订阅，按 MR 命中
	const viaRef = subscriber(subscribable("meego:555", ["gitlab:shop/order!8"]));
	assert.equal(viaRef?.session, "cr-shop_order-8");
	assert.deepEqual(viaRef?.info, { mrProject: "shop/order", mrIid: "8" });
	// 话题里后来的消息没带链接，按话题命中
	assert.equal(subscriber(subscribable("lark:oc_2#omt_1", []))?.session, "ask-oc_2");
	// 既在订阅了 ask 的话题里、又提到了 MR：MR 优先
	assert.equal(subscriber(subscribable("lark:oc_2#omt_1", ["gitlab:shop/order!8"]))?.agent, "cr");
	// 3 天没用到的订阅失效
	db().update(schema.subscriptions).set({ updated: 0 }).run();
	assert.equal(subscriber(["gitlab:shop/order!8"]), undefined);
});

const { openRoute } = await import("../server/pipeline.ts");

test("接回时沿用还没走完的分派；有了结果（比如失败后重试）才重新分派", () => {
	const ids = [receive(msg("om_r1")), receive(msg("om_r2"))];
	assert.equal(openRoute(ids, "draft"), undefined);
	const routeId = decide(ids, {
		agent: "cr",
		rule: "MR 链接",
		session: "cr-a_b-1",
		info: { mrProject: "a/b", mrIid: "1" },
		actionKind: "draft",
	});
	const open = openRoute(ids, "draft")!;
	assert.equal(open.id, routeId);
	assert.equal(open.session, "cr-a_b-1");
	assert.deepEqual(open.info, { mrProject: "a/b", mrIid: "1" });
	// 不是同一种 action、或者只命中一部分 trigger，都不算
	assert.equal(openRoute(ids, "qa"), undefined);
	assert.equal(openRoute([...ids, receive(msg("om_r3"))], "draft"), undefined);
	settle({ actionKind: "draft", routeId, outcome: "failed", effect: "internal" });
	assert.equal(openRoute(ids, "draft"), undefined);
});
