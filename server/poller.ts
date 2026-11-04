// 用 Yi 的用户身份轮询私聊和 @Yi 的群消息（机器人事件收不到这两类），以及「飞书项目」的评论 @ 通知
import { inArray, lt } from "drizzle-orm";
import { BOT_OPEN_ID, DRAFT_SKIP_CHATS, MEEGO_CHAT, MEEGO_ENABLED, OWNER_OPEN_ID, POLL_INTERVAL, POLL_TOP_N } from "./config.ts";
import { db, getKv, schema, setKv } from "./db/index.ts";
import { type ChatRef, expireDrafts, expireMeegoDrafts, inflight, makeDraft } from "./drafts.ts";
import { UserAuthError, listChats, listMessages } from "./lark/bot.ts";
import type { Message } from "./lark/types.ts";
import { parseMeegoCard, projectKey } from "./meego.ts";
import { log, now } from "./util.ts";

function isHandled(ids: string[]): Set<string> {
	if (!ids.length) return new Set();
	return new Set(
		db()
			.select({ id: schema.handled.messageId })
			.from(schema.handled)
			.where(inArray(schema.handled.messageId, ids))
			.all()
			.map((r) => r.id),
	);
}

export function markHandled(ids: string[]) {
	const at = now();
	for (const messageId of ids) db().insert(schema.handled).values({ messageId, at }).onConflictDoNothing().run();
}

const startDraft = (chat: ChatRef, msgs: Message[]) => void makeDraft(chat, msgs, markHandled);

export async function pollOnce(since: number) {
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
			if (done.has(m.message_id) || inflight.has(m.message_id) || m.deleted) continue;
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

export async function pollMeego(since: number) {
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
		inflight.set(m.message_id, {
			chatId: `meego-${card.workItemId}`,
			chatMode: "meego",
			label: `飞书项目 · ${card.senderName}`,
			text: card.comment.slice(0, 300),
			since: now(),
		});
		byItem.set(card.workItemId, [...(byItem.get(card.workItemId) ?? []), msg]);
	}
	markHandled(skip);
	for (const [wid, list] of byItem) {
		log(
			"待起草（飞书项目）",
			wid,
			list.map((m) => m.message_id),
		);
		startDraft({ chat_id: `meego-${wid}`, chat_mode: "meego", name: (list.at(-1)!.meego as any).workItemTitle }, list);
	}
}

let stopped = false;
let wake: (() => void) | undefined;

export async function pollForever() {
	// 首次启动从现在开始；停机太久不补：最多回看 30 分钟，避免一次涌出大量草稿
	let since = Math.max(getKv("poll_since", now()), now() - 1800);
	log(`草稿轮询启动，回看到 ${new Date(since * 1000).toLocaleString("sv-SE")}`);
	let authWarned = false;
	// oxlint-disable-next-line no-unmodified-loop-condition -- stopped 由 stopPolling 在别处修改
	while (!stopped) {
		const started = now();
		try {
			await pollOnce(since);
			if (MEEGO_ENABLED) {
				await pollMeego(since);
				await expireMeegoDrafts();
			}
			since = started;
			setKv("poll_since", since);
			authWarned = false;
		} catch (e) {
			// 没授权时不推进 since，授权后从停下的地方继续
			if (e instanceof UserAuthError) {
				if (!authWarned) log("轮询暂停：", e.message);
				authWarned = true;
			} else log("轮询失败", e);
		}
		db()
			.delete(schema.handled)
			.where(lt(schema.handled.at, now() - 3 * 86400))
			.run();
		await new Promise<void>((r) => {
			wake = r;
			setTimeout(r, POLL_INTERVAL * 1000);
		});
	}
}

export function stopPolling() {
	stopped = true;
	wake?.();
}

export const lastPoll = () => getKv<number | null>("poll_since", null);
