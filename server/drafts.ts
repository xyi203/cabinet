// 代回复草稿：发现「私聊 Yi / 群里 @Yi / 飞书项目 @Yi」的新消息 -> 中台分派 agent 起草 -> 机器人私聊 Yi 草稿
// -> Yi 回「发 / 改 xxx / 不发」或在看板上操作 ->「发」时以 Yi 的身份发出。没有 Yi 的确认，什么都不会以他的名义发出。
import { and, desc, eq, inArray } from "drizzle-orm";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { changed } from "./bus.ts";
import { COMMON_EMOJI, EMOJI_ALIASES, EMOJI_TYPES, OWNER_OPEN_ID, PATHS } from "./config.ts";
import { db, deleteKv, listKv, schema, setKv } from "./db/index.ts";
import type { Draft, MeegoCard, Usage } from "./db/schema.ts";
import {
	type Message,
	formatMessages,
	getMessage,
	listMessages,
	reactAsUser,
	sendImageAsUser,
	sendTextAsUser,
	sendToUserAsBot,
	react,
} from "./lark/bot.ts";
import { loadAgents, mrBrief, resolveCwd, route, sessionKey } from "./hub.ts";
import { meegoContext, meegoYiReplied, sendMeegoComment } from "./meego.ts";
import { record } from "./records.ts";
import { runPi } from "./agent/driver.ts";
import { enqueueMemory } from "./memory/extract.ts";
import { KeyedLock, Semaphore, isStopping, log, now } from "./util.ts";
import { MAX_CONCURRENCY, DEFAULT_CWD } from "./config.ts";

export const sem = new Semaphore(MAX_CONCURRENCY);
export const locks = new KeyedLock();

export class DraftError extends Error {}

const NOTE_MARK = "【备注】";
const REPORT_MARK = "【评审报告】";
export const NO_REPLY_MARK = "【无需回复】";
const REACTION_MARK = "【表情】";
const STICKER_MARK = "【表情包】";
const STICKER_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

export type Kind = "text" | "reaction" | "sticker";
export const LIVE = ["pending", "noreply"];

export interface ChatRef {
	chat_id: string;
	chat_mode: string; // p2p / group / topic / meego
	name: string;
}

export interface Source {
	chatId: string;
	chatMode: string;
	chatName: string;
	replyTo: string;
	threadId?: string | null;
	senderId: string;
	senderName: string;
	text: string;
	context?: string;
	meego?: MeegoCard | null;
	agent?: string | null;
	session?: string | null;
	route?: string | null;
}

/** 起草中的消息：草稿推送完才记为已处理，进程中途退出时重启还能补上；起草期间下一轮轮询靠它去重 */
export interface Inflight {
	chatId: string;
	chatMode: string;
	label: string;
	text: string;
	since: number;
}
export const inflight = new Map<string, Inflight>();

// ---------- 草稿文本解析 ----------

/** 草稿 = 回复正文 + 【评审报告】（CR agent）+ 【备注】，后两段只给 Yi 看 */
export function splitNote(draft: string): { body: string; note: string; report: string } {
	let [body, note] = partition(draft, NOTE_MARK);
	let report: string;
	[body, report] = partition(body, REPORT_MARK);
	if (note.includes(REPORT_MARK)) [note, report] = partition(note, REPORT_MARK); // 模型把备注写在报告前面时
	return { body: body.trim(), note: note.trim(), report: report.trim() };
}

function partition(s: string, mark: string): [string, string] {
	const i = s.indexOf(mark);
	return i < 0 ? [s, ""] : [s.slice(0, i), s.slice(i + mark.length)];
}

export function listStickers(): string[] {
	if (!existsSync(PATHS.stickers)) return [];
	return readdirSync(PATHS.stickers, { withFileTypes: true })
		.filter((f) => f.isFile() && !f.name.startsWith(".") && STICKER_EXTS.has(path.extname(f.name).toLowerCase()))
		.map((f) => f.name)
		.toSorted();
}

export function resolveEmoji(name: string): string | undefined {
	name = name.trim();
	if (EMOJI_ALIASES[name]) return EMOJI_ALIASES[name];
	const lower = name.toLowerCase();
	return [...EMOJI_TYPES].find((e) => e.toLowerCase() === lower);
}

const stem = (f: string) => f.slice(0, f.length - path.extname(f).length);

