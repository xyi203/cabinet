// 起草前补齐上下文：会话最近的消息、被回复的消息、所在话题、对方紧挨着发的消息
import { formatMessages, getMessage, listMessages } from "../lark/bot.ts";
import type { Message } from "../lark/types.ts";
import { log } from "../util.ts";

// 对方常先发内容、再单独发一条 @ 提醒：@ 之前这段时间内同一个人发的消息算作这条消息的一部分
const RELATED_WINDOW_MS = 10 * 60_000;

/** 只有 @、没有正文（「@向懿 @陈俊森」这种）：意思全在前文里 */
export const onlyMentions = (text: string) => !text.replace(/@\S+/g, "").trim();

/**
 * 起草前补齐上下文。recent 是会话最近的消息；related 是和这条消息直接相关的：
 * 被回复的消息、所在话题、对方紧挨着这条之前自己发的消息。
 */
export async function gatherContext(chatId: string, msgs: Message[]): Promise<{ related: string; recent: string }> {
	const ids = new Set(msgs.map((m) => m.message_id));
	const first = msgs[0];
	const last = msgs.at(-1)!;
	let recent: Message[] = [];
	try {
		recent = (await listMessages({ chatId }, { order: "desc", pageSize: 20 })).toReversed();
	} catch (e) {
		log("读取会话上下文失败", chatId, e);
	}
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
	return { related: formatMessages(sorted), recent: formatMessages(recent.filter((m) => !ids.has(m.message_id))) };
}

export function contextBlock(recent: string, related: string, text: string) {
	const parts = [`会话最近的消息（仅供参考）：\n${recent || "（无）"}`];
	if (related) parts.push(`和这条消息直接相关的前文（被回复的消息、所在话题、对方紧挨着发的消息）：\n${related}`);
	parts.push(`需要回复的新消息：\n${text}`);
	if (onlyMentions(text))
		parts.push("这条消息只有 @、没有正文：对方的意思在上面的前文里（多半是刚发的那几条），按前文判断要不要回、回什么，不要只当成打招呼。");
	return parts.join("\n\n");
}
