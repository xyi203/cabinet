// 草稿表的读写：状态原子切换（claim）、推送给 Yi、挑出要操作的那条；起草中的消息在内存里记一份
import { and, desc, eq, inArray } from "drizzle-orm";
import { changed } from "../bus.ts";
import { OWNER_OPEN_ID } from "../config.ts";
import { db, getKv, schema, setKv } from "../db/index.ts";
import type { Draft, MeegoCard } from "../db/schema.ts";
import { queuePatch, sendCardToUserAsBot, sendToUserAsBot } from "../lark/bot.ts";
import { log, now } from "../util.ts";
import { draftCard, where } from "./card.ts";
import { draftMrs } from "./mr.ts";
import { describeReply, type Kind, NO_REPLY_MARK, parseDraftBody, splitNote } from "./format.ts";

export class DraftError extends Error {}

export const LIVE = ["pending", "noreply"];

/** 表情、建议不回复这类草稿不私聊打扰 Yi，只上看板；没有私聊消息，id 用这个前缀加原消息 id */
export const QUIET_PREFIX = "quiet_";
export const isQuiet = (id: string) => id.startsWith(QUIET_PREFIX);

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
	routeId?: number | null;
}

/** 起草中的消息：草稿推送完才记为已处理，进程中途退出时重启还能补上；起草期间下一轮轮询靠它去重 */
export interface Inflight {
	chatId: string;
	chatMode: string;
	label: string;
	text: string;
	since: number;
	/** Yi 正在这个聊天里聊，等到这个时间再起草（见 make.ts waitIfYiActive）；看板上可以点「立即起草」跳过 */
	waitUntil?: number;
}
export const inflight = new Map<string, Inflight>();

export function getDraft(id: string): Draft | undefined {
	return db().select().from(schema.drafts).where(eq(schema.drafts.id, id)).get();
}

export function setStatus(id: string, status: string, extra: Partial<Draft> = {}) {
	db()
		.update(schema.drafts)
		.set({ status, ...extra })
		.where(eq(schema.drafts.id, id))
		.run();
	changed();
	syncCard(id);
}

/** 原子地把草稿从可处理状态改成 to；飞书里回「发」和看板点发送同时到达时只有一个能拿到 */
export function claim(id: string, from: string[], to: string): boolean {
	const r = db()
		.update(schema.drafts)
		.set({ status: to })
		.where(and(eq(schema.drafts.id, id), inArray(schema.drafts.status, from)))
		.run();
	if (r.changes !== 1) return false;
	syncCard(id);
	return true;
}

const cardKey = (id: string) => `draftcard:${id}`;

/**
 * 按草稿当前的状态重画它的卡片。状态在哪里变的都一样（卡片按钮、私聊指令、看板、Yi 亲自回复）。
 * 早于卡片的草稿是富文本消息，不更新。notice 是卡片顶上的一行提示（比如发送失败的原因）。
 */
export function syncCard(id: string, notice = "") {
	if (!getKv(cardKey(id), false)) return;
	queuePatch(id, () => {
		const d = getDraft(id);
		return d && draftCard(d, notice, draftMrs([d]).get(id));
	});
}

const quote = (t: string) =>
	t
		.split("\n")
		.map((l) => `> ${l}`)
		.join("\n");

/** 卡片发不出去时的退路：原来的富文本草稿，靠引用回复「发 / 改 / 不发」处理 */
function draftText(source: Source, kind: Kind, body: string, note: string, report: string, noReply: boolean) {
	const parts = [`**${where(source)}**`];
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
	return parts.join("\n\n");
}

/** 把草稿私聊给 Yi（一张可以直接操作的卡片），草稿 id 就是这条私聊的消息 id；replaces 是被改写掉的上一版 */
export async function pushDraft(source: Source, draft: string, replaces?: string): Promise<string> {
	const { body: rawBody, note, report } = splitNote(draft);
	const noReply = rawBody.startsWith(NO_REPLY_MARK);
	const { kind, content: body } = noReply ? { kind: "text" as Kind, content: rawBody } : parseDraftBody(rawBody);
	const row = {
		...source,
		threadId: source.threadId ?? null,
		meego: source.meego ?? null,
		kind,
		draft: body,
		note,
		report,
		status: noReply ? "noreply" : "pending",
		created: now(),
	};
	// 表情回复的草稿（没有评审报告的）不私聊打扰 Yi，只上看板（「待你处理」）；Yi 主动要求改写的结果总要私聊回给他。
	// 建议不回复的照样私聊：Yi 要确认一下是不是真的不用回
	// MR 预审即使回个表情也要私聊：评审报告和 approve / 发评论的按钮在卡片上
	const quiet = !replaces && kind === "reaction" && !report;
	let dmId: string;
	let isCard = !quiet;
	// 带时间后缀：同一条消息改写后又是表情时 id 不能撞上被替换的那条
	if (quiet) dmId = `${QUIET_PREFIX}${source.replyTo}_${Date.now().toString(36)}`;
	else
		try {
			dmId = await sendCardToUserAsBot(
				OWNER_OPEN_ID,
				draftCard(
					{ id: "", context: "", agent: null, session: null, route: null, ...row } as Draft,
					"",
					draftMrs([{ id: "", routeId: source.routeId ?? null }]).get(""),
				),
			);
		} catch (e) {
			// 卡片被平台拒了（结构不对、超长）也不能丢草稿：退回富文本
			log("草稿卡片发送失败，改发文字", e);
			isCard = false;
			dmId = await sendToUserAsBot(OWNER_OPEN_ID, draftText(source, kind, body, note, report, noReply));
		}
	db().transaction((tx) => {
		if (replaces) tx.update(schema.drafts).set({ status: "replaced" }).where(eq(schema.drafts.id, replaces)).run();
		tx.insert(schema.drafts)
			.values({ id: dmId, ...row })
			.run();
	});
	if (isCard) setKv(cardKey(dmId), true);
	if (replaces) syncCard(replaces);
	changed();
	return dmId;
}

/** 引用了哪条草稿就操作哪条；没引用时只认最近 30 分钟内最新的一条私聊过的草稿（看板专属的 Yi 在私聊里看不到，不能被「发」误选） */
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
		.limit(20)
		.all()
		.find((d) => !isQuiet(d.id) && now() - d.created < 1800);
}
