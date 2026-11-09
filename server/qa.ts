// @机器人 的问答：一个 @ 开一个话题，主消息的 message_id 就是会话 key，话题内后续消息的 root_id 指回它，
// 所以 key = root_id ?? message_id，话题和 pi 会话一一对应。Yi 私聊机器人时还能处理草稿指令。
import { BOT_OPEN_ID, COMMON_EMOJI, DEFAULT_CWD, OWNER_NAME, OWNER_OPEN_ID, THREAD_CONTEXT_N } from "./config.ts";
import { type Action, applyDraftAction } from "./drafts/actions.ts";
import { emojiName } from "./drafts/card.ts";
import { type Kind, listStickers } from "./drafts/format.ts";
import { DraftError, LIVE, getDraft, pickDraft } from "./drafts/store.ts";
import { locks, sem } from "./agent/slots.ts";
import { LarkError, quotedMessage, react, replyAsBot, threadContext, unreact } from "./lark/bot.ts";
import type { BotEvent } from "./lark/types.ts";
import { decide, openRoute, receive, settle } from "./pipeline.ts";
import { record } from "./records.ts";
import { forgetRun, runPi } from "./agent/driver.ts";
import { ASSISTANT, TASK_TIER, loadAgents, withTier } from "./agent/router.ts";
import { closeTask, discardDev, messageDev, pushDev, stopDev } from "./dev.ts";
import { deleteKv, listKv, setKv } from "./db/index.ts";
import { enqueueMemory } from "./memory/extract.ts";
import { rememberStatement } from "./memory/remember.ts";
import { MemoryError } from "./memory/store.ts";
import { isStopping, log, now } from "./util.ts";

const seen = new Set<string>();

/** 长连接偶尔重推同一事件（router 判去重、接回时标记） */
export function firstSeen(id: string) {
	if (seen.has(id)) return false;
	seen.add(id);
	if (seen.size > 2000) seen.delete(seen.values().next().value!);
	return true;
}

