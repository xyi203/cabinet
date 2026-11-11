// 定时任务（借鉴 multica 的 Autopilots）：到点记一条 cron trigger，交给只读 agent 开一个任务，结论每次都私聊 Yi 一张卡片。
// - cron 是 5 段（分 时 日 月 周），本机时区；支持 *、数字、a-b、a,b、*/n、a-b/n；日和周都限定时按任一满足算（同 Vixie cron）
// - 上一次的任务还在跑就跳过这一次；停机期间错过的只补跑一次
// - 提示里带上上一次任务的 ID，agent 可以用 lookup 查上次的结论，只说变化
import { desc, eq, inArray, like } from "drizzle-orm";
import { loadAgents } from "./agent/router.ts";
import { changed } from "./bus.ts";
import { cronSkip } from "./router/board.ts";
import { db, getKv, schema, setKv } from "./db/index.ts";
import type { AgentUi } from "./a2ui/surface.ts";
import type { DevTask, Schedule } from "./db/schema.ts";
import { NO_CHANGE, PATROL_OK, dispatch, getDevTask } from "./dev.ts";
import { DraftError } from "./drafts/store.ts";
import { decide, receive } from "./pipeline.ts";
import { log, now } from "./util.ts";

// ---------- cron ----------

const FIELDS: Array<[number, number]> = [
	[0, 59], // 分
	[0, 23], // 时
	[1, 31], // 日
	[1, 12], // 月
	[0, 7], // 周（0 和 7 都是周日）
];

export class CronError extends Error {}

function parseField(spec: string, [lo, hi]: [number, number]): Set<number> {
	const out = new Set<number>();
	for (const part of spec.split(",")) {
		const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
		if (!m) throw new CronError(`看不懂「${part}」`);
		const step = m[4] ? Number(m[4]) : 1;
		const from = m[1] === "*" ? lo : Number(m[2]);
		const to = m[1] === "*" ? hi : m[3] ? Number(m[3]) : m[4] ? hi : from;
		if (step < 1 || from < lo || to > hi || from > to) throw new CronError(`「${part}」超出范围 ${lo}-${hi}`);
		for (let v = from; v <= to; v += step) out.add(v);
	}
	return out;
}

export interface Cron {
	minute: Set<number>;
	hour: Set<number>;
	dom: Set<number>;
	month: Set<number>;
	dow: Set<number>;
	domAny: boolean;
	dowAny: boolean;
}

export function parseCron(expr: string): Cron {
	const parts = expr.trim().split(/\s+/);
	if (parts.length !== 5) throw new CronError("cron 要写 5 段：分 时 日 月 周，例如 0 9 * * 1-5");
	const [minute, hour, dom, month, dow] = parts.map((p, i) => parseField(p, FIELDS[i]));
	if (dow.has(7)) dow.add(0);
	return { minute, hour, dom, month, dow, domAny: parts[2] === "*", dowAny: parts[4] === "*" };
}

function matches(c: Cron, d: Date): boolean {
	if (!c.minute.has(d.getMinutes()) || !c.hour.has(d.getHours()) || !c.month.has(d.getMonth() + 1)) return false;
	const dom = c.dom.has(d.getDate());
	const dow = c.dow.has(d.getDay());
	// 日和周都限定了：任一满足就算；只限定一个：按那一个
	if (!c.domAny && !c.dowAny) return dom || dow;
	return dom && dow;
}

/** after 之后（不含）下一次触发的时间（秒）；一年内都不触发返回 undefined */
export function nextRun(expr: string | Cron, after: number): number | undefined {
	const c = typeof expr === "string" ? parseCron(expr) : expr;
	const d = new Date((Math.floor(after / 60) + 1) * 60 * 1000);
	for (let i = 0; i < 366 * 24 * 60; i++) {
		if (matches(c, d)) return d.getTime() / 1000;
		d.setMinutes(d.getMinutes() + 1);
	}
}

// ---------- 定时任务 ----------

