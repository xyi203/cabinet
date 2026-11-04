// Yi 是否已亲自回复：起草前再看一眼，已回复就不起草；之后回复了，没处理的草稿作废
import { and, eq, inArray } from "drizzle-orm";
import { changed } from "../bus.ts";
import { OWNER_OPEN_ID } from "../config.ts";
import { db, schema } from "../db/index.ts";
import type { MeegoCard } from "../db/schema.ts";
import { listMessages } from "../lark/bot.ts";
import type { Message } from "../lark/types.ts";
import { meegoYiReplied } from "../meego.ts";
import { enqueueMemory } from "../memory/extract.ts";
import { log } from "../util.ts";
import { type ChatRef, claim, LIVE } from "./store.ts";

/** Yi 的这条消息算不算回复了 msgs。私聊任何一句都算；群里要有明确指向 */
export function ownerReplyCovers(chatMode: string, m: Message, msgs: Array<Pick<Message, "message_id" | "thread_id" | "sender">>): boolean {
	if (chatMode === "p2p") return true;
	const ids = new Set(msgs.map((x) => x.message_id));
	const senders = new Set(msgs.map((x) => x.sender.id));
	const threads = new Set(msgs.map((x) => x.thread_id).filter(Boolean));
	return Boolean(
		(m.parent_id && ids.has(m.parent_id)) || m.mentions.some((x) => senders.has(x.id)) || (m.thread_id && threads.has(m.thread_id)),
	);
}

/** 起草前再看一眼：Yi 已经亲自回复了就不起草 */
export async function yiReplied(chat: ChatRef, msgs: Message[]): Promise<boolean> {
	const last = msgs.at(-1)!;
	if (chat.chat_mode === "meego") return meegoYiReplied(last.meego as MeegoCard);
	let recent: Message[];
	try {
		recent = await listMessages({ chatId: chat.chat_id }, { order: "desc", pageSize: 30 });
	} catch (e) {
		log("检查是否已回复失败", chat.chat_id, e);
		return false;
	}
	return ownerRepliedIn(chat.chat_mode, recent, msgs);
}

export function ownerRepliedIn(chatMode: string, recent: Message[], msgs: Message[]): boolean {
	const pos = new Map(recent.map((m) => [m.message_id, m.message_position]));
	const base = Math.max(0, ...msgs.map((m) => pos.get(m.message_id) ?? 0));
	const last = msgs.at(-1)!;
	return recent.some(
		(m) =>
			m.sender.id === OWNER_OPEN_ID &&
			ownerReplyCovers(chatMode, m, msgs) &&
			(m.message_position > base || Boolean(m.thread_id && m.thread_id === last.thread_id)),
	);
}

/** Yi 亲自回复了，之前没处理的草稿作废，免得重复回复。群里只作废这条消息明确指向的草稿 */
export function expireDrafts(chat: ChatRef, m: Message) {
	// 消息时间到毫秒，但起草也可能晚于回复：只作废回复之前创建的草稿
	const repliedAt = m.create_time / 1000;
	const live = db()
		.select()
		.from(schema.drafts)
		.where(and(eq(schema.drafts.chatId, chat.chat_id), inArray(schema.drafts.status, LIVE)))
		.all();
	for (const d of live) {
		if (d.created >= repliedAt + 60) continue;
		const src = [{ message_id: d.replyTo, thread_id: d.threadId ?? undefined, sender: { id: d.senderId, name: "", sender_type: "user" } }];
		if (ownerReplyCovers(chat.chat_mode, m, src) && claim(d.id, LIVE, "expired")) {
			log("草稿作废：Yi 已亲自回复", d.id);
			// Yi 没用草稿、自己回的那句，是最直接的口吻样本
			enqueueMemory({
				type: "draft",
				replyTo: d.replyTo,
				outcome: "expired",
				yiReply: { id: m.message_id, text: m.content, at: repliedAt },
			});
		}
	}
}

/** 飞书项目没有 Yi 自己评论的通知，只能对待确认的草稿逐条查评论 */
export async function expireMeegoDrafts() {
	const live = db()
		.select()
		.from(schema.drafts)
		.where(and(eq(schema.drafts.chatMode, "meego"), inArray(schema.drafts.status, LIVE)))
		.all();
	for (const d of live) {
		if (d.meego && (await meegoYiReplied(d.meego)) && claim(d.id, LIVE, "expired")) {
			changed();
			enqueueMemory({ type: "draft", replyTo: d.replyTo, outcome: "expired" });
			log("飞书项目草稿作废：Yi 已亲自评论", d.id);
		}
	}
}
