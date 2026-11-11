// 到期复查的执行（followups.ts 只管记和取）：每 30 秒看一次到期的，草稿在这件事最新一版上出新版本，agent 任务接着原会话再跑一轮
import { OWNER_OPEN_ID } from "./config.ts";
import { messageDev } from "./dev.ts";
import { followUpDraft } from "./drafts/actions.ts";
import { type Followup, MAX_RUNS, runDueFollowups } from "./followups.ts";
import { sendToUserAsBot } from "./lark/bot.ts";
import { outputsOf, refreshTask } from "./taskstore.ts";
import { log } from "./util.ts";

let timer: NodeJS.Timeout | undefined;

export function startFollowups() {
	const loop = () => {
		void runDueFollowups(runner)
			.catch((e) => log("检查到期复查失败", e))
			.finally(() => {
				timer = setTimeout(loop, 30_000);
				timer.unref();
			});
	};
	timer = setTimeout(loop, 15_000);
	timer.unref();
}

export function stopFollowups() {
	clearTimeout(timer);
}

/** 草稿可能已经改写、复审出了新版：接着最新那一版 */
function latestDraft(f: Followup): string {
	const drafts = outputsOf([f.taskId]).get(f.taskId)?.drafts ?? [];
	return drafts.toSorted((a, b) => b.created - a.created)[0]?.id ?? f.actionId;
}

const runner = {
	cancelled: (taskId: string) => refreshTask(taskId)?.status === "cancelled",
	draft: (f: Followup) => followUpDraft(latestDraft(f), f.key, f.about),
	dev: async (f: Followup) => {
		await messageDev(
			f.actionId,
			`到期复查（${f.key}）：${f.about}\n\n先到原处核实现在的情况，再给结论；还要再等就再约【复查】。`,
			"cabinet",
		);
	},
	exhausted: (f: Followup) =>
		void sendToUserAsBot(
			OWNER_OPEN_ID,
			`同一件事已经自动复查了 ${MAX_RUNS} 次，这次（${f.key}：${f.about.slice(0, 100)}）没有再跑。要继续的话在看板上打开这件事处理。`,
		).catch((e) => log("复查上限提醒发送失败", e)),
};