export function listSchedules(): Schedule[] {
	return db().select().from(schema.schedules).all();
}

const getSchedule = (id: string) => db().select().from(schema.schedules).where(eq(schema.schedules.id, id)).get();

export interface ScheduleInput {
	id?: string;
	name: string;
	cron: string;
	agent: string;
	prompt: string;
	enabled?: boolean;
	model?: string | null;
	thinking?: string | null;
	/** 过了这个时间自动停用 */
	until?: number | null;
	patrol?: boolean;
	/** 按时间点跑（unix 秒）：给了就不解析 cron，cron 当说明；不给时 cron 没改就沿用原来的时间点 */
	times?: number[] | null;
}

/** 下一次运行：按时间点的取下一个，按 cron 的算出来；没有了返回 undefined */
export function upcoming(s: Pick<Schedule, "cron" | "times">, after: number): number | undefined {
	return s.times?.length ? s.times.find((x) => x > after) : nextRun(s.cron, after);
}

/** 新建或修改；校验 cron、agent（只能是只读 agent）和内容 */
export function saveSchedule(input: ScheduleInput): Schedule {
	const name = input.name.trim();
	const prompt = input.prompt.trim();
	if (!name) throw new DraftError("给定时任务起个名字");
	if (!prompt) throw new DraftError("写上要 agent 做什么");
	const old = input.id ? getSchedule(input.id) : undefined;
	if (input.id && !old) throw new DraftError("定时任务不存在");
	// 按时间点的任务在看板上编辑时 cron 一栏是说明文字，没改就沿用原来的时间点
	const times =
		input.times !== undefined
			? input.times?.length
				? input.times.toSorted((a, b) => a - b)
				: null
			: old?.times?.length && old.cron === input.cron.trim()
				? old.times
				: null;
	if (!times)
		try {
			parseCron(input.cron);
		} catch (e) {
			throw new DraftError((e as Error).message);
		}
	const agent = loadAgents().agents[input.agent];
	if (!agent) throw new DraftError(`没有 agent ${input.agent}`);
	if (input.agent === "dev") throw new DraftError("开发任务要选仓库和分支，不能定时跑；换一个只读 agent");
	const t = now();
	const enabled = input.enabled ?? true;
	const next = enabled ? (upcoming({ cron: input.cron, times }, t) ?? null) : null;
	const row: Schedule = {
		id: old?.id ?? `cron-${Date.now()}`,
		name,
		cron: input.cron.trim(),
		agent: input.agent,
		prompt,
		enabled,
		nextRun: next,
		lastRun: old?.lastRun ?? null,
		lastTask: old?.lastTask ?? null,
		model: input.model ?? old?.model ?? null,
		thinking: input.thinking ?? old?.thinking ?? null,
		until: input.until !== undefined ? input.until : (old?.until ?? null),
		times,
		patrol: input.patrol ?? old?.patrol ?? false,
		created: old?.created ?? t,
		updated: t,
	};
	db().insert(schema.schedules).values(row).onConflictDoUpdate({ target: schema.schedules.id, set: row }).run();
	changed();
	return row;
}

/**
 * 直接结束：停用并把结束时间记成现在，看板归到「已结束」，执行记录还能查；
 * 和暂停不同，结束的是这件事做完了，不会等着恢复。要再跑可以在看板上重新启用
 */
export function endSchedule(id: string): Schedule {
	const s = getSchedule(id);
	if (!s) throw new DraftError("定时任务不存在");
	const t = now();
	const until = s.until != null && s.until < t ? s.until : t;
	db().update(schema.schedules).set({ enabled: false, nextRun: null, until, updated: t }).where(eq(schema.schedules.id, id)).run();
	changed();
	log("结束定时任务", id, s.name);
	return getSchedule(id)!;
}

export function deleteSchedule(id: string) {
	if (!getSchedule(id)) throw new DraftError("定时任务不存在");
	db().delete(schema.schedules).where(eq(schema.schedules.id, id)).run();
	changed();
}

