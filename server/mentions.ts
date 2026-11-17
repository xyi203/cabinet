// 搜 @Yi：话题里的回复按会话拉不到（飞书的会话消息列表只给话题首条），话题首条没找 Yi 时 topics.ts 也没在盯，
// 别人在这种话题里 @Yi 就漏了。每 POLL_INTERVAL 秒用 Yi 的身份搜一次「@我」的消息，搜到的按会话交给同一个 routeChat：
// 去重靠已处理表，话题回复由 routeChat → watchTopic 开始盯它的话题，之后的回复照常拉。
import { DRAFT_SKIP_CHATS, POLL_INTERVAL } from "./config.ts";
import { getKv, setKv } from "./db/index.ts";
import type { ChatRef } from "./drafts/store.ts";
import { isHandled } from "./handled.ts";
import { getChat, getMessage, searchAtMe } from "./lark/bot.ts";
import type { Message } from "./lark/types.ts";
import { log } from "./util.ts";

const SINCE_KEY = "mentions:since";
/** 搜索索引有延迟：每次往前多看 10 分钟，靠已处理表去重 */
const LAG = 600;
/** 最多往回搜 6 小时：刚开通权限、或者搜索挂了一阵之后，不翻太久以前的 */
const MAX_BACK = 6 * 3600;

const chats = new Map<string, ChatRef>();
let lastRun = 0;
let lastError = { msg: "", at: 0 };

/** 用到的三个飞书接口；测试换成假的 */
const LARK = { searchAtMe, getChat, getMessage };

export async function pollMentions(at: number, route: (chat: ChatRef, msgs: Message[]) => void, force = false, api: typeof LARK = LARK) {
	if (!force && at - lastRun < POLL_INTERVAL) return;
	lastRun = at;
	const since = Math.max(getKv<number>(SINCE_KEY, 0), at - MAX_BACK);
	let hits;
	try {
		hits = await api.searchAtMe(since - LAG);
	} catch (e) {
		// 没开通 search:message 时每轮都会失败：同一个错误一小时只记一次
		const msg = String((e as Error).message).slice(0, 200);
		if (msg !== lastError.msg || at - lastError.at > 3600) {
			log("搜索 @Yi 的消息失败（需要 search:message 权限，到看板重新授权飞书）", msg);
			lastError = { msg, at };
		}
		return;
	}
	lastError = { msg: "", at: 0 };
	// 私聊本来就整个拉；跳过的会话照旧跳过；处理过的不再取正文
	const todo = hits.filter((h) => !h.p2p && !DRAFT_SKIP_CHATS.has(h.chatId));
	const done = isHandled(todo.map((h) => h.messageId));
	const byChat = new Map<string, string[]>();
	for (const h of todo) if (!done.has(h.messageId)) byChat.set(h.chatId, [...(byChat.get(h.chatId) ?? []), h.messageId]);
	let failed = false;
	for (const [chatId, ids] of byChat) {
		try {
			let chat = chats.get(chatId);
			if (!chat) {
				chat = await api.getChat(chatId);
				chats.set(chatId, chat);
			}
			const msgs = (await Promise.all(ids.map((id) => api.getMessage(id))))
				.filter((m): m is Message => Boolean(m))
				.toSorted((a, b) => a.create_time - b.create_time);
			if (msgs.length) route(chat, msgs);
		} catch (e) {
			failed = true;
			log("处理搜到的 @Yi 消息失败", chatId, String((e as Error).message).slice(0, 200));
		}
	}
	// 有会话没处理成就不往前推，下一轮从同一个起点再搜
	if (!failed) setKv(SINCE_KEY, at);
}
