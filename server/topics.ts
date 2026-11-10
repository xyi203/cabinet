// 盯话题：轮询按会话拉消息，飞书不把话题里的回复放进会话列表（只给话题外的消息），
// 而且 @Yi 的那条被拉到时往往还没人回复、还没有话题 id，之后也不会再被拉到。
// 所以 cabinet 处理过的群消息（找 Yi 的）都记下来，reopen 时间内按话题拉新回复，交给同一个 routeChat 分流。
// 节奏按话题最近一次动静分档：一小时内每轮拉，一天内隔 POLL_INTERVAL，再久隔 30 分钟。
import { POLL_INTERVAL } from "./config.ts";
import { and, eq, gte } from "drizzle-orm";
import { db, deleteKv, getKv, listKv, schema, setKv } from "./db/index.ts";
import type { ChatRef } from "./drafts/store.ts";
import { getMessage, listMessages } from "./lark/bot.ts";
import type { Message } from "./lark/types.ts";
import { routeRules } from "./rules.ts";
import { log, now } from "./util.ts";

interface TopicWatch {
	/** 话题的第一条消息（@Yi 的那条） */
	root: string;
	chat: ChatRef;
	/** 话题 id（omt_）：有人回复之后才有 */
	thread?: string;
	/** 上一次拉的时间、话题里最近一条消息的时间（秒） */
	fetched: number;
	active: number;
}

const watchKey = (root: string) => `topic:${root}`;
const rootKey = (thread: string) => `topicroot:${thread}`;
const SLOW = 1800;

/** 群里找 Yi 的消息：开始盯它的话题。本身就是话题回复的不用记（它的话题已经在盯） */
export function watchTopic(chat: ChatRef, m: Message) {
	if (chat.chat_mode === "p2p" || chat.chat_mode === "meego" || m.root_id) return;
	if (getKv(watchKey(m.message_id), null)) return;
	const at = m.create_time / 1000;
	setKv(watchKey(m.message_id), { root: m.message_id, chat, thread: m.thread_id, fetched: at, active: at } satisfies TopicWatch);
	if (m.thread_id) setKv(rootKey(m.thread_id), m.message_id);
}

/** 话题 id → 它的第一条消息（归属时找原来那件事用）；thread 是 trigger 的 thread（lark:<chat>#<omt>）或 omt 本身 */
export function topicRoot(thread: string): string | undefined {
	const omt = thread.includes("#") ? thread.slice(thread.indexOf("#") + 1) : thread;
	return getKv<string | null>(rootKey(omt), null) ?? undefined;
}

/** 这一轮该不该拉：按最近动静分档 */
export function due(w: Pick<TopicWatch, "fetched" | "active">, at: number): boolean {
	const idle = at - w.active;
	const every = idle < 3600 ? 0 : idle < 86400 ? POLL_INTERVAL : SLOW;
	return at - w.fetched >= every;
}

/** 每轮轮询会话之后调用：拉到的新回复交给 route（routeChat），去重靠它的已处理表 */
export async function pollTopics(at: number, route: (chat: ChatRef, msgs: Message[]) => void) {
	const ttl = routeRules().reopen;
	for (const { key, value: w } of listKv<TopicWatch>("topic:")) {
		if (at - w.active > ttl) {
			deleteKv(key);
			if (w.thread) deleteKv(rootKey(w.thread));
			continue;
		}
		if (!due(w, at)) continue;
		try {
			let thread = w.thread;
			if (!thread) {
				thread = (await getMessage(w.root))?.thread_id;
				if (thread) setKv(rootKey(thread), w.root);
			}
			if (!thread) {
				setKv(key, { ...w, fetched: at });
				continue;
			}
			// 话题容器不按时间过滤：取最近 50 条，只留上次之后的（往前多看 2 分钟，靠已处理表去重）
			const msgs = (await listMessages({ threadId: thread }, { order: "desc", pageSize: 50 }))
				.filter((m) => m.create_time / 1000 >= w.fetched - 120)
				.toReversed();
			const active = Math.max(w.active, ...msgs.map((m) => m.create_time / 1000));
			setKv(key, { ...w, thread, fetched: at, active });
			if (msgs.length) route(w.chat, msgs);
		} catch (e) {
			log("拉话题失败", w.root, e);
		}
	}
}

/**
 * 上线前就起草过的群消息也盯上（只跑一次）：从现在开始拉，之前的回复不补起草，免得一下子冒出一批过时的草稿
 */
export function backfillTopics() {
	if (getKv("topics:backfilled", false)) return;
	const at = now();
	const rows = db()
		.select()
		.from(schema.drafts)
		.where(and(eq(schema.drafts.chatMode, "group"), gte(schema.drafts.created, at - routeRules().reopen)))
		.all();
	let n = 0;
	for (const d of rows) {
		if (getKv(watchKey(d.replyTo), null)) continue;
		const w: TopicWatch = {
			root: d.replyTo,
			chat: { chat_id: d.chatId, chat_mode: d.chatMode, name: d.chatName },
			fetched: at,
			active: d.created,
		};
		setKv(watchKey(d.replyTo), w);
		n++;
	}
	setKv("topics:backfilled", true);
	log(`盯话题：补上 ${n} 条最近起草过的群消息`);
}