/**
 * 跑一次：记一条 cron trigger，上一次还在跑就跳过，否则交给 agent 开一个任务。
 * at 是这次的计划时间（立即运行时是现在），也是 trigger id 的一部分：同一次计划不会跑两遍。
 */
export async function fire(s: Schedule, at = now(), manual = false): Promise<string | undefined> {
	const tid = receive({
		channel: "cron",
		externalId: `${s.id}:${Math.round(at)}`,
		thread: `cron:${s.id}`,
		actorName: s.name,
		owner: true,
		text: s.prompt,
		at,
	});
	// 要不要跳过这一轮由 router 判（额度紧的巡检、上一次还在跑）
	const prev = s.lastTask ? getDevTask(s.lastTask) : undefined;
	const skip = cronSkip(s, manual, prev);
	if (skip) {
		decide([tid], { rule: `跳过：${skip}`, actionKind: "none" });
		log("定时任务跳过", s.id, skip);
		return;
	}
	const same = await patrolUnchanged(s, at, manual, prev);
	if (same) {
		decide([tid], { rule: `跳过：${same}`, actionKind: "none" });
		log("定时任务跳过", s.id, same);
		return;
	}
	const when = new Date(at * 1000).toLocaleString("sv-SE", { hour12: false }).slice(0, 16);
	const request = [
		`[定时任务「${s.name}」] ${manual ? "Yi 手动触发" : `计划时间 ${when}`}（${s.times?.length ? s.cron : `cron \`${s.cron}\``}）。这不是有人在等你回复，结论直接写给 Yi。`,
		s.prompt,
		prev
			? `上一次运行是 ${prev.id}：可以用 lookup ${prev.id} 看上次的结论，这次只说变化；和上次比没有变化时，第一行只写「${NO_CHANGE}」（之后可以跟一句说明），这一轮就直接归档、不打扰 Yi。`
			: "",
	]
		.filter(Boolean)
		.join("\n\n");
	// 巡检挂回发起它的需求：需求抽屉里看得到最近一轮，不然像是停了
	const storyId = s.patrol
		? db()
				.select({ id: schema.stories.id })
				.from(schema.stories)
				.where(like(schema.stories.tickets, `%"scheduleId":"${s.id}"%`))
				.get()?.id
		: undefined;
	const task = await dispatch({
		agent: s.agent,
		request,
		storyId,
		title: `定时 · ${s.name}`,
		triggers: [tid],
		rule: `定时任务：${s.name}`,
		notify: true,
		model: s.model ?? undefined,
		thinking: s.thinking ?? undefined,
		patrol: s.patrol,
	});
	db().update(schema.schedules).set({ lastRun: at, lastTask: task.id, updated: now() }).where(eq(schema.schedules.id, s.id)).run();
	changed();
	log("定时任务开跑", s.id, task.id);
	return task.id;
}

/** 巡检兜底间隔：工单一直没动，也至少隔这么久真跑一轮，看 Sentry 和接口耗时 */
const PATROL_MAX_SKIP = 2 * 3600;

/**
 * 巡检这一轮能不能不调模型：上一轮是「无变化 / 正常」、工单指纹（stories.ts patrolFingerprint）没变、离上次真跑不到两小时，就跳过。
 * 11-10 GD-45214 AB 期间 00:00~13:00 跑了 26 轮，全是「本轮无变化」。全量后巡检（按固定时间点）、手动运行不跳
 */
async function patrolUnchanged(
	s: Schedule,
	at: number,
	manual: boolean,
	prev?: Pick<DevTask, "status" | "summary">,
): Promise<string | undefined> {
	if (!s.patrol || manual || s.times?.length) return;
	let fp: string | undefined;
	try {
		const { patrolFingerprint } = await import("./stories.ts");
		fp = await patrolFingerprint(s.id);
	} catch (e) {
		log("读工单指纹失败，照常巡检", s.id, e);
	}
	if (!fp) return;
	const key = `patrolfp:${s.id}`;
	const last = getKv<{ fp: string; at: number } | null>(key, null);
	const quiet = prev?.status === "done" && (prev.summary.trimStart().startsWith(NO_CHANGE) || prev.summary.includes(PATROL_OK));
	if (quiet && last?.fp === fp && at - last.at < PATROL_MAX_SKIP) return "工单没有变化";
	setKv(key, { fp, at });
}

/** 一次运行在执行记录里的结果：conclusion 有结论 / quiet 正常或无变化 / failed 失败 / running 进行中 / skipped 跳过 */
export type RunOutcome = "conclusion" | "quiet" | "failed" | "running" | "skipped";

export interface ScheduleRun {
	/** 计划时间（手动运行时是点的时间） */
	at: number;
	outcome: RunOutcome;
	/** 状态的叫法：有结论 / 无变化 / 正常 / 失败 / 进行中 / 跳过 */
	label: string;
	/** 一句话：结论第一行、失败原因或跳过原因 */
	brief: string;
	/** 完整结论（Markdown）或完整报错，展开时看；太长的截断 */
	detail: string;
	/** 结论附带的结构化报告（A2UI），有就按它显示 detail */
	ui: AgentUi | null;
	/** 工作台里的那件事、助手任务；跳过的没有 */
	taskId: string | null;
	devId: string | null;
	/** 这件事还等你处理（看结论、重试） */
	waiting: boolean;
	cost: number | null;
	/** 从开始到结束的时长（秒）；还在跑的为空 */
	seconds: number | null;
}

/**
 * 一个定时任务的执行记录，新的在前。每次到点（或手动运行）都记了一条 cron trigger（thread = cron:<id>），
 * 顺着它的分派找到工作台里的那件事和助手任务；跳过的那次只有分派规则「跳过：原因」
 */
const DETAIL_MAX = 8000;
/** 列表里的一句话：去掉 Markdown 记号，以及和状态标签重复的「本轮无变化」「本轮巡查正常」开头 */
const plain = (line: string) =>
	line
		.replace(/^#+\s*/, "")
		.replace(/\*\*|`/g, "")
		.replace(new RegExp(`^(${NO_CHANGE}|${PATROL_OK})[。.，,:：；;\\s]*`), "")
		.trim();

