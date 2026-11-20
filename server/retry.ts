// 失败任务重试：看板上点「重试」时调用。换一个 attempt，durable 才会重新跑而不是接回上次失败的那次
import { closeFailure } from "./drafts/failure.ts";
import { makeDraft } from "./drafts/make.ts";
import { DraftError, inflight } from "./drafts/store.ts";
import { markHandled } from "./poller.ts";
import { answer } from "./qa.ts";
import { latestRecord, record } from "./records.ts";
import { now } from "./util.ts";

/** 失败任务重试：起草失败按原消息重新起草，问答失败按原事件重新处理 */
export function retryTask(taskId: string) {
	const r = failedRecord(taskId);
	if (r?.retry && r.kind === "draft") {
		const { chat, msgs, pick } = r.retry as any;
		if (msgs.some((m: any) => inflight.has(m.message_id))) throw new DraftError("这条正在起草中");
		for (const m of msgs)
			inflight.set(m.message_id, {
				chatId: chat.chat_id,
				chatMode: chat.chat_mode,
				label: r.label ?? "",
				text: String(m.content ?? "").slice(0, 300),
				since: now(),
			});
		void makeDraft(chat, msgs, markHandled, `retry-${Date.now()}`, pick);
		closeFailure(taskId, "retrying");
		return;
	}
	if (r?.retry && r.kind === "qa") {
		void answer(r.retry as any, `retry-${Date.now()}`);
		return;
	}
	throw new DraftError("找不到可重试的失败记录");
}

/** fail-<被回复的消息>（起草）/ qa-<提问消息>（问答）对应的那条失败记录，按消息直接查库，不限最近多少条 */
function failedRecord(taskId: string) {
	const i = taskId.indexOf("-");
	const kind = { fail: "draft", qa: "qa" }[taskId.slice(0, i)];
	return kind ? latestRecord([taskId.slice(i + 1)], { kind, status: "failed" }) : undefined;
}

/** 忽略一条失败：不再算阻塞，不重试（比如已经在别处回过了） */
export function dismissTask(taskId: string) {
	const r = failedRecord(taskId);
	if (!r) throw new DraftError("找不到这条失败记录");
	record({ kind: r.kind, status: "dismissed", chatId: r.chatId, source: r.source, label: r.label, question: r.question });
	if (r.kind === "draft") closeFailure(taskId, "dismissed");
}