/** 只认表情包目录里真实存在的文件，按文件名或去掉扩展名的名字匹配；防止借文件名读到目录外 */
export function resolveSticker(name: string): string | undefined {
	name = name.trim();
	const files = listStickers();
	const exact = files.find((f) => f === name || stem(f) === name);
	if (exact) return exact;
	const hits = files.filter((f) => name && stem(f).includes(name));
	return hits.length === 1 ? hits[0] : undefined;
}

/** 草稿正文 -> 形态和内容；不合法的表情退回文字 */
export function parseDraftBody(body: string): { kind: Kind; content: string } {
	if (body.startsWith(REACTION_MARK)) {
		const emoji = resolveEmoji(body.slice(REACTION_MARK.length).trim().split(/\s+/)[0] ?? "");
		if (emoji) return { kind: "reaction", content: emoji };
	}
	if (body.startsWith(STICKER_MARK)) {
		const sticker = resolveSticker(body.slice(STICKER_MARK.length));
		if (sticker) return { kind: "sticker", content: sticker };
	}
	return { kind: "text", content: body };
}

export const describeReply = (kind: string, content: string) =>
	kind === "reaction" ? `表情回复 \`${content}\`` : kind === "sticker" ? `表情包 \`${content}\`` : content;

export function stickerHint() {
	const stickers = listStickers();
	return `可用的表情回复（【表情】后写类型）：${COMMON_EMOJI.join(", ")}，也可以用飞书其他表情类型名。\n可用的表情包（【表情包】后写文件名）：${stickers.length ? stickers.join(", ") : "暂无，不要用表情包"}`;
}

export function draftLabel(s: { chatMode: string; chatName: string; senderName: string }) {
	if (s.chatMode === "meego") return `飞书项目 · ${s.senderName}`;
	return s.chatMode === "p2p" ? s.senderName : `${s.chatName} · ${s.senderName}`;
}

// ---------- 推送草稿 ----------

export function getDraft(id: string): Draft | undefined {
	return db().select().from(schema.drafts).where(eq(schema.drafts.id, id)).get();
}

function setStatus(id: string, status: string, extra: Partial<Draft> = {}) {
	db()
		.update(schema.drafts)
		.set({ status, ...extra })
		.where(eq(schema.drafts.id, id))
		.run();
	changed();
}

/** 原子地把草稿从可处理状态改成 to；飞书里回「发」和看板点发送同时到达时只有一个能拿到 */
function claim(id: string, from: string[], to: string): boolean {
	const r = db()
		.update(schema.drafts)
		.set({ status: to })
		.where(and(eq(schema.drafts.id, id), inArray(schema.drafts.status, from)))
		.run();
	return r.changes === 1;
}

const quote = (t: string) =>
	t
		.split("\n")
		.map((l) => `> ${l}`)
		.join("\n");

export async function pushDraft(source: Source, draft: string, replaces?: string): Promise<string> {
	const { body: rawBody, note, report } = splitNote(draft);
	const noReply = rawBody.startsWith(NO_REPLY_MARK);
	const { kind, content: body } = noReply ? { kind: "text" as Kind, content: rawBody } : parseDraftBody(rawBody);
	const where =
		source.chatMode === "p2p" ? "私聊" : source.chatMode === "meego" ? `飞书项目「${source.chatName}」@你` : `群「${source.chatName}」@你`;
	const parts = [`**${where}** · ${source.senderName}`];
	if (source.chatMode === "meego" && source.meego) parts.push(source.meego.url);
	// 只看 @ 那一条常常不知道在说什么：私聊草稿里带上相关前文的最后几行
	else if (source.context) parts.push(`前文：\n${quote(source.context.slice(-500))}`);
	parts.push(quote(source.text.slice(0, 600)));
	if (noReply) {
		parts.push(`建议不回复：${body.slice(NO_REPLY_MARK.length).trim()}`, "需要回复就回本条：`改 <要点>` / `表情 <类型>` / `表情包 <名字>`");
	} else {
		parts.push(`**草稿**\n${describeReply(kind, body)}`);
		if (report) parts.push(`**评审报告**（不会发出）\n${report}`);
		if (note) parts.push(`备注（不会发出）：${note}`);
		parts.push("回复本条：`发` / `改 <意见>` / `表情 <类型>` / `表情包 <名字>` / `完成` / `不发`");
	}
	const dmId = await sendToUserAsBot(OWNER_OPEN_ID, parts.join("\n\n"));
	db().transaction((tx) => {
		if (replaces) tx.update(schema.drafts).set({ status: "replaced" }).where(eq(schema.drafts.id, replaces)).run();
		tx.insert(schema.drafts)
			.values({
				id: dmId,
				...source,
				threadId: source.threadId ?? null,
				meego: source.meego ?? null,
				kind,
				draft: body,
				note,
				report,
				status: noReply ? "noreply" : "pending",
				created: now(),
			})
			.run();
	});
	changed();
	return dmId;
}

