// 代回复草稿：发现「私聊 Yi / 群里 @Yi / 飞书项目 @Yi」的新消息 -> 中台分派 agent 起草 -> 机器人私聊 Yi 草稿
// -> Yi 回「发 / 改 xxx / 不发」或在看板上操作 ->「发」时以 Yi 的身份发出。没有 Yi 的确认，什么都不会以他的名义发出。
// 这里是「发 / 不发 / 改 / 完成」的唯一实现，飞书私聊和看板共用；以 Yi 身份发出的唯一入口是 send
import path from "node:path";
import { changed } from "../bus.ts";
import { PATHS } from "../config.ts";
import type { Draft } from "../db/schema.ts";
import { getMessage, reactAsUser, sendImageAsUser, sendTextAsUser, react } from "../lark/bot.ts";
import { loadAgents } from "../agent/router.ts";
import { sendMeegoComment } from "../meego.ts";
import { record } from "../records.ts";
import { runPi } from "../agent/driver.ts";
import { enqueueMemory } from "../memory/extract.ts";
import { now } from "../util.ts";
import { DEFAULT_CWD } from "../config.ts";
import { locks, sem } from "../agent/slots.ts";
import { gatherContext } from "./context.ts";
import { describeReply, draftLabel, type Kind, resolveEmoji, resolveSticker, stickerHint } from "./format.ts";
import { claim, DraftError, getDraft, isQuiet, LIVE, pushDraft, setStatus } from "./store.ts";

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
			if (!isQuiet(id)) void react(id, "DONE");
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
