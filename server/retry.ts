// 失败任务重试：看板上点「重试」时调用。换一个 attempt，durable 才会重新跑而不是接回上次失败的那次
import { makeDraft } from "./drafts/make.ts";
import { DraftError, inflight } from "./drafts/store.ts";
import { markHandled } from "./poller.ts";
import { handle } from "./qa.ts";
import { recentRecords } from "./records.ts";
import { now } from "./util.ts";

/** 失败任务重试：起草失败按原消息重新起草，问答失败按原事件重新处理 */
export function retryTask(taskId: string) {
	for (const r of recentRecords(1000)) {
		if (r.status !== "failed" || !r.retry) continue;
		if (r.kind === "draft" && taskId === `fail-${r.source}`) {
			const { chat, msgs } = r.retry as any;
			if (msgs.some((m: any) => inflight.has(m.message_id))) throw new DraftError("这条正在起草中");
			for (const m of msgs)
				inflight.set(m.message_id, {
					chatId: chat.chat_id,
					chatMode: chat.chat_mode,
					label: r.label ?? "",
					text: String(m.content ?? "").slice(0, 300),
					since: now(),
				});
			void makeDraft(chat, msgs, markHandled, `retry-${Date.now()}`);
			return;
		}
		if (r.kind === "qa" && taskId === `qa-${r.source}`) {
			void handle(r.retry as any, `retry-${Date.now()}`);
			return;
		}
	}
	throw new DraftError("找不到可重试的失败记录");
}
