// 代回复草稿：发现「私聊 Yi / 群里 @Yi / 飞书项目 @Yi」的新消息 -> 中台分派 agent 起草 -> 机器人私聊 Yi 草稿
// -> Yi 回「发 / 改 xxx / 不发」或在看板上操作 ->「发」时以 Yi 的身份发出。没有 Yi 的确认，什么都不会以他的名义发出。
// 这里是「发 / 不发 / 改 / 完成」的唯一实现，飞书私聊和看板共用；以 Yi 身份发出的唯一入口是 send
import { setTimeout as sleep } from "node:timers/promises";
import { changed } from "../bus.ts";
import { OWNER_NAME, OWNER_OPEN_ID, PATHS } from "../config.ts";
import type { Draft } from "../db/schema.ts";
import { channelOfDraft } from "../channels/index.ts";
import { getMessage, LarkError, react } from "../lark/bot.ts";
import { ASSISTANT, LEGACY_TIER, TASK_TIER, loadAgents, resolveCwd, withTier } from "../agent/router.ts";
import { settle } from "../pipeline.ts";
import { record } from "../records.ts";
import { runPi } from "../agent/driver.ts";
import { enqueueMemory } from "../memory/extract.ts";
import { log, now } from "../util.ts";
import { DEFAULT_CWD } from "../config.ts";
import { locks, sem } from "../agent/slots.ts";
import { gatherContext } from "./context.ts";
import { describeReply, draftLabel, type Kind, resolveEmoji, resolveSticker, stickerHint } from "./format.ts";
import { CardInputError, draftCard, draftStateText, parseCardAction, sendText } from "./card.ts";
import { claim, DraftError, getDraft, isQuiet, LIVE, pushDraft, setStatus, syncCard } from "./store.ts";
import { applyMrAction, draftMrs, type MrLedger } from "./mr.ts";

/** MR 预审的改写：Yi 多半是要删改某几条评论，把当前的报告和台账原样给回去 */
function mrRevision(report: string, ledger?: MrLedger) {
	return `当前评审报告：\n${report || "（无）"}\n\n当前将发到 MR 的评论台账：\n${ledger ? JSON.stringify(ledger, null, 2) : "（无）"}\n\nYi 没提到的评论原样保留，不要重新审一遍。`;
}

/** 发回草稿来的那个渠道（channels/）：飞书私聊和群、飞书项目评论 */
async function sendDraft(d: Draft) {
	await channelOfDraft(d).send!(d);
}

/** 草稿行里的来源部分：改写、复审出新一版时原样带过去 */
function sourceOf(d: Draft) {
	const { id: _id, kind: _k, draft: _d, note: _n, report: _r, status: _s, created: _c, ...source } = d;
	return source;
}

/**
 * 在草稿原来的会话里再跑一轮（改写、MR 复审）：附上原文和当前草稿，不依赖会话里还留着上一版（会话可能被压缩）。
 * 改写要能查事实：按 deep 档跑，MR 预审按 mr 档（同一个模型接着审）；改版前的草稿记的是旧 agent 名，一律交给 assistant
 */
