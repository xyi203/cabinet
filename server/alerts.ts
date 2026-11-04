// 告警批处理：群里机器人 @Yi 的消息不起草回复，按群攒一批，交给 alert agent 一起看，结论私聊给 Yi（docs/pipeline.md §4）。
// - 一批从第一条起算：ALERT_QUIET 秒没有新告警、或者满 ALERT_MAX_WAIT 秒就收口
// - 一批就是一个只读 agent 任务（dev.ts 的 dispatch）：看板上能看到，每轮私聊 Yi，引用通知可以追问，「完成」归档
// - 同一个群 ALERT_FOLLOW 秒内又来一批、上一批的任务还没归档：并进上一批的会话（运行中插话，空闲开新一轮）
// - 攒着的批存在 kv 的 pending:alert:*，重启后接着攒；收口时才把消息记成已处理
import { ALERT_AGENT, ALERT_FOLLOW, ALERT_MAX_WAIT, ALERT_QUIET, ALERT_SENDERS, BOT_OPEN_ID, OWNER_NAME, OWNER_OPEN_ID } from "./config.ts";
import { deleteKv, getKv, listKv, setKv } from "./db/index.ts";
import { dispatch, getDevTask, messageDev } from "./dev.ts";
import type { ChatRef } from "./drafts/store.ts";
import { formatMessages } from "./lark/bot.ts";
import type { Message } from "./lark/types.ts";
import { decide, receive } from "./pipeline.ts";
import { log, now } from "./util.ts";

/** 每条告警交给模型的长度上限；一批的总长上限，超出的保留最新的 */
const PER_ALERT = 1500;
const PER_BATCH = 20_000;

/** 机器人发的、@了 Yi 的群消息就是告警（卡片里的 @ 渲染成 @名字，mentions 里也有） */
export function isAlert(chat: Pick<ChatRef, "chat_mode">, m: Message): boolean {
	if (chat.chat_mode === "p2p" || m.sender.sender_type === "user" || m.sender.id === BOT_OPEN_ID) return false;
	if (ALERT_SENDERS.size && !ALERT_SENDERS.has(m.sender.id)) return false;
	return m.mentions.some((x) => x.id === OWNER_OPEN_ID) || m.content.includes(`@${OWNER_NAME}`);
}

interface Batch {
	chat: ChatRef;
	msgs: Message[];
	/** 第一条进批的时间（秒），满 ALERT_MAX_WAIT 收口 */
	first: number;
}

const batches = new Map<string, Batch>();
const timers = new Map<string, NodeJS.Timeout>();
const pendingKey = (chatId: string) => `pending:alert:${chatId}`;
const taskKey = (chatId: string) => `alert-task:${chatId}`;

/** 已经在批里的消息：轮询回看会再读到它们 */
export const batching = (messageId: string) => [...batches.values()].some((b) => b.msgs.some((m) => m.message_id === messageId));

/** 攒着的批，Watchdog 用来发现没收口的 */
export const batchesSnapshot = () => [...batches.values()].map((b) => ({ chatId: b.chat.chat_id, name: b.chat.name, first: b.first }));

type OnDone = (ids: string[]) => void;
let onDone: OnDone = () => {};

/** 收进一条告警；返回什么时候收口（秒），测试用 */
export function addAlert(chat: ChatRef, m: Message, done?: OnDone): number {
	if (done) onDone = done;
	const b = batches.get(chat.chat_id) ?? { chat, msgs: [], first: now() };
	if (!b.msgs.some((x) => x.message_id === m.message_id)) b.msgs.push(m);
	batches.set(chat.chat_id, b);
	setKv(pendingKey(chat.chat_id), b);
	return schedule(chat.chat_id);
}

function schedule(chatId: string): number {
	const b = batches.get(chatId)!;
	const at = Math.min(now() + ALERT_QUIET, b.first + ALERT_MAX_WAIT);
	clearTimeout(timers.get(chatId));
	const t = setTimeout(() => void flush(chatId), Math.max(0, at - now()) * 1000);
	t.unref();
	timers.set(chatId, t);
	return at;
}

export function alertText(msgs: Message[]): string {
	const text = formatMessages(
		msgs.map((m) => ({ ...m, content: m.content.length > PER_ALERT ? `${m.content.slice(0, PER_ALERT)}…（截断）` : m.content })),
	);
	return text.length > PER_BATCH ? `（更早的告警省略）\n${text.slice(-PER_BATCH)}` : text;
}

/** 上一批的任务还开着（没归档、没放弃），而且最近还在动：新告警并进去 */
function openTask(chatId: string) {
	const id = getKv<string | null>(taskKey(chatId), null);
	const t = id ? getDevTask(id) : undefined;
	if (!t || t.status === "done" || t.status === "discarded") return undefined;
	return now() - t.updated <= ALERT_FOLLOW ? t : undefined;
}

/** 收口：这一批记成 trigger，一次分派给 alert agent */
export async function flush(chatId: string) {
	const b = batches.get(chatId);
	clearTimeout(timers.get(chatId));
	timers.delete(chatId);
	if (!b) return;
	batches.delete(chatId);
	const ids = b.msgs.map((m) => m.message_id);
	const triggers = b.msgs.map((m) =>
		receive({
			channel: "alert",
			externalId: m.message_id,
			thread: `alert:${chatId}`,
			actorId: m.sender.id,
			actorName: m.sender.name,
			text: m.content,
			at: m.create_time / 1000,
		}),
	);
	const n = b.msgs.length;
	const text = `群「${b.chat.name}」里机器人 @${OWNER_NAME} 的 ${n} 条告警：\n${alertText(b.msgs)}`;
	try {
		const open = openTask(chatId);
		if (open) {
			decide(triggers, { agent: ALERT_AGENT, rule: `告警续批（${n} 条）`, actionKind: "command", actionId: open.id });
			await messageDev(open.id, `又来了一批。${text}`, "告警");
			log("告警并进上一批", chatId, open.id, n);
		} else {
			const t = await dispatch({
				agent: ALERT_AGENT,
				request: text,
				title: `告警 · ${b.chat.name} · ${n} 条`,
				triggers,
				rule: `告警批（${n} 条）`,
				notify: true,
			});
			setKv(taskKey(chatId), t.id);
			log("告警成批", chatId, t.id, n);
		}
	} catch (e) {
		// 分派不出去（比如 agents.json 里没有 alert agent）：只记日志，不重试，免得每次轮询都刷一遍
		log("告警批处理失败", chatId, n, e);
	} finally {
		deleteKv(pendingKey(chatId));
		onDone(ids);
	}
}

/** 启动时接回上次进程攒了一半的批 */
export function resumePendingAlerts(done: OnDone) {
	onDone = done;
	for (const { value } of listKv<Batch>("pending:alert:")) {
		batches.set(value.chat.chat_id, value);
		log("接回攒着的告警", value.chat.chat_id, value.msgs.length);
		schedule(value.chat.chat_id);
	}
}

/** 退出时不收口：攒着的批已经在 kv 里，下次启动接着攒 */
export function stopAlerts() {
	for (const t of timers.values()) clearTimeout(t);
	timers.clear();
}
