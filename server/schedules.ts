// 定时任务（借鉴 multica 的 Autopilots）：到点记一条 cron trigger，交给只读 agent 开一个任务，结论每次都私聊 Yi 一张卡片。
// - cron 是 5 段（分 时 日 月 周），本机时区；支持 *、数字、a-b、a,b、*/n、a-b/n；日和周都限定时按任一满足算（同 Vixie cron）
// - 上一次的任务还在跑就跳过这一次；停机期间错过的只补跑一次
// - 提示里带上上一次任务的 ID，agent 可以用 lookup 查上次的结论，只说变化
import { eq, like } from "drizzle-orm";
import { loadAgents } from "./agent/router.ts";
import { changed } from "./bus.ts";
import { PATROL_PAUSE_AT } from "./config.ts";
import { fiveHourUsed } from "./quota.ts";
import { db, schema } from "./db/index.ts";
import type { Schedule } from "./db/schema.ts";
import { NO_CHANGE, dispatch, getDevTask } from "./dev.ts";
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
}

/** 新建或修改；校验 cron、agent（只能是只读 agent）和内容 */
export function saveSchedule(input: ScheduleInput): Schedule {
	const name = input.name.trim();
	const prompt = input.prompt.trim();
	if (!name) throw new DraftError("给定时任务起个名字");
	if (!prompt) throw new DraftError("写上要 agent 做什么");
	let cron: Cron;
	try {
		cron = parseCron(input.cron);
	} catch (e) {
		throw new DraftError((e as Error).message);
	}
	const agent = loadAgents().agents[input.agent];
	if (!agent) throw new DraftError(`没有 agent ${input.agent}`);
	if (input.agent === "dev") throw new DraftError("开发任务要选仓库和分支，不能定时跑；换一个只读 agent");
	const t = now();
	const enabled = input.enabled ?? true;
	const next = enabled ? (nextRun(cron, t) ?? null) : null;
	const old = input.id ? getSchedule(input.id) : undefined;
	if (input.id && !old) throw new DraftError("定时任务不存在");
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
		patrol: input.patrol ?? old?.patrol ?? false,
		created: old?.created ?? t,
		updated: t,
	};
	db().insert(schema.schedules).values(row).onConflictDoUpdate({ target: schema.schedules.id, set: row }).run();
	changed();
	return row;
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
	// 巡检一天几十轮：Claude 5 小时额度快用完时跳过，把额度留给起草；手动触发不拦
	const used = fiveHourUsed();
	if (s.patrol && !manual && used != null && used >= PATROL_PAUSE_AT) {
		decide([tid], { rule: `跳过：Claude 5 小时额度已用 ${Math.round(used * 100)}%`, actionKind: "none" });
		log("巡检跳过：额度紧张", s.id, used);
		return;
	}
	const prev = s.lastTask ? getDevTask(s.lastTask) : undefined;
	if (prev?.status === "running") {
		decide([tid], { rule: `跳过：上一次（${prev.id}）还在跑`, actionKind: "none" });
		log("定时任务跳过：上一次还在跑", s.id, prev.id);
		return;
	}
	const when = new Date(at * 1000).toLocaleString("sv-SE", { hour12: false }).slice(0, 16);
	const request = [
		`[定时任务「${s.name}」] ${manual ? "Yi 手动触发" : `计划时间 ${when}`}（cron \`${s.cron}\`）。这不是有人在等你回复，结论直接写给 Yi。`,
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
			next = nextRun(s.cron, t) ?? null;
		} catch (e) {
			log("定时任务的 cron 坏了，停用", s.id, e);
		}
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
