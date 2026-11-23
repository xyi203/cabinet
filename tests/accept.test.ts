import assert from "node:assert/strict";
import { test } from "node:test";
process.env.OWNER_OPEN_ID = "ou_yi";
process.env.BOT_OPEN_ID = "ou_bot";
const { openDb, useDb } = await import("../server/db/index.ts");
useDb(openDb(":memory:"));
const { accept } = await import("../server/qa.ts");

const atBot = [{ key: "@_user_1", id: "ou_bot", name: "Yi Bot" }];
const ev = (o: object) => ({ chatType: "group", senderType: "user", senderId: "ou_yi", mentions: atBot, ...o });

test("机器人长连接只直接处理 Yi：私聊、在群里 @机器人", () => {
	assert.equal(accept(ev({ chatType: "p2p", mentions: [] })), true);
	// Yi 在群里（含话题里）@机器人：马上执行
	assert.equal(accept(ev({})), true);
	// 群里没 @机器人（应用收到了群里全部消息时）
	assert.equal(accept(ev({ mentions: [{ key: "@_user_1", id: "ou_x", name: "张三" }] })), false);
	// 别人在群里 @机器人（走起草审核）、别人私聊机器人：这里不处理
	assert.equal(accept(ev({ senderId: "ou_x" })), false);
	assert.equal(accept(ev({ chatType: "p2p", senderId: "ou_x" })), false);
	// 机器人自己发的
	assert.equal(accept(ev({ senderType: "app" })), false);
});

test("别人在群里 @机器人：和 @Yi 一样起草等审核；Yi 自己 @机器人 不起草", async () => {
	const { asksYi } = await import("../server/drafts/context.ts");
	const msg = (senderId: string, mentionIds: string[]) => ({
		message_id: "om_1",
		content: "",
		create_time: 0,
		message_position: 0,
		mentions: mentionIds.map((id, i) => ({ key: `@_user_${i + 1}`, id, name: id })),
		sender: { id: senderId, name: "x", sender_type: "user" },
	});
	assert.equal(asksYi("group", msg("ou_x", ["ou_bot"])), true);
	assert.equal(asksYi("group", msg("ou_x", ["ou_yi"])), true);
	assert.equal(asksYi("group", msg("ou_x", ["ou_bot", "ou_yi"])), true);
	assert.equal(asksYi("group", msg("ou_x", ["ou_z"])), false);
	assert.equal(asksYi("group", msg("ou_yi", ["ou_bot"])), false);
});
