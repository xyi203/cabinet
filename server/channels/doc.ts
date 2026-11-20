// 云文档评论渠道：评论里 @Yi、Yi 参与的评论串有新回复，起草代回复；回复以 Yi 的身份发回评论串。
// 事件从机器人渠道的长连接进来（一个应用只有一条长连接，channels/bot.ts），这里管订阅、作废和发送
import { DRAFT_ENABLED } from "../config.ts";
import type { Draft } from "../db/schema.ts";
import { sendDocReply } from "../doc.ts";
import { expireDocDrafts } from "../drafts/replied.ts";
import { DraftError } from "../drafts/store.ts";
import { subscribeDocNotice } from "../lark/bot.ts";
import { log } from "../util.ts";
import type { Channel } from "./index.ts";

let subscribed = false;
let lastError = "";

/** 订阅要 Yi 的用户令牌带评论权限：还没重新授权时会失败，每轮再试，授权后自己接上；同一个错只记一次日志 */
async function subscribe() {
	if (subscribed) return;
	try {
		await subscribeDocNotice();
		subscribed = true;
		log("已订阅云文档评论通知");
	} catch (e) {
		const msg = String((e as Error)?.message ?? e);
		if (msg !== lastError) log("订阅云文档评论通知失败（缺权限的话在看板重新授权飞书）", msg);
		lastError = msg;
	}
}

async function send(d: Draft) {
	if (d.kind !== "text") throw new DraftError("云文档评论只能回文字，表情和表情包发不了");
	await sendDocReply(d.doc!, d.draft);
}

export const docChannel: Channel = {
	name: "doc",
	desc: "云文档评论 @Yi",
	enabled: () => DRAFT_ENABLED,
	poll: async () => {
		await subscribe();
		// Yi 自己回评论没有通知：逐条查待确认的草稿，Yi 亲自回过、评论已解决的作废
		if (subscribed) await expireDocDrafts().catch((e) => log("检查云文档评论草稿失败", e));
	},
	send,
};
