// Router：所有进来的事件先到这里，判断这是哪件事、交给谁（docs/router-worker.md §3、docs/flow.md §3）。
// 渠道只负责把消息拉回来（lark 轮询、meego 轮询、机器人长连接），这里按固定顺序判断：
//   去重 → 过滤（告警、Yi 自己发的、不是找 Yi 的）→ 指令（记住、回复任务通知、草稿指令）→ 交给对应的执行模块
// 归属（追加到已有的事）在 pipeline.decide → taskstore.assignTask 里做；攒批在 alerts.ts；分诊在 drafts/make.ts 的 route()。
// 看板派活、定时任务见 router/board.ts。执行（起草、问答、告警批、agent 任务）仍在各自模块；每次判断都经 decide() 落库，就是路由记录
import { addAlert, batching, isAlert } from "../alerts.ts";
import { ALERT_ENABLED, OWNER_OPEN_ID } from "../config.ts";
import { asksYi } from "../drafts/context.ts";
import { abortIfYiReplied, makeDraft } from "../drafts/make.ts";
import { expireDrafts } from "../drafts/replied.ts";
import { type ChatRef, inflight } from "../drafts/store.ts";
import { isHandled, markHandled } from "../handled.ts";
import type { BotEvent, Message } from "../lark/types.ts";
import { decide } from "../pipeline.ts";
import { accept, answer, botTrigger, devReply, draftCommand, firstSeen, remember, stripMentions } from "../qa.ts";
import { devTaskOfDm } from "../dev.ts";
import { watchTopic } from "../topics.ts";
import { log, now } from "../util.ts";

export { cronSkip, routeBoard } from "./board.ts";

/** 交给起草：先记进 inflight（看板「排队」能看到），起草完记成已处理 */
export function routeDraft(chat: ChatRef, msgs: Message[]) {
	if (!msgs.length) return;
	log(
		chat.chat_mode === "meego" ? "待起草（飞书项目）" : "待起草",
		chat.chat_id,
		msgs.map((m) => m.message_id),
	);
	void makeDraft(chat, msgs, markHandled);
}

/** 起草排队里显示的那一行 */
function queue(chat: ChatRef, m: Message, label: string, text: string) {
	inflight.set(m.message_id, { chatId: chat.chat_id, chatMode: chat.chat_mode, label, text: text.slice(0, 300), since: now() });
}

/**
 * 一个会话轮询到的一批消息（飞书私聊、群）：
 * 处理过的、在排队的、在攒批的、撤回的跳过；机器人 @Yi 的进告警攒批；找 Yi 的交给起草；
 * 其余记成已处理，其中 Yi 自己发的会作废已有草稿、中止正在起草的（他亲自回了）
 */
export function routeChat(chat: ChatRef, msgs: Message[]) {
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
			// 群里找 Yi 的：之后话题里的回复会话列表里看不到，开始盯它的话题（topics.ts）
			watchTopic(chat, m);
			queue(chat, m, chat.chat_mode === "p2p" ? m.sender.name : `${chat.name} · ${m.sender.name}`, m.content);
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
	routeDraft(chat, fresh);
}

/** 飞书项目评论：渠道已经解析好、只留了 @Yi 的；同一工作项的一批交给起草 */
export function routeMeego(chat: ChatRef, msgs: Message[]) {
	for (const m of msgs) queue(chat, m, `飞书项目 · ${m.sender.name}`, m.content);
	routeDraft(chat, msgs);
}

/** 机器人长连接收到的消息：只认 Yi 私聊机器人；「记住」→ 指令（回复任务通知、草稿指令）→ 问答 */
export function routeBot(ev: BotEvent) {
	if (!ev.messageId || !firstSeen(ev.messageId) || !accept(ev)) return;
	log("收到", ev.chatId, ev.messageId, stripMentions(ev).slice(0, 80));
	void dispatchBot(ev);
}

async function dispatchBot(ev: BotEvent) {
	const text = stripMentions(ev);
	if (!text) return;
	const tid = botTrigger(ev, text);
	if (text.startsWith("记住")) return remember(ev, text, tid);
	if (ev.chatType === "p2p" && ev.senderId === OWNER_OPEN_ID) {
		// 引用了 agent 任务的通知：这条就是发给那个任务的
		const devId = devTaskOfDm(ev.parentId ?? ev.rootId);
		if (devId) {
			decide([tid], { rule: "回复 agent 任务", actionKind: "command", actionId: devId });
			return devReply(ev, devId, text);
		}
		if (await draftCommand(ev, text, tid)) return;
	}
	return answer(ev);
}
