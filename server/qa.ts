// @机器人 的问答：一个 @ 开一个话题，主消息的 message_id 就是会话 key，话题内后续消息的 root_id 指回它，
// 所以 key = root_id ?? message_id，话题和 pi 会话一一对应。Yi 私聊机器人时还能处理草稿指令。
import { BOT_OPEN_ID, CHATS, COMMON_EMOJI, DEFAULT_CWD, OWNER_NAME, OWNER_OPEN_ID, THREAD_CONTEXT_N } from "./config.ts";
import { type Action, DraftError, type Kind, LIVE, applyDraftAction, listStickers, pickDraft } from "./drafts.ts";
import { locks, sem } from "./agent/slots.ts";
import { LarkError, quotedMessage, react, replyAsBot, threadContext, unreact } from "./lark/bot.ts";
import type { BotEvent } from "./lark/types.ts";
import { record } from "./records.ts";
import { runPi } from "./agent/driver.ts";
import { closeTask, devTaskOfDm, discardDev, messageDev, pushDev, stopDev } from "./dev.ts";
import { deleteKv, listKv, setKv } from "./db/index.ts";
import { enqueueMemory } from "./memory/extract.ts";
import { rememberStatement } from "./memory/remember.ts";
import { MemoryError } from "./memory/store.ts";
import { isStopping, log, now } from "./util.ts";

const seen = new Set<string>();

/** 长连接偶尔重推同一事件 */
function firstSeen(id: string) {
	if (seen.has(id)) return false;
	seen.add(id);
	if (seen.size > 2000) seen.delete(seen.values().next().value!);
	return true;
}

export function accept(ev: BotEvent): boolean {
	if (ev.senderType !== "user" || ev.senderId === BOT_OPEN_ID) return false;
	if (ev.chatType === "p2p") return ev.senderId === OWNER_OPEN_ID;
	if (!(ev.chatId in CHATS)) return false;
	// @所有人 也会推给机器人，必须确认 mentions 里有机器人本身
	return ev.mentions.some((m) => m.id === BOT_OPEN_ID);
}

export function stripMentions(ev: Pick<BotEvent, "content" | "mentions">) {
	let text = ev.content;
	for (const m of ev.mentions) {
		if (m.key) text = text.split(m.key).join("");
		if (m.name) text = text.split(`@${m.name}`).join("");
	}
	return text.trim();
}

const reply = (ev: BotEvent, text: string) =>
	replyAsBot(ev.messageId, ev.chatType === "p2p" ? text : `<at user_id="${ev.senderId}"></at> ${text}`, {
		inThread: ev.chatType === "group",
		uuid: `r-${ev.messageId}`,
	});

async function buildPrompt(ev: BotEvent, text: string) {
	const parts = [`[飞书${ev.chatType === "p2p" ? "私聊" : "群聊"}] 提问人 open_id: ${ev.senderId}`];
	if (ev.rootId && THREAD_CONTEXT_N > 0) {
		const ctx = await threadContext(ev.threadId ?? ev.rootId, THREAD_CONTEXT_N);
		if (ctx) parts.push(`话题里最近的消息（仅供参考，可能包含已回答过的问题）：\n${ctx}`);
	}
	if (ev.parentId && ev.parentId !== ev.rootId) {
		const quoted = await quotedMessage(ev.parentId);
		if (quoted) parts.push(`被引用的消息：\n${quoted}`);
	}
	parts.push(`当前问题（只回答这一条）：\n${text}`);
	return parts.join("\n\n");
}

async function remember(ev: BotEvent, text: string) {
	const content = text.replace(/^记住[:：,，\s]*/, "").trim();
	if (ev.senderId !== OWNER_OPEN_ID) return void (await reply(ev, `写入记忆需要${OWNER_NAME}确认，可以请${OWNER_NAME}来说「记住 …」。`));
	if (!content) return void (await reply(ev, "要记住什么？用法：记住 xxx"));
	// 只有 Yi 能写；正文就是他的原话，模型只帮着分类，群里的提示词注入写不进长期记忆
	let m;
	try {
		m = await rememberStatement(content, ev.messageId);
	} catch (e) {
		if (e instanceof MemoryError) return void (await reply(ev, `没记下：${e.message}。`));
		throw e;
	}
	await react(ev.messageId, "DONE");
	if (m.application === "convention") await reply(ev, `记成长期约定 #${m.id}，适用：${m.appliesWhen}。不对的话在看板「记忆」里改。`);
	record({ kind: "qa", status: "remembered", source: ev.messageId, chatId: ev.chatId, question: content, label: "记忆" });
}

const DRAFT_CMD = /^(发|不发|改|表情包|表情|完成|已处理)(?:$|[\s:：,，]+([\s\S]*))/;