// ---------- 是否已亲自回复 ----------

/** Yi 的这条消息算不算回复了 msgs。私聊任何一句都算；群里要有明确指向 */
export function ownerReplyCovers(chatMode: string, m: Message, msgs: Array<Pick<Message, "message_id" | "thread_id" | "sender">>): boolean {
	if (chatMode === "p2p") return true;
	const ids = new Set(msgs.map((x) => x.message_id));
	const senders = new Set(msgs.map((x) => x.sender.id));
	const threads = new Set(msgs.map((x) => x.thread_id).filter(Boolean));
	return Boolean(
		(m.parent_id && ids.has(m.parent_id)) || m.mentions.some((x) => senders.has(x.id)) || (m.thread_id && threads.has(m.thread_id)),
	);
}

/** 起草前再看一眼：Yi 已经亲自回复了就不起草 */
export async function yiReplied(chat: ChatRef, msgs: Message[]): Promise<boolean> {
	const last = msgs.at(-1)!;
	if (chat.chat_mode === "meego") return meegoYiReplied(last.meego as MeegoCard);
	let recent: Message[];
	try {
		recent = await listMessages({ chatId: chat.chat_id }, { order: "desc", pageSize: 30 });
	} catch (e) {
		log("检查是否已回复失败", chat.chat_id, e);
		return false;
	}
	return ownerRepliedIn(chat.chat_mode, recent, msgs);
}

export function ownerRepliedIn(chatMode: string, recent: Message[], msgs: Message[]): boolean {
	const pos = new Map(recent.map((m) => [m.message_id, m.message_position]));
	const base = Math.max(0, ...msgs.map((m) => pos.get(m.message_id) ?? 0));
	const last = msgs.at(-1)!;
	return recent.some(
		(m) =>
			m.sender.id === OWNER_OPEN_ID &&
			ownerReplyCovers(chatMode, m, msgs) &&
			(m.message_position > base || Boolean(m.thread_id && m.thread_id === last.thread_id)),
	);
}

/** Yi 亲自回复了，之前没处理的草稿作废，免得重复回复。群里只作废这条消息明确指向的草稿 */
export function expireDrafts(chat: ChatRef, m: Message) {
	// 消息时间到毫秒，但起草也可能晚于回复：只作废回复之前创建的草稿
	const repliedAt = m.create_time / 1000;
	const live = db()
		.select()
		.from(schema.drafts)
		.where(and(eq(schema.drafts.chatId, chat.chat_id), inArray(schema.drafts.status, LIVE)))
		.all();
	for (const d of live) {
		if (d.created >= repliedAt + 60) continue;
		const src = [{ message_id: d.replyTo, thread_id: d.threadId ?? undefined, sender: { id: d.senderId, name: "", sender_type: "user" } }];
		if (ownerReplyCovers(chat.chat_mode, m, src) && claim(d.id, LIVE, "expired")) {
			log("草稿作废：Yi 已亲自回复", d.id);
			// Yi 没用草稿、自己回的那句，是最直接的口吻样本
			enqueueMemory({
				type: "draft",
				replyTo: d.replyTo,
				outcome: "expired",
				yiReply: { id: m.message_id, text: m.content, at: repliedAt },
			});
		}
	}
}

/** 飞书项目没有 Yi 自己评论的通知，只能对待确认的草稿逐条查评论 */
export async function expireMeegoDrafts() {
	const live = db()
		.select()
		.from(schema.drafts)
		.where(and(eq(schema.drafts.chatMode, "meego"), inArray(schema.drafts.status, LIVE)))
		.all();
	for (const d of live) {
		if (d.meego && (await meegoYiReplied(d.meego)) && claim(d.id, LIVE, "expired")) {
			changed();
			enqueueMemory({ type: "draft", replyTo: d.replyTo, outcome: "expired" });
			log("飞书项目草稿作废：Yi 已亲自评论", d.id);
		}
	}
}

