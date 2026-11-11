// 自约复查（docs/autoloop-borrow.md §1）：agent 在最后一条回复末尾写【复查】，约好什么时候回来看什么，
// cabinet 到点在原会话里接着做——草稿出新一版（MR 预审按复审走），agent 任务接着原会话再跑一轮。
// 用在「现在查不出结果」的事上：等 CI、等发布、等对方晚点发过来，不轮询干等。
// 同一件事（Task）里 key 唯一，再写同一个 key 是改期，{"key": …, "cancel": true} 取消。
// Yi 在这件事上点了完成 / 不回复 / 放弃，约好的复查一起取消；同一件事自动复查最多 MAX_RUNS 次，有人来新消息时清零。
import { deleteKv, getKv, listKv, setKv } from "./db/index.ts";
import { log, now } from "./util.ts";

export const FOLLOWUP_MARK = "【复查】";
/** 复查段之后可能还跟着的别的段：截到它们为止 */
const OTHER_MARKS = ["【备注】", "【评审报告】", "【MR评论】"];
const MIN_DELAY = 5 * 60;
const MAX_DELAY = 7 * 86400;
const MAX_PENDING = 5;
export const MAX_RUNS = 5;

export interface FollowupSpec {
	key: string;
	at?: number;
	about?: string;
	cancel?: boolean;
}

export interface Followup {
	taskId: string;
	key: string;
	/** 到期时间（秒） */
	at: number;
	about: string;
	/** 到点怎么接着做：draft 出新一版草稿，dev 接着 agent 任务的会话 */
	kind: "draft" | "dev";
	/** 约它的那次产出：草稿 id 或 agent 任务 id */
	actionId: string;
	created: number;
}

const itemKey = (taskId: string, key: string) => `fu:${taskId}:${key}`;
const countKey = (taskId: string) => `fucount:${taskId}`;

/**
 * 从 agent 的回复里取出【复查】段：只认最后一个，到文本末尾或下一个已知段标记为止；返回去掉它之后的文本。
 * 格式不对时 specs 为空、error 说明原因（调用方写进备注或日志），文本照样去掉这一段，免得发出去
 */
export function takeFollowups(text: string, at = now()): { text: string; specs: FollowupSpec[]; error?: string } {
	const i = text.lastIndexOf(FOLLOWUP_MARK);
	if (i < 0) return { text, specs: [] };
	const tail = text.slice(i + FOLLOWUP_MARK.length);
	const end = Math.min(...OTHER_MARKS.map((m) => tail.indexOf(m)).filter((x) => x >= 0), tail.length);
	const rest = (text.slice(0, i) + tail.slice(end)).trim();
	const raw = tail
		.slice(0, end)
		.trim()
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/```\s*$/, "")
		.trim();
	let v: unknown;
	try {
		v = JSON.parse(raw);
	} catch (e) {
		return { text: rest, specs: [], error: `【复查】不是合法的 JSON：${(e as Error).message}` };
	}
	const specs: FollowupSpec[] = [];
	for (const [n, x] of (Array.isArray(v) ? v : [v]).entries()) {
		const bad = (why: string) => ({ text: rest, specs: [], error: `【复查】第 ${n + 1} 条${why}` });
		const key = typeof x?.key === "string" ? x.key.trim() : "";
		if (!key || key.length > 40) return bad("缺少 key（40 字以内）");
		if (x.cancel === true) {
			specs.push({ key, cancel: true });
			continue;
		}
		// 必须带时区，免得模型按 UTC 写、到点差 8 小时
		if (typeof x.at !== "string" || !/(Z|[+-]\d{2}:?\d{2})$/.test(x.at.trim()))
			return bad("的 at 要是带时区的时间，比如 2026-11-11T15:00:00+08:00");
		const t = Date.parse(x.at) / 1000;
		if (!Number.isFinite(t)) return bad(`的 at「${x.at}」不是合法时间`);
		if (t < at + MIN_DELAY - 60 || t > at + MAX_DELAY) return bad("的时间要在 5 分钟到 7 天之后");
		const about = typeof x.about === "string" ? x.about.trim() : "";
		if (!about) return bad("缺少 about（到时候查什么、怎么算好）");
		specs.push({ key, at: Math.round(t), about: about.slice(0, 1000) });
	}
	return { text: rest, specs };
}

/** 记下这次产出约的复查；返回给 Yi 看的提示（超过上限没记上的），没有返回 "" */
export function saveFollowups(taskId: string, kind: Followup["kind"], actionId: string, specs: FollowupSpec[], at = now()): string {
	const skipped: string[] = [];
	for (const s of specs) {
		if (s.cancel) {
			deleteKv(itemKey(taskId, s.key));
			continue;
		}
		const exists = getKv<Followup | null>(itemKey(taskId, s.key), null);
		if (!exists && pendingFollowups(taskId).length >= MAX_PENDING) {
			skipped.push(s.key);
			continue;
		}
		setKv(itemKey(taskId, s.key), { taskId, key: s.key, at: s.at!, about: s.about!, kind, actionId, created: at } satisfies Followup);
		log("约了复查", taskId, s.key, new Date(s.at! * 1000).toLocaleString("sv-SE"));
	}
	return skipped.length ? `这件事约的复查已经有 ${MAX_PENDING} 个，${skipped.join("、")} 没有记上` : "";
}

export const pendingFollowups = (taskId: string) =>
	listKv<Followup>(`fu:${taskId}:`)
		.map((x) => x.value)
		.toSorted((a, b) => a.at - b.at);

export function cancelFollowup(taskId: string, key: string) {
	deleteKv(itemKey(taskId, key));
}

/** Yi 关掉了这件事（完成、不回复、放弃）：约好的复查不再跑 */
export function cancelFollowups(taskId: string | null | undefined) {
	if (!taskId) return;
	for (const f of pendingFollowups(taskId)) deleteKv(itemKey(taskId, f.key));
}

/** 有人来了新消息、Yi 动了这件事：自动复查的次数重新算 */
export function resetFollowupRuns(taskId: string) {
	deleteKv(countKey(taskId));
}

export interface FollowupRunner {
	/** 这件事是不是 Yi 关掉的（取消了）：是就不跑 */
	cancelled: (taskId: string) => boolean;
	draft: (f: Followup) => Promise<void>;
	dev: (f: Followup) => Promise<void>;
	/** 到了次数上限：告诉 Yi */
	exhausted: (f: Followup) => void;
}

/** 到期的复查：先删再跑（跑的时间可能很长，免得下一轮又捡起来）；失败记日志，不自动重试 */
export async function runDueFollowups(run: FollowupRunner, at = now()) {
	for (const { key, value: f } of listKv<Followup>("fu:")) {
		if (f.at > at) continue;
		deleteKv(key);
		if (run.cancelled(f.taskId)) {
			log("复查到期，但这件事已经取消了，不跑", f.taskId, f.key);
			continue;
		}
		const n = getKv<number>(countKey(f.taskId), 0);
		if (n >= MAX_RUNS) {
			log("这件事自动复查次数到上限，不跑", f.taskId, f.key);
			run.exhausted(f);
			continue;
		}
		setKv(countKey(f.taskId), n + 1);
		void (f.kind === "draft" ? run.draft(f) : run.dev(f)).catch((e) => log("复查失败", f.taskId, f.key, e));
	}
}