/** Yi 私聊机器人的草稿指令；返回 false 表示不是指令，当普通问题处理 */
async function draftCommand(ev: BotEvent, text: string): Promise<boolean> {
	const m = DRAFT_CMD.exec(text);
	if (!m) return false;
	const cmd = m[1];
	const opinion = (m[2] ?? "").trim();
	// 「建议不回复」的草稿没有可发内容，不引用时「发」不该落到它头上
	const d = pickDraft(ev.parentId ?? ev.rootId, cmd === "发" ? ["pending"] : LIVE);
	if (!d) {
		if (["改", "表情", "表情包"].includes(cmd)) return false;
		await reply(ev, "没有待处理的草稿。");
		return true;
	}
	if (cmd === "改" && !opinion) {
		await reply(ev, "怎么改？用法：改 <意见>");
		return true;
	}
	if ((cmd === "表情" || cmd === "表情包") && !opinion) {
		const stickers = listStickers();
		await reply(
			ev,
			cmd === "表情"
				? `用法：表情 <类型>，常用：${COMMON_EMOJI.join(", ")}`
				: `用法：表情包 <名字>，可用：${stickers.length ? stickers.join(", ") : "目录里还没有表情包"}`,
		);
		return true;
	}
	const rid = cmd === "改" ? await react(ev.messageId, "OnIt") : undefined;
	try {
		const action: Action =
			({ 发: "send", 不发: "discard", 改: "revise", 完成: "complete", 已处理: "complete" } as const)[cmd as "发"] ?? "send";
		const kind: Kind = cmd === "表情" ? "reaction" : cmd === "表情包" ? "sticker" : "text";
		await applyDraftAction(d.id, action, cmd === "发" ? "" : opinion, kind);
		await react(ev.messageId, action === "send" ? "DONE" : "OK");
	} catch (e) {
		if (e instanceof DraftError) await reply(ev, `${e.message}。`);
		else {
			log("草稿指令失败", cmd, d.id, e);
			await reply(ev, e instanceof LarkError ? `「${cmd}」没有执行成功：${e.message}` : `「${cmd}」没有执行成功，详情见日志。`);
		}
	} finally {
		await unreact(ev.messageId, rid);
	}
	return true;
}

/** Yi 在飞书里引用开发任务通知回复：推送 / 停止 / 放弃，其余原样转给 agent */
async function devReply(ev: BotEvent, id: string, text: string) {
	try {
		if (text === "推送") return void (await reply(ev, `已推送：${(await pushDev(id)) || "MR 已更新"}`));
		if (text === "停止") {
			await stopDev(id);
			return void (await react(ev.messageId, "OK"));
		}
		if (text === "完成") {
			closeTask(id);
			return void (await react(ev.messageId, "DONE"));
		}
		if (text === "放弃") {
			await discardDev(id);
			return void (await react(ev.messageId, "OK"));
		}
		const mode = await messageDev(id, text);
		await react(ev.messageId, mode === "steered" ? "OnIt" : "Get");
	} catch (e) {
		log("开发任务回复失败", id, e);
		await reply(ev, `${(e as Error).message}。`);
	}
}

export async function handle(ev: BotEvent, attempt?: string) {
	const text = stripMentions(ev);
	if (!text) return;
	if (text.startsWith("记住")) return remember(ev, text);
	if (ev.chatType === "p2p" && ev.senderId === OWNER_OPEN_ID) {
		// 引用了开发任务的通知：这条就是发给 dev agent 的
		const devId = devTaskOfDm(ev.parentId ?? ev.rootId);
		if (devId) return devReply(ev, devId, text);
		if (await draftCommand(ev, text)) return;
	}
	const key = ev.rootId ?? ev.messageId;
	const cwd = CHATS[ev.chatId] ?? DEFAULT_CWD;
	const label = ev.chatType === "p2p" ? "私聊机器人" : `群 ${ev.chatId.slice(-6)}`;
	const started = now();
	const rid = await react(ev.messageId, "OnIt");
	const pendingKey = `pending:qa:${ev.messageId}`;
	setKv(pendingKey, { ev, attempt });
	let interrupted = false;
	await locks.run(key, () =>
		sem.run(async () => {
			try {
				const { text: answer, usage } = await runPi({
					cwd,
					sessionId: key,
					requestId: `qa:${ev.messageId}${attempt ? `:${attempt}` : ""}`,
					prompt: await buildPrompt(ev, text),
					label,
					memory: { query: text, scope: { personId: ev.senderId === OWNER_OPEN_ID ? undefined : ev.senderId, chatId: ev.chatId } },
				});
				await reply(ev, answer);
				await unreact(ev.messageId, rid);
				await react(ev.messageId, "DONE");
				record({
					kind: "qa",
					status: "replied",
					source: ev.messageId,
					chatId: ev.chatId,
					session: key,
					label,
					seconds: now() - started,
					usage,
					question: text,
					answer,
				});
				enqueueMemory({
					type: "qa",
					messageId: ev.messageId,
					session: key,
					chatId: ev.chatId,
					askerId: ev.senderId,
					askerName: ev.senderId === OWNER_OPEN_ID ? OWNER_NAME : ev.senderId,
					question: text,
					answer,
					start: started,
					end: now(),
				});
			} catch (e) {
				// 退出时被打断：不打叉、不记失败，留着待接回标记
				if (isStopping()) {
					interrupted = true;
					return;
				}
				// 失败只记日志、打叉，不把报错原文发进群
				log("处理失败", ev.messageId, e);
				await unreact(ev.messageId, rid);
				await react(ev.messageId, "CrossMark");
				record({
					kind: "qa",
					status: "failed",
					source: ev.messageId,
					chatId: ev.chatId,
					session: key,
					label,
					seconds: now() - started,
					error: String((e as Error).message),
					question: text,
					retry: ev,
				});
			} finally {
				if (!interrupted) deleteKv(pendingKey);
			}
		}),
	);
}

/** 启动时接回上次进程没答完的 @机器人 */
export function resumePendingQa() {
	for (const { value } of listKv<{ ev: BotEvent; attempt?: string }>("pending:qa:")) {
		log("接回未完成的问答", value.ev.chatId, value.ev.messageId);
		firstSeen(value.ev.messageId);
		void handle(value.ev, value.attempt);
	}
}

export function onBotEvent(ev: BotEvent) {
	if (!ev.messageId || !firstSeen(ev.messageId) || !accept(ev)) return;
	log("收到", ev.chatId, ev.messageId, stripMentions(ev).slice(0, 80));
	void handle(ev);
}
