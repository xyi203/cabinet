// 盯 MR：评论发到 MR 之后（drafts/mr.ts watchMr），定时看对方有没有推新提交、在本工具开的线程里回复，
// 有就复审一轮（drafts/actions.ts reReview）：同一个会话审增量、维护旧线程，出新一版评论等 Yi 过目。
// GitLab 没有接 webhook（docs/router-worker.md P5），先轮询；MR 合并或关闭就不再盯。
import { MR_WATCH_INTERVAL, MR_WATCH_SETTLE } from "./config.ts";
import { reReview } from "./drafts/actions.ts";
import { glabApi, INLINE_MARK, listWatches, type MrWatch, saveWatch, unwatch } from "./drafts/mr.ts";
import { syncCard } from "./drafts/store.ts";
import { log, now } from "./util.ts";

let timer: NodeJS.Timeout | undefined;
let me: number | undefined;

export function startMrWatch() {
	if (MR_WATCH_INTERVAL <= 0) return;
	const tick = () => void checkAll().catch((e) => log("盯 MR 出错", e));
	timer = setInterval(tick, MR_WATCH_INTERVAL * 1000);
	timer.unref();
	tick();
}

export function stopMrWatch() {
	if (timer) clearInterval(timer);
}

async function checkAll() {
	for (const w of listWatches()) await checkOne(w).catch((e) => log("检查 MR 失败", w.url, e));
}

interface Note {
	id: number;
	system?: boolean;
	body?: string;
	author?: { id?: number };
}

/** 一个 MR 这一轮要不要复审：返回原因；顺带更新 watch（合并 / 关闭就删掉） */
export async function checkOne(w: MrWatch, at = now()): Promise<string | undefined> {
	const base = `projects/${encodeURIComponent(w.project)}/merge_requests/${w.iid}`;
	const mr = JSON.parse(await glabApi("GET", base));
	if (mr?.state === "merged" || mr?.state === "closed") {
		log(`MR 已${mr.state === "merged" ? "合并" : "关闭"}，不再盯`, w.url);
		unwatch(w);
		return;
	}
	me ??= JSON.parse(await glabApi("GET", "user"))?.id;
	const discussions: Array<{ id: string; notes: Note[] }> = JSON.parse(await glabApi("GET", `${base}/discussions?per_page=100`));
	const reason = decide(w, mr?.diff_refs?.head_sha, discussions, me, at);
	if (!reason) return;
	// 先停止盯，免得复审还没跑完下一轮又触发；评论再发出去时会重新开始盯
	unwatch(w);
	log("MR 复审", w.url, reason);
	void reReview(w.draftId, reason).catch((e) => {
		log("复审失败", w.url, e);
		// 没跑成：恢复盯，下一轮再试；卡片上写原因
		saveWatch({ ...w, pendingHead: undefined, pendingSince: undefined });
		syncCard(w.draftId, `自动复审没有成功：${String((e as Error).message).slice(0, 200)}`);
	});
	return reason;
}

/**
 * 纯判断：新 head 稳定了 MR_WATCH_SETTLE 秒（对方常连推几次），或本工具开的线程里有别人的新回复，就复审。
 * 第一次轮询只记下当时最大的 note id，不把已有的回复当成新的。会改 w 并存回
 */
export function decide(
	w: MrWatch,
	head: string | undefined,
	discussions: Array<{ id: string; notes: Note[] }>,
	self: number | undefined,
	at: number,
): string | undefined {
	const maxNote = Math.max(0, ...discussions.flatMap((d) => d.notes.map((n) => n.id)));
	if (w.seenNote == null) {
		saveWatch({ ...w, seenNote: maxNote });
		return;
	}
	const ours = discussions.filter((d) => d.notes[0]?.body?.includes(INLINE_MARK));
	const fresh = (n: Note) => n.id > w.seenNote! && !n.system && n.author?.id !== self && !n.body?.includes("gitlab-mr-review");
	const replied = ours.filter((d) => d.notes.slice(1).some(fresh));
	let reason: string | undefined;
	const next: MrWatch = { ...w };
	if (head && head !== w.head) {
		if (next.pendingHead !== head) Object.assign(next, { pendingHead: head, pendingSince: at });
		else if (at - (next.pendingSince ?? at) >= MR_WATCH_SETTLE)
			reason = `MR 有了新提交（上次审到 ${w.head.slice(0, 8)}，现在是 ${head.slice(0, 8)}）`;
	}
	// 新提交还在等稳定时先不因为回复单独跑：稳定后一起审
	if (!reason && replied.length && next.pendingHead == null) reason = `对方在 ${replied.length} 条评论线程里回复了`;
	else if (reason && replied.length) reason = `${reason}，线程里也有新回复`;
	// 等新提交稳定期间看到的回复先不算看过：稳定后和新提交一起触发
	if (reason || next.pendingHead == null) next.seenNote = Math.max(w.seenNote, maxNote);
	saveWatch(next);
	return reason;
}