// ---------- 上下文 ----------

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

function contextBlock(recent: string, related: string, text: string) {
	const parts = [`会话最近的消息（仅供参考）：\n${recent || "（无）"}`];
	if (related) parts.push(`和这条消息直接相关的前文（被回复的消息、所在话题、对方紧挨着发的消息）：\n${related}`);
	parts.push(`需要回复的新消息：\n${text}`);
	if (onlyMentions(text))
		parts.push("这条消息只有 @、没有正文：对方的意思在上面的前文里（多半是刚发的那几条），按前文判断要不要回、回什么，不要只当成打招呼。");
	return parts.join("\n\n");
}

// ---------- 起草 ----------

/**
 * attempt 区分手动重试：同一批消息默认用同一个 requestId，进程重启后重新提交会接回原来那次运行；
 * 手动重试要换一个，否则拿回的是上次失败的结果。
 */
export async function makeDraft(chat: ChatRef, msgs: Message[], onDone?: (ids: string[]) => void, attempt?: string) {
	// 起草中的任务记到库里：跑得久时轮询进度会越过这条消息，重启后靠它接回
	const pendingKey = `pending:draft:${msgs.at(-1)!.message_id}`;
	setKv(pendingKey, { chat, msgs, attempt });
	let interrupted = false;
	try {
		await _makeDraft(chat, msgs, attempt);
	} catch (e) {
		if (!isStopping()) throw e;
		interrupted = true;
	} finally {
		if (!interrupted) {
			deleteKv(pendingKey);
			onDone?.(msgs.map((m) => m.message_id));
		}
		for (const m of msgs) inflight.delete(m.message_id);
		changed();
	}
}

async function _makeDraft(chat: ChatRef, msgs: Message[], attempt?: string) {
	const last = msgs.at(-1)!;
	const source: Source = {
		chatId: chat.chat_id,
		chatMode: chat.chat_mode,
		chatName: chat.name ?? "",
		replyTo: last.message_id,
		threadId: last.thread_id,
		senderId: last.sender.id,
		senderName: last.sender.name || last.sender.id,
		text: msgs.map((m) => m.content).join("\n"),
		meego: (last.meego as MeegoCard) ?? null,
	};
	const label = draftLabel(source);
	const started = now();
	await locks.run(`draft-${chat.chat_id}`, () =>
		sem.run(async () => {
			if (await yiReplied(chat, msgs)) {
				log(
					"Yi 已亲自回复，跳过起草",
					chat.chat_id,
					msgs.map((m) => m.message_id),
				);
				record({
					kind: "draft",
					status: "skipped",
					chatId: chat.chat_id,
					source: source.replyTo,
					label,
					question: source.text,
					reason: "Yi 已亲自回复",
				});
				return;
			}
			try {
				let ctx: string;
				if (chat.chat_mode === "meego" && source.meego) {
					ctx = await meegoContext(source.meego);
					source.context = ctx.slice(-2000);
				} else {
					const { related, recent } = await gatherContext(chat.chat_id, msgs);
					source.context = related;
					ctx = contextBlock(recent, related, source.text);
				}
				const [name, info] = await route(source);
				const agent = loadAgents().agents[name] ?? {};
				const sid = sessionKey(name, agent, chat.chat_id, info);
				Object.assign(source, { agent: name, session: sid, route: info.rule });
				log("分派", chat.chat_id, "->", name, info.rule);
				let where: string;
				let hint: string;
				if (chat.chat_mode === "meego" && source.meego) {
					const mg = source.meego;
					ctx = `${ctx}\n\n需要回复的新评论：\n${source.text}`;
					where = `飞书项目「${source.chatName}」（${mg.url}）的评论里 @Yi`;
					hint =
						"这是飞书项目工作项下的评论，回复会以 Yi 的身份发成一条新评论，只能是文字，不要用【表情】【表情包】；" +
						`可以用 meegle 只读命令查更多信息，例如 \`meegle workitem get --project-key ${mg.projectKey} --work-item-id ${mg.workItemId}\`。`;
				} else {
					where = chat.chat_mode === "p2p" ? "私聊" : `群「${source.chatName}」里 @Yi`;
					hint = stickerHint();
				}
				const extra = info.mrIid
					? `\n\n要预审的 MR：项目 \`${info.mrProject}\`，iid \`${info.mrIid}\`。\nMR 概要（glab mr view）：\n${await mrBrief(info)}`
					: "";
				const prompt = `[代回复草稿] ${where}，来自 ${source.senderName}\n\n${ctx}${extra}\n\n${hint}\n\n请按草稿规则起草 Yi 的回复。`;
				const {
					text: draft,
					usage,
					sessionId,
				} = await runPi({
					cwd: resolveCwd(agent, info),
					sessionId: sid,
					requestId: `draft:${source.replyTo}${attempt ? `:${attempt}` : ""}`,
					prompt,
					extraSystem: [PATHS.draftRules],
					label,
					agent,
					agentName: name,
					chatId: chat.chat_id,
					memory: {
						// 只有 @ 的消息意思在前文里，召回也带上最后一段前文
						query: `${source.text}\n${(source.context ?? "").slice(-300)}`,
						scope: { personId: chat.chat_mode === "meego" ? undefined : source.senderId, chatId: chat.chat_id },
					},
				});
				source.session = sessionId;
				const dm = await pushDraft(source, draft);
				record({
					kind: "draft",
					status: "drafted",
					chatId: chat.chat_id,
					source: source.replyTo,
					dm,
					session: sessionId,
					agent: name,
					label,
					seconds: now() - started,
					usage,
					question: source.text,
					answer: draft,
				});
			} catch (e) {
				if (isStopping()) throw e;
				log("起草失败", chat.chat_id, e);
				record({
					kind: "draft",
					status: "failed",
					chatId: chat.chat_id,
					source: source.replyTo,
					session: source.session,
					agent: source.agent,
					label,
					seconds: now() - started,
					error: String((e as Error).message),
					question: source.text,
					retry: { chat, msgs },
				});
			}
		}),
	);
}