async function rerun(d: Draft, requestId: string, ask: string, memoryQuery: string): Promise<{ text: string; context: string }> {
	const name = LEGACY_TIER[d.agent ?? ""] ? ASSISTANT : (d.agent ?? ASSISTANT);
	const mr = draftMrs([d]).get(d.id);
	const agent = withTier(loadAgents().agents[name] ?? {}, mr ? "mr" : TASK_TIER);
	// 早于上下文功能的草稿没有存前文，现补
	let context = d.context;
	if (!context && d.chatMode !== "meego") {
		const orig = await getMessage(d.replyTo).catch(() => undefined);
		if (orig) context = (await gatherContext({ chat_id: d.chatId, chat_mode: d.chatMode }, [orig])).related;
	}
	const { text } = await locks.run(`draft-${d.chatId}`, () =>
		sem.run(() =>
			runPi({
				cwd: mr ? resolveCwd(agent, { rule: "", mrProject: mr.project, mrIid: mr.iid }) : DEFAULT_CWD,
				sessionId: d.session,
				requestId,
				tier: "rewrite",
				prompt: `${context ? `相关前文：\n${context}\n\n` : ""}需要回复的消息：\n${d.text}\n\n当前草稿：\n${describeReply(d.kind, d.draft)}\n\n${ask}`,
				extraSystem: [PATHS.draftRules],
				label: draftLabel(d),
				agent,
				agentName: name,
				origin: { label: `改写给 ${d.senderName} 的草稿`, draftReplyTo: d.replyTo },
				chatId: d.chatId,
				lookup: true,
				memory: {
					query: memoryQuery,
					scope: { personId: d.chatMode === "meego" ? undefined : d.senderId, chatId: d.chatId },
				},
			}),
		),
	);
	return { text, context };
}

/** 正在复审的草稿：同一个 MR 不并发跑两轮 */
const rereviewing = new Set<string>();

/**
 * MR 复审：评论发出后对方推了新提交、在线程里回复了，或 Yi 点了「复审」。在同一个会话里按 review skill 的
 * mr-re-review.md 审增量、维护旧线程，出新一版草稿（新卡片），同一件事回到「等你发送」。上一版还没处理就替换掉它
 */
