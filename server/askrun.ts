// 回答【提问】（server/asks.ts 只管记和取）：卡片按钮和看板共用。先收掉提问再接着跑，重复点不会跑两遍；
// 草稿在这件事最新一版上出新版本，agent 任务接着原会话再跑一轮。
import { type Ask, answerPrompt, clearAsk, getAsk, saveAsk } from "./asks.ts";
import { messageDev } from "./dev.ts";
import { answerDraftAsk } from "./drafts/actions.ts";
import { DraftError } from "./drafts/store.ts";
import { resetFollowupRuns } from "./followups.ts";
import { outputsOf } from "./taskstore.ts";
import { log } from "./util.ts";

/** 草稿可能已经改写过：接着最新那一版 */
function latestDraft(ask: Ask): string | undefined {
	const drafts = outputsOf([ask.taskId]).get(ask.taskId)?.drafts ?? [];
	return drafts.toSorted((a, b) => b.created - a.created)[0]?.id ?? (ask.actionId || undefined);
}

/** choice 是选项下标；text 是选项以外的回答（看板输入框），有 text 时以它为准 */
export async function answerAsk(taskId: string, choice?: number, text = ""): Promise<string> {
	const ask = getAsk(taskId);
	if (!ask) throw new DraftError("这个提问已经答过或者收掉了");
	const answer = text.trim() || (choice != null ? ask.options[choice] : undefined);
	if (!answer) throw new DraftError("选一个选项，或者写下你的回答");
	clearAsk(taskId);
	// Yi 动了这件事：自动复查的次数重新算
	resetFollowupRuns(taskId);
	const prompt = answerPrompt(ask, answer);
	try {
		if (ask.kind === "dev") await messageDev(ask.actionId, prompt);
		else {
			const id = latestDraft(ask);
			if (!id) throw new DraftError("找不到这件事的草稿");
			// 草稿重跑要等模型出稿，不在这里等完：卡片和看板随草稿状态更新
			void answerDraftAsk(id, ask.title, prompt).catch((e) => log("回答提问后出新一版失败", id, e));
		}
	} catch (e) {
		// 没接上就把提问放回去，Yi 还能再点
		if (!getAsk(taskId)) saveAsk(taskId, ask.kind, ask.actionId, ask, ask.created);
		throw e;
	}
	return answer;
}
