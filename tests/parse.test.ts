import assert from "node:assert/strict";
import { test } from "node:test";
process.env.OWNER_OPEN_ID = "ou_owner";
const { splitNote, parseDraftBody } = await import("../server/drafts/format.ts");
const { ownerReplyCovers, ownerRepliedIn } = await import("../server/drafts/replied.ts");
const { onlyMentions } = await import("../server/drafts/context.ts");
const { parseMeegoCard, meegoMention, plainComment } = await import("../server/meego.ts");
const { messageText } = await import("../server/lark/bot.ts");
const { stripMentions } = await import("../server/qa.ts");
const { fastRoute, sessionKey } = await import("../server/agent/router.ts");

test("草稿拆出评审报告和备注", () => {
	assert.deepEqual(splitNote("看过了\n【评审报告】❌ 有问题\n【备注】别承诺"), { body: "看过了", note: "别承诺", report: "❌ 有问题" });
	assert.deepEqual(splitNote("好\n【备注】a\n【评审报告】b"), { body: "好", note: "a", report: "b" });
	assert.deepEqual(splitNote("只有正文"), { body: "只有正文", note: "", report: "" });
});

test("表情草稿识别，非法表情退回文字", () => {
	assert.deepEqual(parseDraftBody("【表情】赞"), { kind: "reaction", content: "THUMBSUP" });
	assert.deepEqual(parseDraftBody("【表情】done"), { kind: "reaction", content: "DONE" });
	assert.equal(parseDraftBody("【表情】不存在的").kind, "text");
	assert.equal(parseDraftBody("【表情包】../../etc/passwd").kind, "text");
});

const msg = (o: any) => ({
	message_id: "m",
	content: "",
	create_time: 0,
	message_position: 0,
	mentions: [],
	sender: { id: "ou_a", name: "a", sender_type: "user" },
	...o,
});

test("群里 Yi 的消息要明确指向才算回复", () => {
	const src = [msg({ message_id: "m1", thread_id: "t1", sender: { id: "ou_a" } })];
	assert.ok(ownerReplyCovers("p2p", msg({}), src));
	assert.ok(ownerReplyCovers("group", msg({ parent_id: "m1" }), src));
	assert.ok(ownerReplyCovers("group", msg({ mentions: [{ id: "ou_a" }] }), src));
	assert.ok(ownerReplyCovers("group", msg({ thread_id: "t1" }), src));
	assert.ok(!ownerReplyCovers("group", msg({ mentions: [{ id: "ou_b" }] }), src));
});

test("只有在对方消息之后的回复才算", () => {
	const target = msg({ message_id: "m1", message_position: 10 });
	const before = msg({ message_id: "y0", message_position: 9, sender: { id: "ou_owner" } });
	const after = msg({ message_id: "y1", message_position: 11, sender: { id: "ou_owner" } });
	assert.ok(!ownerRepliedIn("p2p", [target, before], [target]));
	assert.ok(ownerRepliedIn("p2p", [target, before, after], [target]));
});

const MENTION_CARD = `<card title="💬 有人在评论中提到了你">
产研空间 · 缺陷 · #7156223986
[结账页偶现【没有可用的支付方式】](https://project.feishu.cn/research__development/issue/detail/7156223986)
@黄文静(ou_a1c7) **在评论中提到了你:**
回复@谭雯宇(ou_3a4d)@向懿(ou_owner)这组 pod 的问题时间段帮忙确认一下
[图片]

[查看详情](https://project.feishu.cn/research__development/issue/detail/7156223986?tab_key=comment&tab_item_id=7704204674378829073#c) [回复评论](https://x)
</card>`;

