// 到期复查的执行（followups.ts 只管记和取）：每 30 秒看一次到期的，草稿在这件事最新一版上出新版本，agent 任务接着原会话再跑一轮。
// 等 GitLab 事件的（until: mr_merged / pipeline_done）先查一遍，等到了就提前到期
import { MR_RE } from "./agent/router.ts";
import { OWNER_OPEN_ID } from "./config.ts";
import { messageDev } from "./dev.ts";
import { followUpDraft } from "./drafts/actions.ts";
import { glabApi } from "./drafts/mr.ts";
import { eventFollowups, type Followup, MAX_RUNS, markChecked, runDueFollowups } from "./followups.ts";
import { sendToUserAsBot } from "./lark/bot.ts";
import { outputsOf, refreshTask } from "./taskstore.ts";
import { log } from "./util.ts";

let timer: NodeJS.Timeout | undefined;

export function startFollowups() {
	const loop = () => {
		void checkEvents()
			.then(() => runDueFollowups(runner))
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

/** 等的 GitLab 事件到了没有：到了返回一句说明 */
export async function mrEvent(f: Pick<Followup, "until" | "mr">): Promise<string | undefined> {
	const m = f.mr ? MR_RE.exec(f.mr) : null;
	if (!m) return;
	const mr = JSON.parse(await glabApi("GET", `projects/${encodeURIComponent(m[1])}/merge_requests/${m[2]}`));
	const closed = mr?.state === "merged" ? "MR 已合并" : mr?.state === "closed" ? "MR 已关闭（没有合并）" : undefined;
	if (f.until === "mr_merged") return closed;
	const st = mr?.head_pipeline?.status;
	if (["success", "failed", "canceled", "skipped"].includes(st)) return `MR 的流水线跑完了，结果是 ${st}`;
	return closed;
}

async function checkEvents() {
	for (const f of eventFollowups()) {
		let met: string | undefined;
		try {
			met = await mrEvent(f);
			if (met) log("复查等到了", f.taskId, f.key, met);
		} catch (e) {
			log("查复查等的事件失败，下一轮再查", f.taskId, f.key, e);
		}
		markChecked(f, met);
	}
}

/** 等到的事件写在前面，agent 知道为什么提前回来了 */
const aboutOf = (f: Followup) => (f.met ? `${f.met}（提前于约好的截止时间）。${f.about}` : f.about);

/** 草稿可能已经改写、复审出了新版：接着最新那一版 */
function latestDraft(f: Followup): string {
	const drafts = outputsOf([f.taskId]).get(f.taskId)?.drafts ?? [];
	return drafts.toSorted((a, b) => b.created - a.created)[0]?.id ?? f.actionId;
}

const runner = {
	cancelled: (taskId: string) => refreshTask(taskId)?.status === "cancelled",
	draft: (f: Followup) => followUpDraft(latestDraft(f), f.key, aboutOf(f)),
	dev: async (f: Followup) => {
		await messageDev(
			f.actionId,
			`到期复查（${f.key}）：${aboutOf(f)}\n\n先到原处核实现在的情况，再给结论；还要再等就再约【复查】。`,
			"cabinet",
		);
	},
	exhausted: (f: Followup) =>
		void sendToUserAsBot(
			OWNER_OPEN_ID,
			`同一件事已经自动复查了 ${MAX_RUNS} 次，这次（${f.key}：${f.about.slice(0, 100)}）没有再跑。要继续的话在看板上打开这件事处理。`,
		).catch((e) => log("复查上限提醒发送失败", e)),
};