export function accept(ev: BotEvent): boolean {
	if (ev.senderType !== "user" || ev.senderId === BOT_OPEN_ID) return false;
	// 只认 Yi 私聊机器人；群里 @机器人问答已下线（docs/redesign.md）
	return ev.chatType === "p2p" && ev.senderId === OWNER_OPEN_ID;
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

export async function remember(ev: BotEvent, text: string, tid: string) {
	const content = text.replace(/^记住[:：,，\s]*/, "").trim();
	const routeId = decide([tid], { rule: "记住", actionKind: "remember", actionId: ev.messageId });
	if (ev.senderId !== OWNER_OPEN_ID) return void (await reply(ev, `写入记忆需要${OWNER_NAME}确认，可以请${OWNER_NAME}来说「记住 …」。`));
	if (!content) return void (await reply(ev, "要记住什么？例如：记住 周报周五下午发"));
	// 只有 Yi 能写；正文就是他的原话，模型只帮着分类，群里的提示词注入写不进长期记忆
	// 引用了草稿卡片说的「记住」：可以只对那条消息的发送人或那个会话生效
	const d = ev.parentId ? getDraft(ev.parentId) : undefined;
	const candidates = d
		? {
				person: d.chatMode === "meego" ? undefined : { id: d.senderId, name: d.senderName },
				chat: { id: d.chatId, name: d.chatMode === "p2p" ? `和 ${d.senderName} 的私聊` : d.chatName },
			}
		: undefined;
	let m;
	try {
		m = await rememberStatement(content, ev.messageId, candidates);
	} catch (e) {
		if (e instanceof MemoryError) {
			settle({ actionKind: "remember", actionId: ev.messageId, routeId, outcome: "failed", effect: "internal", detail: e.message });
			return void (await reply(ev, `没记下：${e.message}。`));
		}
		throw e;
	}
	await react(ev.messageId, "DONE");
	settle({ actionKind: "remember", actionId: ev.messageId, routeId, outcome: "remembered", effect: "internal", ref: `memory:${m.id}` });
	const scope = m.scope.startsWith("person:")
		? `，只在和 ${m.scopeName} 有关时用`
		: m.scope.startsWith("chat:")
			? `，只在「${m.scopeName}」里用`
			: "";
	if (m.application === "convention") await reply(ev, `记住了，以后照做。适用：${m.appliesWhen}${scope}。不对的话到看板「记忆」里改。`);
	else if (scope) await reply(ev, `记住了${scope}。不对的话到看板「记忆」里改。`);
	record({ kind: "qa", status: "remembered", source: ev.messageId, chatId: ev.chatId, question: content, label: "记忆" });
}

const DRAFT_CMD = /^(发送|发|不回复|不发|改写|改|表情包|表情|完成|已处理)(?:$|[\s:：,，]+([\s\S]*))/;
// 卡片和提示里写的是看板的动词（发送 / 不回复 / 改写），老的短指令照样认
const CMD_ALIAS: Record<string, string> = { 发送: "发", 不回复: "不发", 改写: "改" };

/** Yi 私聊机器人的草稿指令；返回 false 表示不是指令，当普通问题处理 */
export async function draftCommand(ev: BotEvent, text: string, tid: string): Promise<boolean> {
	const m = DRAFT_CMD.exec(text);
	if (!m) return false;
	const cmd = CMD_ALIAS[m[1]] ?? m[1];
	const opinion = (m[2] ?? "").trim();
	// 「建议不回复」的草稿没有可发内容，不引用时「发」不该落到它头上
	const d = pickDraft(ev.parentId ?? ev.rootId, cmd === "发" ? ["pending"] : LIVE);
	if (!d) {
		if (["改", "表情", "表情包"].includes(cmd)) return false;
		await reply(ev, "没有等你处理的草稿。");
		return true;
	}
	decide([tid], { rule: `草稿指令：${cmd}`, actionKind: "command", actionId: d.id });
	if (cmd === "改" && !opinion) {
		await reply(ev, "想怎么改？例如：改写 语气软一点");
		return true;
	}
	if ((cmd === "表情" || cmd === "表情包") && !opinion) {
		const stickers = listStickers();
		await reply(
			ev,
			cmd === "表情"
				? `回哪个表情？例如：表情 赞。常用的有：${COMMON_EMOJI.map(emojiName).join("、")}`
				: stickers.length
					? `发哪个表情包？例如：表情包 ${stickers[0]}。可用的有：${stickers.join("、")}`
					: "还没有表情包，把图片放进 data/stickers/ 就能用",
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
export async function devReply(ev: BotEvent, id: string, text: string) {
	try {
		if (text === "推送") {
			const url = await pushDev(id);
			return void (await reply(ev, url ? `已推送：${url}` : "已推送，MR 已更新"));
		}
		if (text === "停止") {
			await stopDev(id);
			return void (await react(ev.messageId, "OK"));
		}
		if (text === "完成") {
			await closeTask(id);
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

/** 发给机器人的消息就是 trigger（accept() 已经做过程序规则）；同一条重复记只记一次 */
export function botTrigger(ev: BotEvent, text = stripMentions(ev)): string {
	const key = ev.rootId ?? ev.messageId;
	return receive({
		channel: "bot",
		externalId: ev.messageId,
		thread: `bot:${ev.chatId}#${key}`,
		actorId: ev.senderId,
		owner: ev.senderId === OWNER_OPEN_ID,
		text,
	});
}

/** 问答：router 判定不是「记住」、也不是指令之后交到这里；重启接回、手动重试也从这里进 */
export async function answer(ev: BotEvent, attempt?: string) {
	const text = stripMentions(ev);
	if (!text) return;
	const key = ev.rootId ?? ev.messageId;
	const tid = botTrigger(ev, text);
	const cwd = DEFAULT_CWD;
	// Yi 私聊直接问的：交给 assistant，按 deep 档查
	const agentName = loadAgents().router.agent ?? ASSISTANT;
	const agent = withTier(loadAgents().agents[agentName] ?? {}, TASK_TIER);
	const label = ev.chatType === "p2p" ? "私聊机器人" : `群 ${ev.chatId.slice(-6)}`;
	const started = now();
	// 重启接回、手动重试之外的重复到达沿用同一次分派
	const routeId =
		openRoute([tid], "qa")?.id ??
		decide([tid], { agent: "qa", rule: "@机器人问答", session: key, actionKind: "qa", actionId: ev.messageId });
	const rid = await react(ev.messageId, "OnIt");
	const pendingKey = `pending:qa:${ev.messageId}`;
	const requestId = `qa:${ev.messageId}${attempt ? `:${attempt}` : ""}`;
	setKv(pendingKey, { ev, attempt });
	let interrupted = false;
	await locks.run(key, () =>
		sem.run(async () => {
			try {
				const { text: answer, usage } = await runPi({
					cwd,
					sessionId: key,
					requestId,
					tier: "qa",
					prompt: await buildPrompt(ev, text),
					agent,
					agentName,
					origin: { label: "你私聊机器人的提问" },
					label,
					memory: { query: text, scope: { personId: ev.senderId === OWNER_OPEN_ID ? undefined : ev.senderId, chatId: ev.chatId } },
				});
				await reply(ev, answer);
				settle({ actionKind: "qa", actionId: ev.messageId, routeId, outcome: "replied", effect: "bot" });
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
				settle({
					actionKind: "qa",
					actionId: ev.messageId,
					routeId,
					outcome: "failed",
					effect: "internal",
					detail: String((e as Error).message),
				});
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
				if (!interrupted) {
					deleteKv(pendingKey);
					forgetRun(requestId);
				}
			}
		}),
	);
}

/** 启动时接回上次进程没答完的 @机器人 */
export function resumePendingQa() {
	for (const { value } of listKv<{ ev: BotEvent; attempt?: string }>("pending:qa:")) {
		log("接回未完成的问答", value.ev.chatId, value.ev.messageId);
		firstSeen(value.ev.messageId);
		void answer(value.ev, value.attempt);
	}
}