export function scheduleRuns(id: string, limit = 200): ScheduleRun[] {
	const trig = db()
		.select({ at: schema.triggers.at, routeId: schema.triggers.routeId })
		.from(schema.triggers)
		.where(eq(schema.triggers.thread, `cron:${id}`))
		.orderBy(desc(schema.triggers.at))
		.limit(limit)
		.all();
	const routeIds = trig.map((t) => t.routeId).filter((x): x is number => x != null);
	const routes = routeIds.length ? db().select().from(schema.routes).where(inArray(schema.routes.id, routeIds)).all() : [];
	const byRoute = new Map(routes.map((r) => [r.id, r]));
	const devIds = routes.filter((r) => r.actionKind === "dev" && r.actionId).map((r) => r.actionId!);
	const devs = new Map(
		(devIds.length ? db().select().from(schema.devTasks).where(inArray(schema.devTasks.id, devIds)).all() : []).map((d) => [d.id, d]),
	);
	const taskIds = routes.map((r) => r.taskId).filter((x): x is string => Boolean(x));
	const tasks = new Map(
		(taskIds.length ? db().select().from(schema.tasks).where(inArray(schema.tasks.id, taskIds)).all() : []).map((t) => [t.id, t]),
	);
	return trig.map((t) => {
		const r = t.routeId != null ? byRoute.get(t.routeId) : undefined;
		const dev = r?.actionKind === "dev" && r.actionId ? devs.get(r.actionId) : undefined;
		const task = r?.taskId ? tasks.get(r.taskId) : undefined;
		const base = {
			at: t.at,
			taskId: task?.id ?? null,
			devId: dev?.id ?? null,
			waiting: false,
			cost: null,
			seconds: null,
			detail: "",
			ui: null,
		};
		if (!r) return { ...base, outcome: "running" as const, label: "进行中", brief: "等待分派" };
		if (!dev) return { ...base, outcome: "skipped" as const, label: "跳过", brief: r.rule.replace(/^跳过：/, "") || "这次没有运行" };
		const summary = dev.summary.trim();
		const first = summary.split("\n").find((l) => l.trim()) ?? "";
		const running = dev.status === "running" || dev.status === "pushing";
		const patrolOk = Boolean(dev.patrol) && summary.includes(PATROL_OK);
		const outcome: RunOutcome = running
			? "running"
			: dev.status === "failed"
				? "failed"
				: patrolOk || summary.startsWith(NO_CHANGE)
					? "quiet"
					: "conclusion";
		const LABEL = { running: "进行中", failed: "失败", quiet: patrolOk ? "正常" : "无变化", conclusion: "有结论", skipped: "跳过" };
		const detail = outcome === "failed" ? (dev.error ?? "") : summary;
		return {
			...base,
			outcome,
			label: LABEL[outcome],
			ui: outcome === "conclusion" ? (dev.ui ?? null) : null,
			detail: detail.length > DETAIL_MAX ? `${detail.slice(0, DETAIL_MAX)}\n\n…（太长了，完整内容在任务详情里）` : detail,
			brief:
				outcome === "failed"
					? (dev.error ?? "失败了").split("\n")[0]
					: plain(first) || (patrolOk ? "一切正常" : outcome === "quiet" ? "和上次一样" : ""),
			waiting: task?.status === "in_review" || task?.status === "blocked",
			cost: dev.usage?.cost ?? null,
			// 之后又追问过（不止一轮）时，开始到最后更新就不是这次运行的用时了，不给
			seconds: running || dev.runs > 1 ? null : Math.max(0, dev.updated - dev.created),
		};
	});
}

