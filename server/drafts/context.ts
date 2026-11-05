// 起草前补齐上下文：会话最近的消息、被回复的消息、所在话题、对方紧挨着发的消息
import { BOT_OPEN_ID, OWNER_OPEN_ID } from "../config.ts";
import { formatMessages, getMessage, listMessages } from "../lark/bot.ts";
import type { Message } from "../lark/types.ts";
import { log } from "../util.ts";

// 对方常先发内容、再单独发一条 @ 提醒：@ 之前这段时间内同一个人发的消息算作这条消息的一部分
const RELATED_WINDOW_MS = 10 * 60_000;

// 对方连着发、Yi 还没回的几条是同一段话：这段时间内的合成一份草稿，不各起一张
const BURST_WINDOW_MS = 30 * 60_000;

/** 这条消息要不要替 Yi 起草：人发的、不是 Yi 自己；私聊都算，群里要 @Yi（同时 @机器人的归机器人事件） */
export function asksYi(chatMode: string, m: Message): boolean {
	const mentions = new Set(m.mentions.map((x) => x.id));
	return (
		m.sender.sender_type === "user" &&
		m.sender.id !== OWNER_OPEN_ID &&
		!mentions.has(BOT_OPEN_ID) &&
		(chatMode === "p2p" || mentions.has(OWNER_OPEN_ID))
	);
}

/** 同一个人在 msgs 之前连着发、Yi 还没回的消息（recent 按时间正序）：和 msgs 是一段话，一起起草 */
export function burstBefore(chatMode: string, recent: Message[], msgs: Message[]): Message[] {
	const ids = new Set(msgs.map((m) => m.message_id));
	const first = msgs[0];
	const sender = msgs.at(-1)!.sender.id;
	const lastOwner = Math.max(0, ...recent.filter((m) => m.sender.id === OWNER_OPEN_ID).map((m) => m.create_time));
	return recent.filter(
		(m) =>
			!ids.has(m.message_id) &&
			!m.deleted &&
			m.sender.id === sender &&
			m.create_time > lastOwner &&
			m.create_time < first.create_time &&
			first.create_time - m.create_time <= BURST_WINDOW_MS &&
			asksYi(chatMode, m),
	);
}

/** msgs 之后对方又发了要 Yi 回的消息：那条会起草，并把 msgs 合进去（burstBefore），这一份就不用推了 */
export function burstAfter(chatMode: string, recent: Message[], msgs: Message[]): boolean {
	const ids = new Set(msgs.map((m) => m.message_id));
	const last = msgs.at(-1)!;
	return recent.some(
		(m) =>
			!ids.has(m.message_id) &&
			!m.deleted &&
			m.sender.id === last.sender.id &&
			m.create_time > last.create_time &&
			m.create_time - msgs[0].create_time <= BURST_WINDOW_MS &&
			asksYi(chatMode, m),
	);
}

/** 只有 @、没有正文（「@向懿 @陈俊森」这种）：意思全在前文里 */
export const onlyMentions = (text: string) => !text.replace(/@\S+/g, "").trim();

/**
 * 起草前补齐上下文。recent 是会话最近的消息；related 是和这条消息直接相关的：
 * 被回复的消息、所在话题、对方紧挨着这条之前自己发的消息。
 */
export async function gatherContext(
	chat: { chat_id: string; chat_mode: string },
	msgs: Message[],
): Promise<{ related: string; recent: string; earlier: Message[] }> {
	const chatId = chat.chat_id;
	const first = msgs[0];
	const last = msgs.at(-1)!;
	let recent: Message[] = [];
	try {
		recent = (await listMessages({ chatId }, { order: "desc", pageSize: 20 })).toReversed();
	} catch (e) {
		log("读取会话上下文失败", chatId, e);
	}
	// 连着发、还没回的前几条算进要回复的消息，不再当前文
	const earlier = burstBefore(chat.chat_mode, recent, msgs);
	const ids = new Set([...earlier, ...msgs].map((m) => m.message_id));
	const related = new Map<string, Message>();
	const add = (m?: Message) => {
		if (m && !ids.has(m.message_id) && !m.deleted) related.set(m.message_id, m);
	};
	for (const m of msgs) {
		if (!m.parent_id || ids.has(m.parent_id)) continue;
		add(recent.find((x) => x.message_id === m.parent_id) ?? (await getMessage(m.parent_id).catch(() => undefined)));
	}
	if (last.thread_id) {
		for (const m of await listMessages({ threadId: last.thread_id }, { order: "asc", pageSize: 30 }).catch(() => [])) add(m);
	}
	for (const m of recent) {
		if (m.sender.id === last.sender.id && m.create_time < first.create_time && first.create_time - m.create_time <= RELATED_WINDOW_MS)
			add(m);
	}
	const sorted = [...related.values()].toSorted((a, b) => a.create_time - b.create_time);
	return { related: formatMessages(sorted), recent: formatMessages(recent.filter((m) => !ids.has(m.message_id))), earlier };
}

export function contextBlock(recent: string, related: string, text: string) {
	const parts = [`会话最近的消息（仅供参考）：\n${recent || "（无）"}`];
	if (related) parts.push(`和这条消息直接相关的前文（被回复的消息、所在话题、对方紧挨着发的消息）：\n${related}`);
	parts.push(`需要回复的新消息：\n${text}`);
	if (onlyMentions(text))
		parts.push("这条消息只有 @、没有正文：对方的意思在上面的前文里（多半是刚发的那几条），按前文判断要不要回、回什么，不要只当成打招呼。");
	return parts.join("\n\n");
}
