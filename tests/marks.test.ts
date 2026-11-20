import assert from "node:assert/strict";
import { test } from "node:test";
const { openDb, useDb } = await import("../server/db/index.ts");
useDb(openDb(":memory:"));
const { marksOf, threadMark, mark, relatedEvents, relatedBlock } = await import("../server/marks.ts");
const { receive } = await import("../server/pipeline.ts");
const { lookup } = await import("../server/lookup.ts");
const { now } = await import("../server/util.ts");

const MEEGO = "https://project.feishu.cn/research__development/issue/detail/7174514570";

test("正文里的 MR、飞书项目工作项、云文档都认成标记，重复的只算一次", () => {
	assert.deepEqual(
		marksOf(
			`看下 ${MEEGO} 和 ${MEEGO}，方案 https://shoplazza.feishu.cn/docx/AbCdEfGh12345 、` +
				"https://www.feishu.cn/wiki/K2q6wY73YiiRmFk9mZxc，MR https://gitlab.shoplazza.site/a/b/-/merge_requests/12",
		),
		["gitlab:a/b!12", "meego:7174514570", "doc:AbCdEfGh12345", "doc:K2q6wY73YiiRmFk9mZxc"],
	);
	assert.deepEqual(marksOf("https://example.com/docx/AbCdEfGh12345 普通文字"), []);
	assert.deepEqual(marksOf(undefined), []);
});

test("工作项和话题本身算标记，整个群、整个私聊不算", () => {
	assert.deepEqual(threadMark("meego:7174514570"), ["meego:7174514570"]);
	assert.deepEqual(threadMark("lark:oc_g#omt_1"), ["lark:oc_g#omt_1"]);
	assert.deepEqual(threadMark("lark:oc_g"), []);
	assert.deepEqual(threadMark("doc:7000001"), []);
});

test("群里贴了工单链接、Yi 自己也说过，工单评论起草时能串到这两条；同一事件流和这次的事件不重复给", () => {
	const t = now();
	// 群里没 @Yi 的消息：不进分派，只记标记
	mark({ event: "lark:om_g1", thread: "lark:oc_vip", actorName: "客服", text: `顾客说优惠码没生效 ${MEEGO}`, at: t - 3600 });
	// Yi 自己在私聊里提到这个工单
	mark({ event: "lark:om_p1", thread: "lark:oc_p2p", actorName: "向懿", owner: true, text: `这个我在看 ${MEEGO}`, at: t - 600 });
	// 没有标记的消息不记
	assert.deepEqual(mark({ event: "lark:om_g2", thread: "lark:oc_vip", text: "收到", at: t }), []);
	// 工单下的评论 @Yi：trigger 落库时顺手记上工作项标记
	const tid = receive({
		channel: "meego",
		externalId: "om_c1",
		thread: "meego:7174514570",
		actorName: "刘家乐",
		text: "麻烦看下",
		url: MEEGO,
		at: t,
	});
	receive({
		channel: "meego",
		externalId: "om_c0",
		thread: "meego:7174514570",
		actorName: "刘家乐",
		text: "更早一条",
		url: MEEGO,
		at: t - 60,
	});

	const got = relatedEvents(["meego:7174514570"], "meego:7174514570", { exclude: [tid] });
	assert.deepEqual(
		got.map((r) => r.event),
		["lark:om_p1", "lark:om_g1"],
		"只给别处的，新的在前；同一工单下的评论起草时另外拉过",
	);
	const block = relatedBlock(["meego:7174514570"], "meego:7174514570", [tid]);
	assert.match(block, /向懿（Yi 本人）：这个我在看/);
	assert.match(block, /客服：顾客说优惠码没生效/);
	assert.equal(relatedBlock(["meego:1"], "meego:1"), "");
});

test("一个事件带几个标记只出现一次；太久以前的不给", () => {
	const t = now();
	mark({ event: "lark:om_m1", thread: "lark:oc_x", text: `${MEEGO} https://gitlab.shoplazza.site/a/b/-/merge_requests/9`, at: t });
	mark({ event: "lark:om_old", thread: "lark:oc_y", text: "https://gitlab.shoplazza.site/a/b/-/merge_requests/9", at: t - 40 * 86400 });
	const got = relatedEvents(["meego:7174514570", "gitlab:a/b!9"], "lark:oc_z");
	assert.equal(got.filter((r) => r.event === "lark:om_m1").length, 1);
	assert.ok(!got.some((r) => r.event === "lark:om_old"));
});

test("lookup：meego:<工作项 id> 列出各处提到它的消息；meego:om_x 这类 trigger id 照旧查 trigger", () => {
	const out = lookup("meego:7174514570");
	assert.match(out, /别处提到它的/);
	assert.match(out, /lark:om_g1/);
	assert.match(lookup("meego:om_c1"), /^trigger meego:om_c1/);
	assert.match(lookup("thread:meego:7174514570"), /meego:om_c1/);
});