export async function runNow(id: string) {
	const s = getSchedule(id);
	if (!s) throw new DraftError("定时任务不存在");
	const task = await fire(s, now(), true);
	if (!task) throw new DraftError("上一次还在跑，这次跳过了");
	return task;
}

/** 到点的都跑一次，算出下一次；停机期间错过的只补一次 */
export async function due(t = now()) {
	for (const s of listSchedules()) {
		if (!s.enabled || s.nextRun == null || s.nextRun > t) continue;
		if (s.until != null && t > s.until) {
			db().update(schema.schedules).set({ enabled: false, nextRun: null, updated: t }).where(eq(schema.schedules.id, s.id)).run();
			log("定时任务到期，停用", s.id, s.name);
			changed();
			continue;
		}
		let next: number | null = null;
		try {
			next = upcoming(s, t) ?? null;
		} catch (e) {
			log("定时任务的 cron 坏了，停用", s.id, e);
		}
		// 下一次已经过了结束时间，这次就是最后一次：当场停用，不留一个 nextRun 挂到明年
		if (next != null && s.until != null && next > s.until) next = null;
		// 先推进下一次，再跑：跑的时候出错也不会每 30 秒重试一遍
		db()
			.update(schema.schedules)
			.set({ nextRun: next, enabled: next != null })
			.where(eq(schema.schedules.id, s.id))
			.run();
		try {
			await fire(s, s.nextRun);
		} catch (e) {
			log("定时任务失败", s.id, e);
		}
	}
}

let timer: NodeJS.Timeout | undefined;

export function startSchedules() {
	const loop = () => {
		void due()
			.catch((e) => log("定时任务检查失败", e))
			.finally(() => {
				timer = setTimeout(loop, 30_000);
				timer.unref();
			});
	};
	timer = setTimeout(loop, 10_000);
	timer.unref();
}

export function stopSchedules() {
	clearTimeout(timer);
}
