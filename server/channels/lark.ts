// 飞书渠道：用 Yi 的用户身份轮询私聊和 @Yi 的群消息（机器人事件收不到这两类），
// 拉回来的消息交给 router 分流（server/router/index.ts）；草稿以 Yi 的身份发回原会话。
import path from "node:path";
import { DRAFT_ENABLED, DRAFT_SKIP_CHATS, PATHS, POLL_HOT_N, POLL_INTERVAL, POLL_TOP_N } from "../config.ts";
import type { Draft } from "../db/schema.ts";
import { resolveSticker } from "../drafts/format.ts";
import { expireReactedDrafts } from "../drafts/replied.ts";
import { DraftError } from "../drafts/store.ts";
import { routeChat } from "../router/index.ts";
import { pollTopics } from "../topics.ts";
import { listChats, listMessages, reactAsUser, sendImageAsUser, sendTextAsUser } from "../lark/bot.ts";
import type { Message } from "../lark/types.ts";
import { log, now } from "../util.ts";
import type { Channel } from "./index.ts";

/** 每个会话上一次成功拉消息开始的时间：后排的会话隔 POLL_INTERVAL 才拉，从这里接着拉 */
const fetchedAt = new Map<string, number>();
let reactionsCheckedAt = 0;

/**
 * 分层：会话列表按最近活跃排序，每轮都拉；前 POLL_HOT_N 个会话每轮拉消息（正在聊的一般都在这里），
 * 后面的隔 POLL_INTERVAL 秒拉一次。新消息会把会话顶到前排，下一轮就按快的拉
 */
async function poll(since: number, full: boolean) {
	const started = now();
	const chats = (await listChats(POLL_TOP_N)).filter((c) => !DRAFT_SKIP_CHATS.has(c.chat_id) && c.p2p_target_type !== "bot");
	for (const [rank, chat] of chats.entries()) {
		const last = fetchedAt.get(chat.chat_id);
		if (!full && rank >= POLL_HOT_N && last && started - last < POLL_INTERVAL) continue;
		// 时间只按秒过滤，往前多取 2 分钟，靠 message_id 去重；后排会话从它上次拉到的地方接着拉
		const start = Math.min(since, last ?? since) - 120;
		let msgs: Message[];
		try {
			msgs = await listMessages({ chatId: chat.chat_id }, { start, order: "asc" });
			fetchedAt.set(chat.chat_id, started);
		} catch (e) {
			log("轮询会话失败", chat.chat_id, e);
			continue;
		}
		// 怎么处理交给 router：告警攒批、起草、Yi 亲自回复作废草稿
		routeChat(chat, msgs);
	}
	// 话题里的回复不在会话列表里：按话题另外拉
	await pollTopics(started, routeChat).catch((e) => log("轮询话题失败", e));
	// 表情回复要逐条查，不跟着快速轮次跑
	if (full || started - reactionsCheckedAt >= POLL_INTERVAL) {
		reactionsCheckedAt = started;
		await expireReactedDrafts().catch((e) => log("检查表情回复失败", e));
	}
}

/** 以 Yi 的身份回复：表情回复加在对方那条消息上；群里 @ 回对方；dm 时不回原消息，私聊发给对方 */
async function send(d: Draft, dm = false) {
	const uuid = `d-${d.id}`.slice(0, 50);
	if (d.kind === "reaction") return void (await reactAsUser(d.replyTo, d.draft));
	const target = dm
		? { openId: d.senderId }
		: d.chatMode === "p2p"
			? { chatId: d.chatId }
			: { replyTo: d.replyTo, inThread: Boolean(d.threadId) };
	if (d.kind === "sticker") {
		const sticker = resolveSticker(d.draft);
		if (!sticker) throw new DraftError(`表情包 ${d.draft} 不在目录里了`);
		return void (await sendImageAsUser(target, path.join(PATHS.stickers, sticker), uuid));
	}
	const body = d.chatMode === "p2p" || dm ? d.draft : `<at user_id="${d.senderId}"></at> ${d.draft}`;
	await sendTextAsUser(target, body, uuid);
}

/** 私聊发给草稿回复的那个人（飞书项目评论的发评人也走这里） */
export async function sendDm(d: Draft, openId: string) {
	await send({ ...d, senderId: openId }, true);
}

export const larkChannel: Channel = {
	name: "lark",
	desc: "飞书私聊和群里 @Yi（用户身份轮询）",
	enabled: () => DRAFT_ENABLED,
	poll,
	fast: true,
	send,
};