export async function reReview(id: string, reason: string): Promise<void> {
	const d = getDraft(id);
	if (!d) throw new DraftError("草稿不存在");
	const mr = draftMrs([d]).get(id);
	if (!mr) throw new DraftError("这条草稿不是 MR 预审");
	if (rereviewing.has(id) || d.status === "sending" || d.status === "revising") throw new DraftError("这个 MR 正在处理，稍等一下");
	const live = LIVE.includes(d.status);
	if (live && !claim(id, LIVE, "revising")) throw new DraftError("这条草稿正在处理，稍等一下");
	rereviewing.add(id);
	changed();
	log("开始复审", mr.url, reason);
	try {
		const head = mr.ledger?.head_sha;
		const started = now();
		const { text, context } = await rerun(
			d,
			`rereview:${id}:${Date.now()}`,
			[
				`上一轮评审报告：\n${d.report || "（无）"}`,
				`上一轮的评论台账${mr.done.includes("note") ? "（已经发到 MR 上了）" : "（还没发）"}：\n${mr.ledger ? JSON.stringify(mr.ledger, null, 2) : "（无）"}`,
				`这次是复审，原因：${reason}。`,
				`按 review skill 的 references/mr-re-review.md 做：上次审到的 head 是 ${head ?? "MR 总结评论标记里的 head_sha"}，只审它之后的增量（force-push 就全量审并说明）；` +
					"读 MR 的 discussions，本工具开的线程（首条 note 带 `<!-- gitlab-mr-review -->`）逐个判断，已修复、或作者回复成立的 resolve，回复不成立的回复一次，都写进台账的 threads。" +
					(mr.done.includes("note")
						? "台账只放这一轮要新发的内容，上一轮已经发出去的评论不要再写。"
						: "上一轮台账还没发，这一轮的台账要包含仍然成立的旧发现，替代上一轮。"),
				"按 MR 预审的输出格式完整输出（回复、【评审报告】、【MR评论】三段都要有），评审报告开头写清这一轮看了什么、旧线程处理结果。",
			].join("\n\n"),
			`${d.text}\n复审 ${mr.project}!${mr.iid}`,
		);
		await pushDraft({ ...sourceOf(d), context }, text, live ? id : undefined);
		record({
			kind: "draft",
			status: "revised",
			dm: id,
			chatId: d.chatId,
			source: d.replyTo,
			question: `复审：${reason}`,
			seconds: now() - started,
			session: d.session,
		});
	} catch (e) {
		if (live) claim(id, ["revising"], d.status);
		throw e;
	} finally {
		rereviewing.delete(id);
		changed();
	}
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
	if (!LIVE.includes(d.status)) throw new DraftError(`这条草稿现在是「${draftStateText(d.status)}」，不能再操作`);
	if (action === "send" && d.status === "noreply" && !arg)
		throw new DraftError("这条建议不回复，没有草稿可发；要回复的话先写内容，或者改写");
	if (action === "revise" && !arg) throw new DraftError("先写想怎么改");
	const busy = { send: "sending", revise: "revising", discard: "discarded", complete: "completed" }[action];
	if (!busy) throw new DraftError(`未知操作 ${action}`);
	if (!claim(id, LIVE, busy)) throw new DraftError("这条草稿正在处理，稍等一下");
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
			const mr = draftMrs([d]).get(id);
			const started = now();
			const { text, context } = await rerun(
				d,
				`revise:${id}`,
				`${mr ? mrRevision(d.report, mr.ledger) : stickerHint()}\n\nYi 的修改意见：${arg}\n\n（当前草稿的 ID：draft:${id}）\n\n${
					mr ? "请按意见重写，按 MR 预审的输出格式完整输出（回复、【评审报告】、【MR评论】三段都要有）。" : "请按意见重写，只输出新的草稿。"
				}`,
				`${d.text}\n${arg}`,
			);
			await pushDraft({ ...sourceOf(d), context }, text, id);
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
	send: "已发送",
	mr_approve: "已批准 MR",
	mr_note: "已发到 MR",
	mr_rereview: "开始复审，好了另发一张卡片",
	emoji: "已回表情",
	sticker: "已发表情包",
	discard: "这条不回复了",
	complete: "已完成",
	revise: "已改写，新草稿在下一张卡片",
};
const BUSY_TOAST: Record<string, string> = {
	revise: "正在改写，好了会另发一张卡片",
	mr_approve: "正在批准…",
	mr_note: "正在发到 MR…",
};

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
	if (!d) return toast("error", "找不到这条草稿");
	let job: Promise<string>;
	try {
		if (ev.name === "mr_approve" || ev.name === "mr_note" || ev.name === "mr_rereview") {
			const what = ev.name === "mr_approve" ? "approve" : ev.name === "mr_note" ? "note" : "rereview";
			job = applyMrAction(d.id, what).then(() => getDraft(d.id)!.status);
		} else if (ev.name === "send") job = applyDraftAction(d.id, "send", sendText(d, ev.form.text), "text");
		else if (ev.name === "emoji" || ev.name === "sticker") {
			const pick = ev.form[ev.name]?.trim();
			if (!pick) throw new CardInputError(ev.name === "emoji" ? "先选一个表情" : "先选一个表情包");
			job = applyDraftAction(d.id, "send", pick, ev.name === "emoji" ? "reaction" : "sticker");
		} else if (ev.name === "revise") {
			if (!ev.form.opinion?.trim()) throw new CardInputError("先写想怎么改");
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
			syncCard(
				d.id,
				`「${ev.name === "revise" ? "改写" : ev.name === "mr_approve" ? "批准 MR" : ev.name === "mr_note" ? "发到 MR" : "发送"}」没有成功：${reason(r.error)}`,
			);
		});
		return toast("info", BUSY_TOAST[ev.name] ?? "正在发送…", draftCard(getDraft(d.id)!, "", draftMrs([d]).get(d.id)));
	}
	const card = () => draftCard(getDraft(d.id)!, "", draftMrs([d]).get(d.id));
	if (settled.ok) return toast("success", DONE_TOAST[ev.name] ?? "已处理", card());
	if (!(settled.error instanceof DraftError)) log("草稿卡片操作失败", ev.name, d.id, settled.error);
	const msg = reason(settled.error);
	// 回滚状态时排了一次不带提示的重画，可能晚于这个回调响应到达：再排一次带提示的，最后停在有原因的那张
	syncCard(d.id, msg);
	return toast("error", msg, draftCard(getDraft(d.id)!, msg, draftMrs([d]).get(d.id)));
}