/** 启动时接回上次进程没起草完的消息 */
export function resumePendingDrafts(onDone: (ids: string[]) => void) {
	for (const { value } of listKv<{ chat: ChatRef; msgs: Message[]; attempt?: string }>("pending:draft:")) {
		const { chat, msgs, attempt } = value;
		log(
			"接回未完成的起草",
			chat.chat_id,
			msgs.map((m) => m.message_id),
		);
		for (const m of msgs)
			inflight.set(m.message_id, {
				chatId: chat.chat_id,
				chatMode: chat.chat_mode,
				label: draftLabel({ chatMode: chat.chat_mode, chatName: chat.name, senderName: m.sender.name }),
				text: m.content.slice(0, 300),
				since: now(),
			});
		void makeDraft(chat, msgs, onDone, attempt);
	}
}

// ---------- 发 / 不发 / 改 / 完成 ----------

async function sendDraft(d: Draft) {
	const uuid = `d-${d.id}`.slice(0, 50);
	if (d.chatMode === "meego") {
		if (d.kind !== "text") throw new DraftError("飞书项目评论只能回文字，表情和表情包发不了");
		// 早于这个字段的草稿没存发评人的 user_id：回头从通知卡片里取
		const larkId = d.meego!.senderLarkId ?? (await getMessage(d.replyTo).catch(() => undefined))?.userIds?.[d.senderName];
		return sendMeegoComment(d.meego!, d.senderName, d.draft, larkId);
	}
	// 表情回复直接加在对方那条消息上，不另发消息、不 @ 人
	if (d.kind === "reaction") return void (await reactAsUser(d.replyTo, d.draft));
	const target = d.chatMode === "p2p" ? { chatId: d.chatId } : { replyTo: d.replyTo, inThread: Boolean(d.threadId) };
	if (d.kind === "sticker") {
		const sticker = resolveSticker(d.draft);
		if (!sticker) throw new DraftError(`表情包 ${d.draft} 不在目录里了`);
		return void (await sendImageAsUser(target, path.join(PATHS.stickers, sticker), uuid));
	}
	const body = d.chatMode === "p2p" ? d.draft : `<at user_id="${d.senderId}"></at> ${d.draft}`;
	await sendTextAsUser(target, body, uuid);
}

export type Action = "send" | "discard" | "revise" | "complete";

/** 「发 / 不发 / 改 / 完成」的唯一实现，飞书私聊和看板共用。
 * send：arg 非空时用 (kind, arg) 替换草稿再发（看板里手改过的文字、指定的表情或表情包）；revise：arg 是修改意见 */
