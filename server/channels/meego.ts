// 飞书项目渠道：读「飞书项目」机器人的评论通知卡片，评论里 @Yi 的起草代回复；回复用 meegle 以 Yi 的身份发评论
import { DRAFT_ENABLED, MEEGO_CHAT, MEEGO_ENABLED, OWNER_OPEN_ID } from "../config.ts";
import { getKv, setKv } from "../db/index.ts";
import type { Draft } from "../db/schema.ts";
import { expireMeegoDrafts } from "../drafts/replied.ts";
import { DraftError, inflight } from "../drafts/store.ts";
import { routeMeego } from "../router/index.ts";
import { isHandled, markHandled } from "../handled.ts";
import { getMessage, listChats, listMessages } from "../lark/bot.ts";
import type { Message } from "../lark/types.ts";
import { parseMeegoCard, projectKey, sendMeegoComment } from "../meego.ts";
import { log } from "../util.ts";
import type { Channel } from "./index.ts";

async function meegoChat(): Promise<string> {
	const cached = MEEGO_CHAT || getKv("meego_chat", "");
	if (cached) return cached;
	const chat = (await listChats(100)).find((c) => c.p2p_target_type === "bot" && c.name === "飞书项目");
	if (chat) {
		setKv("meego_chat", chat.chat_id);
		log("找到飞书项目通知会话", chat.chat_id);
	}
	return chat?.chat_id ?? "";
}

async function pollMeego(since: number) {
	const chatId = await meegoChat();
	if (!chatId) return;
	const msgs = await listMessages({ chatId }, { start: since - 120, order: "asc" });
	const done = isHandled(msgs.map((m) => m.message_id));
	const byItem = new Map<string, Message[]>();
	const skip: string[] = [];
	for (const m of msgs) {
		if (done.has(m.message_id) || inflight.has(m.message_id)) continue;
		const card = parseMeegoCard(m.content, m.userIds);
		// 只处理评论里提到 Yi 的；普通「有新评论」（发布通知等）直接跳过
		if (!card || !card.mention || card.senderId === OWNER_OPEN_ID) {
			skip.push(m.message_id);
			continue;
		}
		try {
			card.projectKey = await projectKey(card.simpleName);
		} catch (e) {
			log("解析飞书项目空间失败", card.simpleName, e);
			continue;
		}
		// meegle 评论时间是「YYYY-MM-DD HH:mm:ss」，按字符串比较
		card.notifiedAt = new Date(m.create_time).toLocaleString("sv-SE", { hour12: false });
		const msg: Message = {
			...m,
			content: card.comment,
			thread_id: undefined,
			meego: card,
			sender: { id: card.senderId, name: card.senderName, sender_type: "user" },
		};
		byItem.set(card.workItemId, [...(byItem.get(card.workItemId) ?? []), msg]);
	}
	markHandled(skip);
	// 同一工作项的一批交给 router 起草
	for (const [wid, list] of byItem)
		routeMeego({ chat_id: `meego-${wid}`, chat_mode: "meego", name: (list.at(-1)!.meego as any).workItemTitle }, list);
}

async function send(d: Draft) {
	if (d.kind !== "text") throw new DraftError("飞书项目评论只能回文字，表情和表情包发不了");
	// 早于这个字段的草稿没存发评人的 user_id：回头从通知卡片里取
	const larkId = d.meego!.senderLarkId ?? (await getMessage(d.replyTo).catch(() => undefined))?.userIds?.[d.senderName];
	await sendMeegoComment(d.meego!, d.senderName, d.draft, larkId);
}

export const meegoChannel: Channel = {
	name: "meego",
	desc: "飞书项目评论 @Yi",
	enabled: () => DRAFT_ENABLED && MEEGO_ENABLED,
	poll: async (since) => {
		await pollMeego(since);
		// 飞书项目没有 Yi 自己评论的通知：逐条查待确认的草稿，Yi 亲自回过的作废
		await expireMeegoDrafts();
	},
	send,
};
