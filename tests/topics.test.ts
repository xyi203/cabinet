import assert from "node:assert/strict";
import { test } from "node:test";
const { openDb, useDb, db, schema } = await import("../server/db/index.ts");
useDb(openDb(":memory:"));
const { decide, receive, rootRefs } = await import("../server/pipeline.ts");
const { due, topicRoot, watchTopic } = await import("../server/topics.ts");
const { ownerRepliedIn } = await import("../server/drafts/replied.ts");
const { OWNER_OPEN_ID } = await import("../server/config.ts");

const chat = { chat_id: "oc_g", chat_mode: "group", name: "后端群" };
const msg = (id: string, extra: Record<string, unknown> = {}) =>
	({
		message_id: id,
		content: id,
		create_time: 1000_000,
		message_position: 1,
		mentions: [],
		sender: { id: "ou_a", name: "A", sender_type: "user" },
		...extra,
	}) as any;
const taskOf = (routeId: number) =>
	db()
		.select()
		.from(schema.routes)
		.all()
		.find((r) => r.id === routeId)!.taskId;

test("盯话题：只盯群里的话题根；节奏按最近动静分档", () => {
	watchTopic({ ...chat, chat_mode: "p2p" }, msg("om_p"));
	watchTopic(chat, msg("om_reply", { root_id: "om_root", thread_id: "omt_1" }));
	watchTopic(chat, msg("om_root2", { thread_id: "omt_2" }));
	assert.equal(topicRoot("lark:oc_g#omt_2"), "om_root2");
	assert.equal(topicRoot("omt_1"), undefined, "话题回复本身不记");
	const at = 100_000;
	assert.equal(due({ fetched: at - 1, active: at - 60 }, at), true, "一小时内有动静：每轮拉");
	assert.equal(due({ fetched: at - 10, active: at - 7200 }, at), false, "一天内：隔轮询间隔");
	assert.equal(due({ fetched: at - 600, active: at - 2 * 86400 }, at), false, "更久：隔 30 分钟");
	assert.equal(due({ fetched: at - 1800, active: at - 2 * 86400 }, at), true);
});

test("话题回复挂到话题根那件事上；根提到的 MR 回复也带上", () => {
	const rootId = receive({
		channel: "lark",
		externalId: "om_cr",
		thread: "lark:oc_g",
		actorId: "ou_a",
		text: "帮忙 CR https://gitlab.shoplazza.site/x/y/-/merge_requests/9",
	});
	const r1 = decide([rootId], { agent: "assistant", rule: "MR", actionKind: "draft" });
	assert.deepEqual(rootRefs("om_cr"), ["gitlab:x/y!9"]);
	// 有人在话题里回复：根当时没有话题 id，记的是主线 thread
	watchTopic(chat, msg("om_plain", { thread_id: "omt_9" }));
	const plain = receive({ channel: "lark", externalId: "om_plain", thread: "lark:oc_g", actorId: "ou_b", text: "问个问题" });
	const r2 = decide([plain], { agent: "assistant", rule: "分诊", actionKind: "draft" });
	const reply = receive({ channel: "lark", externalId: "om_r1", thread: "lark:oc_g#omt_9", actorId: "ou_c", text: "补充一下" });
	const r3 = decide([reply], { agent: "assistant", rule: "分诊", actionKind: "draft" });
	assert.equal(taskOf(r3), taskOf(r2), "按话题根找到原来那件事");
	const fix = receive({
		channel: "lark",
		externalId: "om_r2",
		thread: "lark:oc_g#omt_x",
		actorId: "ou_a",
		text: "改好了",
		refs: rootRefs("om_cr"),
	});
	const r4 = decide([fix], { agent: "assistant", rule: "分诊", actionKind: "draft" });
	assert.equal(taskOf(r4), taskOf(r1), "继承了 MR 引用，归到 CR 那件事");
});

test("话题里你之前回过的不算回了这条，之后回的才算", () => {
	const ask = msg("om_ask", { root_id: "om_root", thread_id: "omt_5", create_time: 2000, message_position: -2 });
	const yi = (t: number) =>
		msg(`om_yi${t}`, {
			root_id: "om_root",
			thread_id: "omt_5",
			create_time: t,
			message_position: -1,
			sender: { id: OWNER_OPEN_ID, name: "Yi", sender_type: "user" },
		});
	assert.equal(ownerRepliedIn("group", [yi(1000)], [ask]), false);
	assert.equal(ownerRepliedIn("group", [yi(3000)], [ask]), true);
});
