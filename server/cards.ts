// 卡片按钮的统一入口（card.action.trigger）：按回传的 value.k 分给草稿、agent 任务、起草失败。
// 只认 Yi；回调要 3 秒内返回：操作 2 秒内做完就带回结果卡片，否则先回「处理中」，做完由各自的同步原地更新。
import { setTimeout as sleep } from "node:timers/promises";
import { OWNER_NAME, OWNER_OPEN_ID } from "./config.ts";
import { closeTask, discardDev, messageDev, pushDev, renderDevCard, stopDev, syncDevCard } from "./dev.ts";
import { onDraftCardAction } from "./drafts/actions.ts";
import { parseCardAction } from "./drafts/card.ts";
import { DraftError } from "./drafts/store.ts";
import { LarkError } from "./lark/bot.ts";
import { dismissTask, retryTask } from "./retry.ts";
import { log } from "./util.ts";

type Toast = "success" | "info" | "error";
const reply = (type: Toast, content: string, card?: object) => ({
	toast: { type, content },
	...(card ? { card: { type: "raw", data: card } } : {}),
});
const reason = (e: unknown) => (e instanceof DraftError || e instanceof LarkError ? (e as Error).message : "执行失败，详情见日志");

/** 等操作最多 2 秒：做完了返回结果，没做完返回 undefined（之后在后台接着等） */
async function within<T>(job: Promise<T>) {
	const outcome = job.then(
		(value) => ({ ok: true as const, value }),
		(error: unknown) => ({ ok: false as const, error }),
	);
	return { settled: await Promise.race([outcome, sleep(2000, undefined, { ref: false })]), outcome };
}

const DEV_DONE: Record<string, string> = { say: "已发给 agent", push: "已推送", stop: "已停止", discard: "已放弃", complete: "已完成" };

async function devAction(msgId: string, a: string, taskId: string, form: Record<string, string>) {
	let job: Promise<unknown>;
	if (a === "say") {
		if (!form.msg?.trim()) return reply("error", "先写要发给 agent 的话");
		job = messageDev(taskId, form.msg);
	} else if (a === "push") job = pushDev(taskId);
	else if (a === "stop") job = stopDev(taskId);
	else if (a === "discard") job = discardDev(taskId);
	else if (a === "complete") job = Promise.resolve().then(() => closeTask(taskId));
	else return reply("error", `不认识的操作 ${a}`);
	const { settled, outcome } = await within(job);
	if (!settled) {
		void outcome.then((r) => {
			if (r.ok) return;
			log("任务卡片操作失败", a, taskId, r.error);
			syncDevCard(taskId, reason(r.error));
		});
		return reply("info", a === "push" ? "推送中…" : "处理中…", renderDevCard(msgId));
	}
	if (settled.ok) {
		const text = a === "say" && settled.value === "steered" ? "已插进当前这一轮" : (DEV_DONE[a] ?? "已处理");
		return reply("success", text, renderDevCard(msgId));
	}
	if (!(settled.error instanceof DraftError)) log("任务卡片操作失败", a, taskId, settled.error);
	return reply("error", reason(settled.error), renderDevCard(msgId, reason(settled.error)));
}

function failureAction(a: string, taskId: string) {
	try {
		if (a === "retry") retryTask(taskId);
		else if (a === "ignore") dismissTask(taskId);
		else return reply("error", `不认识的操作 ${a}`);
	} catch (e) {
		return reply("error", reason(e));
	}
	// 卡片由 closeFailure 原地更新
	return reply("success", a === "retry" ? "已重新起草" : "已忽略");
}

export async function onCardAction(data: unknown) {
	const ev = parseCardAction(data);
	if (!ev) return;
	// 卡片只发在 Yi 的私聊里，这里仍然只认 Yi：以 Yi 身份发出、推送代码的确认不能由别人点出来
	if (!OWNER_OPEN_ID || ev.operatorId !== OWNER_OPEN_ID) return reply("error", `只有${OWNER_NAME}能操作`);
	const { k, t } = ev.value as { k?: string; t?: string };
	if (k === "dev" && t) return devAction(ev.messageId, ev.name, t, ev.form);
	if (k === "fail" && t) return failureAction(ev.name, t);
	return onDraftCardAction(data);
}
