// 看板「完成」：Yi 已经在别处处理了这件事（自己回了、当面说了、不用管），在看板上直接标掉。
// 按这件事现在走到哪一步，交给各自已有的收尾入口，状态仍由 taskstore 按产出推：
// 排队 / 等待 / 起草中 → 不用起草（起草中的会中止）；草稿待发 → 完成；agent 任务等你看 → 归档；失败 → 忽略。
import { applyDraftAction } from "./drafts/actions.ts";
import { dismissDraft } from "./drafts/make.ts";
import { DraftError, LIVE } from "./drafts/store.ts";
import { closeTask } from "./dev.ts";
import { recentRecords } from "./records.ts";
import { dismissTask } from "./retry.ts";
import { isClosed, outputsOf, refreshTask } from "./taskstore.ts";

export async function markDone(taskId: string): Promise<void> {
	// 还没分派的消息（看板上 q:<消息 id> 那一行）
	if (taskId.startsWith("q:")) {
		if (!dismissDraft(taskId.slice(2))) throw new DraftError("这条已经处理完了，刷新看看");
		return;
	}
	const row = refreshTask(taskId);
	if (!row) throw new DraftError("这件事不存在");
	if (isClosed(row.status)) throw new DraftError("这件事已经结束了");
	if (row.need === "approve") throw new DraftError("还有待审批的命令，先批准或拒绝");
	const o = outputsOf([taskId]).get(taskId)!;
	const latest = o.routes.filter((r) => ["draft", "qa", "dev"].includes(r.actionKind)).toSorted((a, b) => b.at - a.at)[0];
	if (!latest) throw new DraftError("这件事还没开始处理，刷新看看");

	if (latest.actionKind === "dev") {
		const dev = o.devs.toSorted((a, b) => b.updated - a.updated)[0];
		if (!dev) throw new DraftError("找不到这件事的 agent 任务");
		if (dev.status === "running" || dev.status === "pushing") throw new DraftError("agent 还在跑，先停止再标完成");
		await closeTask(dev.id);
		return;
	}

	const draft = o.drafts.filter((d) => d.routeId === latest.id).toSorted((a, b) => b.created - a.created)[0];
	if (draft) {
		if (!LIVE.includes(draft.status)) throw new DraftError("草稿正在发送或改写，等它结束再标");
		await applyDraftAction(draft.id, "complete");
		return;
	}

	const sources = latest.triggers.map((id) => id.slice(id.indexOf(":") + 1));
	if (row.need === "retry") {
		// 失败记录的 id 规则和 tasks.ts 的 retryId 一致
		const rec = recentRecords(1000).find((r) => r.status === "failed" && r.source && sources.includes(r.source));
		if (!rec) throw new DraftError("找不到这条失败记录");
		dismissTask(`${rec.kind === "draft" ? "fail" : "qa"}-${rec.source}`);
		return;
	}
	// 已分派、还在等或正在起草：批里任何一条标了，起草前（或跑完后推送前）都会按跳过收尾
	if (!sources.map((mid) => dismissDraft(mid)).some(Boolean)) throw new DraftError("这件事现在没有可以标完成的，刷新看看");
}
