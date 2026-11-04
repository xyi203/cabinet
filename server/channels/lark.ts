// 飞书渠道：用 Yi 的用户身份轮询私聊和 @Yi 的群消息（机器人事件收不到这两类），
// 人发的起草代回复，机器人 @Yi 的当告警攒批；草稿以 Yi 的身份发回原会话。
import path from "node:path";
import { addAlert, batching, isAlert } from "../alerts.ts";
import { ALERT_ENABLED, BOT_OPEN_ID, DRAFT_ENABLED, DRAFT_SKIP_CHATS, OWNER_OPEN_ID, PATHS, POLL_TOP_N } from "../config.ts";
import type { Draft } from "../db/schema.ts";
import { resolveSticker } from "../drafts/format.ts";
import { makeDraft } from "../drafts/make.ts";
import { expireDrafts } from "../drafts/replied.ts";
import { type ChatRef, DraftError, inflight } from "../drafts/store.ts";
import { isHandled, markHandled } from "../handled.ts";
import { listChats, listMessages, reactAsUser, sendImageAsUser, sendTextAsUser } from "../lark/bot.ts";
import type { Message } from "../lark/types.ts";
import { log, now } from "../util.ts";
import type { Channel } from "./index.ts";

const startDraft = (chat: ChatRef, msgs: Message[]) => void makeDraft(chat, msgs, markHandled);

async function poll(since: number) {
	// 时间只按秒过滤，往前多取 2 分钟，靠 message_id 去重
	const start = since - 120;
	for (const chat of await listChats(POLL_TOP_N)) {
		if (DRAFT_SKIP_CHATS.has(chat.chat_id) || chat.p2p_target_type === "bot") continue;
		let msgs: Message[];
		try {
			msgs = await listMessages({ chatId: chat.chat_id }, { start, order: "asc" });
		} catch (e) {
			log("轮询会话失败", chat.chat_id, e);
			continue;
		}
		const done = isHandled(msgs.map((m) => m.message_id));
		const fresh: Message[] = [];
		const skip: string[] = [];
		for (const m of msgs) {
			if (done.has(m.message_id) || inflight.has(m.message_id) || batching(m.message_id) || m.deleted) continue;
			// 机器人 @Yi 的是告警：不起草回复，攒一批交给 alert agent；收口时才记成已处理
			if (ALERT_ENABLED && isAlert(chat, m)) {
				addAlert(chat, m, markHandled);
				continue;
			}
			const mentions = new Set(m.mentions.map((x) => x.id));
			const wanted =
				m.sender.sender_type === "user" &&
				m.sender.id !== OWNER_OPEN_ID &&
				!mentions.has(BOT_OPEN_ID) && // 同时 @了机器人的交给机器人事件处理
				(chat.chat_mode === "p2p" || mentions.has(OWNER_OPEN_ID));
			if (wanted) {
				inflight.set(m.message_id, {
					chatId: chat.chat_id,
					chatMode: chat.chat_mode,
					label: chat.chat_mode === "p2p" ? m.sender.name : `${chat.name} · ${m.sender.name}`,
					text: m.content.slice(0, 300),
					since: now(),
				});
				fresh.push(m);
			} else {
				skip.push(m.message_id);
				if (m.sender.id === OWNER_OPEN_ID) expireDrafts(chat, m);
			}
		}
		markHandled(skip);
		if (fresh.length) {
			log(
				"待起草",
				chat.chat_id,
				fresh.map((m) => m.message_id),
			);
			startDraft(chat, fresh);
		}
	}
}

/** 以 Yi 的身份回复：表情回复加在对方那条消息上；群里 @ 回对方 */
async function send(d: Draft) {
	const uuid = `d-${d.id}`.slice(0, 50);
	if (d.kind === "reaction") return void (await reactAsUser(d.replyTo, d.draft));
	const target = d.chatMode === "p2p" ? { chatId: d.chatId } : { replyTo: d.replyTo, inThread: Boolean(d.threadId) };
	if (d.kind === "sticker") {
		const sticker = resolveSticker(d.draft);
		if (!sticker) throw new DraftError(`表情包 ${d.draft} 不在目录里了`);
		return void (await sendImageAsUser(target, path.join(PATHS.stickers, sticker), uuid));
	}
	const body = d.chatMode === "p2p" ? d.draft : `<at user_id="${d.senderId}"></at> ${d.draft}`;
	await sendTextAsUser(target, body, uuid);
}

export const larkChannel: Channel = {
	name: "lark",
	desc: "飞书私聊和群里 @Yi（用户身份轮询）",
	enabled: () => DRAFT_ENABLED,
	poll,
	send,
};
