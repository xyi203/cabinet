// 飞书渠道：用 Yi 的用户身份轮询私聊和 @Yi 的群消息（机器人事件收不到这两类），
// 人发的起草代回复，机器人 @Yi 的当告警攒批；草稿以 Yi 的身份发回原会话。
import path from "node:path";
import { addAlert, batching, isAlert } from "../alerts.ts";
import { ALERT_ENABLED, DRAFT_ENABLED, DRAFT_SKIP_CHATS, OWNER_OPEN_ID, PATHS, POLL_HOT_N, POLL_INTERVAL, POLL_TOP_N } from "../config.ts";
import type { Draft } from "../db/schema.ts";
import { resolveSticker } from "../drafts/format.ts";
import { asksYi } from "../drafts/context.ts";
import { abortIfYiReplied, makeDraft } from "../drafts/make.ts";
import { expireDrafts, expireReactedDrafts } from "../drafts/replied.ts";
import { type ChatRef, DraftError, inflight } from "../drafts/store.ts";
import { isHandled, markHandled } from "../handled.ts";
import { listChats, listMessages, reactAsUser, sendImageAsUser, sendTextAsUser } from "../lark/bot.ts";
import type { Message } from "../lark/types.ts";
import { log, now } from "../util.ts";
import type { Channel } from "./index.ts";

const startDraft = (chat: ChatRef, msgs: Message[]) => void makeDraft(chat, msgs, markHandled);

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
			if (asksYi(chat.chat_mode, m)) {
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
				if (m.sender.id === OWNER_OPEN_ID) {
					expireDrafts(chat, m);
					abortIfYiReplied(chat, m);
				}
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
	// 表情回复要逐条查，不跟着快速轮次跑
	if (full || started - reactionsCheckedAt >= POLL_INTERVAL) {
		reactionsCheckedAt = started;
		await expireReactedDrafts().catch((e) => log("检查表情回复失败", e));
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
	fast: true,
	send,
};
