// 代回复草稿：发现「私聊 Yi / 群里 @Yi / 飞书项目 @Yi」的新消息 -> 中台分派 agent 起草 -> 机器人私聊 Yi 草稿
// -> Yi 回「发 / 改 xxx / 不发」或在看板上操作 ->「发」时以 Yi 的身份发出。没有 Yi 的确认，什么都不会以他的名义发出。
// 这里是「发 / 不发 / 改 / 完成」的唯一实现，飞书私聊和看板共用；以 Yi 身份发出的唯一入口是 send
import { setTimeout as sleep } from "node:timers/promises";
import { changed } from "../bus.ts";
import { OWNER_NAME, OWNER_OPEN_ID, PATHS } from "../config.ts";
import type { Draft } from "../db/schema.ts";
import { channelOfDraft } from "../channels/index.ts";
import { getMessage, LarkError, react } from "../lark/bot.ts";
import { ASSISTANT, LEGACY_TIER, TASK_TIER, loadAgents, withTier } from "../agent/router.ts";
import { settle } from "../pipeline.ts";
import { record } from "../records.ts";
import { runPi } from "../agent/driver.ts";
import { enqueueMemory } from "../memory/extract.ts";
import { log, now } from "../util.ts";
import { DEFAULT_CWD } from "../config.ts";
import { locks, sem } from "../agent/slots.ts";
import { gatherContext } from "./context.ts";
import { describeReply, draftLabel, type Kind, resolveEmoji, resolveSticker, stickerHint } from "./format.ts";
import { CardInputError, draftCard, parseCardAction, sendText } from "./card.ts";
import { claim, DraftError, getDraft, isQuiet, LIVE, pushDraft, setStatus, syncCard } from "./store.ts";

/** 发回草稿来的那个渠道（channels/）：飞书私聊和群、飞书项目评论 */
async function sendDraft(d: Draft) {
	await channelOfDraft(d).send!(d);
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
			if (!isQuiet(id)) void react(id, "DONE");
			record({ kind: "draft", status: "sent", dm: id, chatId: d.chatId, source: d.replyTo, answer: toSend.draft });
			settle({
				actionKind: "draft",
				actionId: id,
				routeId: d.routeId,
				outcome: "sent",
				effect: "outward",
				detail: describeReply(toSend.kind, toSend.draft),
			});
			enqueueMemory({ type: "draft", replyTo: d.replyTo, outcome: "sent" });
		} else if (action === "revise") {
			// 改写要能查事实：按 deep 档跑；改版前的草稿记的是旧 agent 名，一律交给 assistant
			const name = LEGACY_TIER[d.agent ?? ""] ? ASSISTANT : (d.agent ?? ASSISTANT);
			const agent = withTier(loadAgents().agents[name] ?? {}, TASK_TIER);
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
						prompt: `${context ? `相关前文：\n${context}\n\n` : ""}需要回复的消息：\n${d.text}\n\n当前草稿：\n${describeReply(d.kind, d.draft)}\n\n${stickerHint()}\n\nYi 的修改意见：${arg}\n\n（当前草稿的 ID：draft:${id}）\n\n请按意见重写，只输出新的草稿。`,
						extraSystem: [PATHS.draftRules],
						label: draftLabel(d),
						agent,
						agentName: name,
						chatId: d.chatId,
						lookup: true,
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
			settle({ actionKind: "draft", actionId: id, routeId: d.routeId, outcome: busy, effect: "internal" });
			enqueueMemory({ type: "draft", replyTo: d.replyTo, outcome: busy as "discarded" | "completed" });
		}
		return getDraft(id)!.status;
	} catch (e) {
		// 失败时退回原状态，可以再试
		if (action === "send" || action === "revise") claim(id, [busy], d.status);
		throw e;
	}
}

// ---------- 卡片按钮 ----------

const DONE_TOAST: Record<string, string> = {
	send: "已发出",
	emoji: "已回表情",
	sticker: "已发表情包",
	discard: "已标记不发",
	complete: "已标记完成",
	revise: "已改写，新草稿见下一张卡片",
};
const BUSY_TOAST: Record<string, string> = { revise: "改写中，新草稿会另发一张卡片" };

const reason = (e: Error) => (e instanceof DraftError || e instanceof LarkError ? e.message : "执行失败，详情见日志");

const toast = (type: "success" | "info" | "error", content: string, card?: object) => ({
	toast: { type, content },
	...(card ? { card: { type: "raw", data: card } } : {}),
});

/**
 * 草稿卡片上的按钮。回调要 3 秒内返回：操作 2 秒内做完就直接回结果卡片，
 * 没做完先回「发送中 / 改写中」，做完由 syncCard 原地更新；失败时卡片退回可操作状态并在顶上写原因。
 */
export async function onDraftCardAction(data: unknown) {
	const ev = parseCardAction(data);
	if (!ev) return;
	// 卡片只发在 Yi 的私聊里，这里仍然只认 Yi：以 Yi 身份发出的确认不能由别人点出来
	if (!OWNER_OPEN_ID || ev.operatorId !== OWNER_OPEN_ID) return toast("error", `只有${OWNER_NAME}能处理草稿`);
	const d = getDraft(ev.messageId);
	if (!d) return toast("error", "这张卡片不是草稿，或者草稿已经不在了");
	let job: Promise<string>;
	try {
		if (ev.name === "send") job = applyDraftAction(d.id, "send", sendText(d, ev.form.text), "text");
		else if (ev.name === "emoji" || ev.name === "sticker") {
			const pick = ev.form[ev.name]?.trim();
			if (!pick) throw new CardInputError(ev.name === "emoji" ? "先选一个表情" : "先选一个表情包");
			job = applyDraftAction(d.id, "send", pick, ev.name === "emoji" ? "reaction" : "sticker");
		} else if (ev.name === "revise") {
			if (!ev.form.opinion?.trim()) throw new CardInputError("先写改写意见");
			job = applyDraftAction(d.id, "revise", ev.form.opinion);
		} else if (ev.name === "discard" || ev.name === "complete") job = applyDraftAction(d.id, ev.name);
		else return toast("error", `不认识的操作 ${ev.name}`);
	} catch (e) {
		if (e instanceof CardInputError) return toast("error", e.message);
		throw e;
	}
	const outcome = job.then(
		() => ({ ok: true as const }),
		(e: unknown) => ({ ok: false as const, error: e as Error }),
	);
	const settled = await Promise.race([outcome, sleep(2000, undefined, { ref: false })]);
	if (!settled) {
		// 做完之前已经回了「处理中」：失败时再把原因补到卡片上
		void outcome.then((r) => {
			if (r.ok) return;
			log("草稿卡片操作失败", ev.name, d.id, r.error);
			syncCard(d.id, `「${ev.name === "revise" ? "AI 改写" : "发送"}」没有成功：${reason(r.error)}`);
		});
		return toast("info", BUSY_TOAST[ev.name] ?? "发送中…", draftCard(getDraft(d.id)!));
	}
	if (settled.ok) return toast("success", DONE_TOAST[ev.name] ?? "已处理", draftCard(getDraft(d.id)!));
	if (!(settled.error instanceof DraftError)) log("草稿卡片操作失败", ev.name, d.id, settled.error);
	const msg = reason(settled.error);
	// 回滚状态时排了一次不带提示的重画，可能晚于这个回调响应到达：再排一次带提示的，最后停在有原因的那张
	syncCard(d.id, msg);
	return toast("error", msg, draftCard(getDraft(d.id)!, msg));
}