export async function applyDraftAction(id: string, action: Action, arg = "", kind: Kind = "text"): Promise<string> {
	arg = arg.trim();
	if (action === "send" && arg && kind !== "text") {
		const resolved = kind === "reaction" ? resolveEmoji(arg) : resolveSticker(arg);
		if (!resolved) throw new DraftError(`找不到${kind === "reaction" ? "表情" : "表情包"}「${arg}」`);
		arg = resolved;
	}
	const d = getDraft(id);
	if (!d) throw new DraftError("草稿不存在");
	if (!LIVE.includes(d.status)) throw new DraftError(`这条草稿已经是「${d.status}」状态，不再处理`);
	if (action === "send" && d.status === "noreply" && !arg)
		throw new DraftError("这条建议不回复，没有可发的草稿；需要回复请先改写或直接填写内容");
	if (action === "revise" && !arg) throw new DraftError("缺少修改意见");
	const busy = { send: "sending", revise: "revising", discard: "discarded", complete: "completed" }[action];
	if (!busy) throw new DraftError(`未知操作 ${action}`);
	if (!claim(id, LIVE, busy)) throw new DraftError("这条草稿正在被处理");
	changed();
	try {
		if (action === "send") {
			const toSend = arg ? { ...d, kind, draft: arg } : d;
			await sendDraft(toSend);
			setStatus(id, "sent", arg ? { kind, draft: arg } : {});
			void react(id, "DONE");
			record({ kind: "draft", status: "sent", dm: id, chatId: d.chatId, source: d.replyTo, answer: toSend.draft });
			enqueueMemory({ type: "draft", replyTo: d.replyTo, outcome: "sent" });
		} else if (action === "revise") {
			const agent = loadAgents().agents[d.agent ?? ""] ?? {};
			// 早于上下文功能的草稿没有存前文，改写时现补
			let context = d.context;
			if (!context && d.chatMode !== "meego") {
				const orig = await getMessage(d.replyTo).catch(() => undefined);
				if (orig) context = (await gatherContext(d.chatId, [orig])).related;
			}
			const started = now();
			const { text } = await locks.run(`draft-${d.chatId}`, () =>
				sem.run(() =>
					runPi({
						cwd: DEFAULT_CWD,
						sessionId: d.session,
						requestId: `revise:${id}`,
						// 附上原文和当前草稿，不依赖会话里还留着上一版（会话可能被压缩）
						prompt: `${context ? `相关前文：\n${context}\n\n` : ""}需要回复的消息：\n${d.text}\n\n当前草稿：\n${describeReply(d.kind, d.draft)}\n\n${stickerHint()}\n\nYi 的修改意见：${arg}\n\n请按意见重写，只输出新的草稿。`,
						extraSystem: [PATHS.draftRules],
						label: draftLabel(d),
						agent,
						agentName: d.agent ?? undefined,
						chatId: d.chatId,
						memory: {
							query: `${d.text}\n${arg}`,
							scope: { personId: d.chatMode === "meego" ? undefined : d.senderId, chatId: d.chatId },
						},
					}),
				),
			);
			const { id: _id, kind: _k, draft: _d, note: _n, report: _r, status: _s, created: _c, ...source } = d;
			await pushDraft({ ...source, context }, text, id);
			// 修改意见是 Yi 的原话，草稿走完时提取记忆要用；耗时用来圈出这次运行的工具调用
			record({
				kind: "draft",
				status: "revised",
				dm: id,
				chatId: d.chatId,
				source: d.replyTo,
				question: arg,
				seconds: now() - started,
				session: d.session,
			});
		} else {
			record({ kind: "draft", status: busy, dm: id, chatId: d.chatId, source: d.replyTo });
			enqueueMemory({ type: "draft", replyTo: d.replyTo, outcome: busy as "discarded" | "completed" });
		}
		return getDraft(id)!.status;
	} catch (e) {
		// 失败时退回原状态，可以再试
		if (action === "send" || action === "revise") claim(id, [busy], d.status);
		throw e;
	}
}

/** 引用了哪条草稿就操作哪条；没引用时只认最近 30 分钟内最新的一条 */
export function pickDraft(parent: string | undefined, statuses: string[]): Draft | undefined {
	if (parent) {
		const d = getDraft(parent);
		if (d) return d;
	}
	return db()
		.select()
		.from(schema.drafts)
		.where(inArray(schema.drafts.status, statuses))
		.orderBy(desc(schema.drafts.created))
		.limit(1)
		.all()
		.find((d) => now() - d.created < 1800);
}

export type { Usage };