test("飞书项目评论卡片", () => {
	const c = parseMeegoCard(MENTION_CARD)!;
	assert.equal(c.mention, true);
	assert.equal(c.senderName, "黄文静");
	assert.equal(c.senderId, "ou_a1c7");
	assert.equal(c.workItemId, "7156223986");
	assert.equal(c.simpleName, "research__development");
	assert.equal(c.commentId, "7704204674378829073");
	assert.equal(c.comment, "回复@谭雯宇@向懿这组 pod 的问题时间段帮忙确认一下\n[图片]");
	assert.equal(parseMeegoCard(MENTION_CARD.replace("💬 有人在评论中提到了你", "🔄️ Bug已在stg验证通过")), undefined);
	assert.equal(parseMeegoCard('<card title="你有一个新Bug待处理">x</card>'), undefined);
});

test("消息内容转文字", () => {
	const mentions = [{ key: "@_user_1", id: "ou_b", name: "小明" }];
	assert.equal(messageText("text", JSON.stringify({ text: "@_user_1 你好" }), mentions), "@小明 你好");
	assert.equal(
		messageText(
			"post",
			JSON.stringify({
				title: "标题",
				content: [
					[
						{ tag: "text", text: "a" },
						{ tag: "a", text: "链接", href: "https://x" },
					],
				],
			}),
		),
		"标题\n a[链接](https://x)".replace("\n ", "\n"),
	);
	assert.equal(messageText("image", "{}"), "[图片]");
	assert.equal(stripMentions({ content: "@_user_1 帮我看下", mentions }), "帮我看下");
});

test("MR 链接直接分给 CR，会话按 MR 区分", () => {
	const agents = { cr: { match: { links: ["gitlab_mr"] }, session: "mr" as const }, general: {} };
	const r = fastRoute(agents, "帮忙看下 https://gitlab.shoplazza.site/cart/baymax/-/merge_requests/89 谢谢")!;
	assert.equal(r[0], "cr");
	assert.equal(r[1].mrProject, "cart/baymax");
	assert.equal(sessionKey("cr", agents.cr, "oc_1", r[1]), "cr-cart_baymax-89");
	assert.equal(fastRoute(agents, "普通消息"), undefined);
	assert.equal(sessionKey("chat", { session: "none" }, "oc_1", { rule: "" }), null);
});

test("只有 @ 的消息", () => {
	assert.ok(onlyMentions("@向懿 @陈俊森 @宗晓阳"));
	assert.ok(!onlyMentions("@向懿 帮忙看下"));
});

test("飞书项目评论的 @ 用卡片里的 user_id", () => {
	const c = parseMeegoCard(MENTION_CARD, { 黄文静: "7654772598655503553" })!;
	assert.equal(c.senderLarkId, "7654772598655503553");
	assert.equal(
		meegoMention("黄文静", c.senderLarkId),
		'@黄文静<!-- mention:{"id":"lark_user_id_7654772598655503553","cn_name":"黄文静","blockType":"AT_USER_BLOCK"} -->',
	);
	assert.equal(meegoMention("黄文静"), "@黄文静");
});

test("评论上下文去掉 mention 标记", () => {
	assert.equal(plainComment('@向懿<!-- mention:{"blockId":"x","id":"lark_user_id_1"} --> 能加吗'), "@向懿 能加吗");
});

test("只有表情或无需回复才算 chat 的合法输出；正文去掉「草稿：」前缀", async () => {
	const { isAckOnly } = await import("../server/drafts/format.ts");
	assert.equal(isAckOnly("【表情】THUMBSUP"), true);
	assert.equal(isAckOnly("【无需回复】只是通知"), true);
	assert.equal(isAckOnly("是的，2392762 店铺。"), false);
	assert.equal(splitNote("草稿：\n\n我看下\n【备注】缺报错").body, "我看下");
});

test("图片消息带出 image_key，正文里的 ![Image](key) 也能取到", async () => {
	const { imageKeys } = await import("../server/lark/bot.ts");
	assert.equal(messageText("image", JSON.stringify({ image_key: "img_v3_02_ab-c" })), "[图片 img_v3_02_ab-c]");
	assert.deepEqual(imageKeys("![Image](img_v3_02174_7d1c68b7-338c) @a [图片 img_v3_02_x]"), ["img_v3_02174_7d1c68b7-338c", "img_v3_02_x"]);
});
