// 看板状态：以「一件事」（tasks 表，见 taskstore.ts）为单位，每件带状态、等 Yi 做什么、时间线和挂着的产出。
// 还没分派的排队消息、分派前就失败的、记忆冲突，也按同样的形状给出（id 带前缀，不在 tasks 表里）。
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { and, count, desc, eq, gte, inArray, isNull, or } from "drizzle-orm";
import { PATHS, PI_MODEL, PI_THINKING } from "./config.ts";
import { db, schema } from "./db/index.ts";
import type { Draft, RecordRow } from "./db/schema.ts";
import { describe, learnOf, learnText, pendingApprovals } from "./approvals.ts";
import { draftLabel } from "./drafts/format.ts";
import { inflight } from "./drafts/store.ts";
import { draftMrs } from "./drafts/mr.ts";
import { NO_CHANGE, PATROL_OK, devTasksList } from "./dev.ts";
import { listStories } from "./stories.ts";
import { TASK_TIER, loadAgents, withTier } from "./agent/router.ts";
import { recentRecords } from "./records.ts";
import { conversationLog, running } from "./agent/driver.ts";
import { listMemories } from "./memory/store.ts";
import { now } from "./util.ts";
import { watchdogIssues } from "./watchdog.ts";
import { quotaNow } from "./quota.ts";
import { pendingFollowups } from "./followups.ts";
import { type Need, type Outputs, type TaskStatus, applyStatus, outputsOf } from "./taskstore.ts";

export type TaskEvent =
	| { k: "msg"; at: number; who: string; owner: boolean; text: string; url?: string | null }
	| { k: "route"; at: number; rule: string; agent: string | null; tier?: string; kind: string }
	| { k: "result"; at: number; outcome: string; detail?: string | null; ref?: string | null };

export interface TaskView {
	id: string;
	title: string;
	/** lark meego bot board alert cron memory */
	source: string;
	/** 谁、在哪 */
	label: string;
	status: TaskStatus;
	need: Need | null;
	worker?: string | null;
	tier?: string | null;
	created: number;
	updated: number;
	closed?: number | null;
	storyId?: string | null;
	scheduleId?: string | null;
	/** 排队里：Yi 正在这个聊天里聊，等到这个时间再起草 */
	hold?: number;
	/** 正在跑的运行（停止、看步骤用） */
	runId?: string;
	live?: string;
	/** 关闭时的一句话结果 */
	result?: string;
	error?: string | null;
	/** 失败可重试时交给 retryTask 的 id（fail-<消息> / qa-<消息>） */
	retryId?: string;
	drafts: string[];
	devTasks: string[];
	approvals: string[];
	/** 记忆冲突：两条记忆的 id */
	memories?: number[];
	events: TaskEvent[];
	/** agent 约好、还没到期的复查 */
	followups?: Array<{ key: string; at: number; about: string }>;
}

const OUTCOME: Record<string, string> = {
	sent: "已发送",
	discarded: "不回复",
	completed: "已完成",
	expired: "你已亲自回复",
	replied: "已回复",
	remembered: "已记住",
	pushed: "已创建 MR",
	merged: "已并入新草稿",
	dismissed: "已忽略",
	done: "已完成",
	failed: "失败",
};

/** 已结束的看最近 7 天；更早的去统计页看 */
const WINDOW = 7 * 86400;

export function taskViews(records: RecordRow[]): TaskView[] {
	const t = now();
	const rows = db()
		.select()
		.from(schema.tasks)
		.where(or(gte(schema.tasks.updated, t - WINDOW), isNull(schema.tasks.closed)))
		.orderBy(desc(schema.tasks.updated))
		.limit(500)
		.all();
	const outs = outputsOf(rows.map((r) => r.id));
	const trigIds = [...new Set([...outs.values()].flatMap((o) => o.routes.flatMap((r) => r.triggers)))];
	const triggers = trigIds.length ? db().select().from(schema.triggers).where(inArray(schema.triggers.id, trigIds)).all() : [];
	const trigById = new Map(triggers.map((x) => [x.id, x]));
	const views: TaskView[] = [];
	const covered = new Set<string>();
	for (const raw of rows) {
		const o = outs.get(raw.id)!;
		const row = applyStatus(raw, o);
		const trs = [...new Set(o.routes.flatMap((r) => r.triggers))]
			.map((id) => trigById.get(id))
			.filter((x) => x != null)
			.toSorted((a, b) => a.at - b.at);
		for (const x of trs) covered.add(x.id.slice(x.id.indexOf(":") + 1));
		views.push(view(row, o, trs, records));
	}
	const out = [...views, ...queued(t), ...unrouted(records, covered, t), ...conflicts()];
	return [...out, ...looseApprovals(out)].toSorted((a, b) => b.updated - a.updated);
}

/** 挂不到任何一件事上的待审批（私聊机器人提问发起的只有 label）：单独列一行，看板上也能批，和卡片谁先点谁生效 */
function looseApprovals(views: TaskView[]): TaskView[] {
	const shown = new Set(views.flatMap((v) => v.approvals));
	return pendingApprovals()
		.filter((a) => !shown.has(a.id))
		.map((a) => ({
			id: `apv:${a.id}`,
			title: `审批：${a.reason}`,
			source: "bot",
			label: a.origin,
			status: "blocked",
			need: "approve",
			created: a.created,
			updated: a.created,
			drafts: [],
			devTasks: [],
			approvals: [a.id],
			events: [],
		}));
}

function view(
	input: typeof schema.tasks.$inferSelect,
	o: Outputs,
	trs: Array<typeof schema.triggers.$inferSelect>,
	records: RecordRow[],
): TaskView {
	let row = input;
	const routes = o.routes.toSorted((a, b) => a.at - b.at);
	const acting = routes.filter((r) => ["draft", "qa", "dev"].includes(r.actionKind));
	const last = acting.at(-1);
	const drafts = o.drafts.toSorted((a, b) => a.created - b.created);
	const devs = o.devs.toSorted((a, b) => a.created - b.created);
	const draft = drafts.at(-1);
	const dev = devs.at(-1);
	const first = trs[0];
	const events: TaskEvent[] = [
		...trs.map((x) => ({
			k: "msg" as const,
			at: x.at,
			who: x.actorName || (x.owner ? "Yi" : ""),
			owner: x.owner,
			text: x.text,
			url: x.url,
			// 飞书消息 id：看板按它取消息里的图片
			mid: x.id.slice(x.id.indexOf(":") + 1),
		})),
		...routes.map((r) => ({ k: "route" as const, at: r.at, rule: r.rule, agent: r.agent, tier: r.info?.tier, kind: r.actionKind })),
		...o.results.map((r) => ({ k: "result" as const, at: r.at, outcome: r.outcome, detail: r.detail, ref: r.ref })),
	].toSorted((a, b) => a.at - b.at);
	const lastResult = o.results.toSorted((a, b) => b.at - a.at)[0];
	let result: string | undefined;
	if (row.status === "done" || row.status === "cancelled") {
		if (draft?.status === "noreply") result = "不用回复";
		else if (dev?.patrol && dev.summary.includes(PATROL_OK)) result = "本轮正常";
		else if (dev?.summary.trimStart().startsWith(NO_CHANGE)) result = "无变化";
		else if (lastResult) result = OUTCOME[lastResult.outcome] ?? lastResult.outcome;
	}
	// 失败了：按被回复的消息找到那条失败记录，重试走原来的 retryTask
	let retryId: string | undefined;
	let error: string | null | undefined = dev?.status === "failed" ? dev.error : undefined;
	if (row.need === "retry" && last && last.actionKind !== "dev") {
		const sources = new Set(last.triggers.map((id) => id.slice(id.indexOf(":") + 1)));
		// records 按时间倒序。失败之后 Yi 点了忽略（retry.ts dismissTask 只记流水），或者亲自回了（跳过走的是不处理的分派，不挂任务）：这件事就结束了
		const latest = records.find((r) => r.source && sources.has(r.source));
		if (latest?.status === "dismissed" || latest?.status === "skipped") {
			const status = latest.status === "dismissed" ? "cancelled" : "done";
			const closed = latest.ts;
			db().update(schema.tasks).set({ status, need: null, closed }).where(eq(schema.tasks.id, row.id)).run();
			row = { ...row, status, need: null, closed };
			result = latest.status === "dismissed" ? "已忽略" : "你已亲自回复";
		}
		const rec = records.find((r) => r.status === "failed" && r.source && sources.has(r.source));
		if (rec && row.need === "retry") {
			retryId = `${rec.kind === "draft" ? "fail" : "qa"}-${rec.source}`;
			error = rec.error;
		}
	}
	const runId =
		dev && (dev.status === "running" || dev.status === "pushing")
			? `dev-${dev.id}`
			: row.status === "in_progress"
				? [...running].find(([, r]) => r.sessionId && r.sessionId === last?.session)?.[0]
				: undefined;
	const label =
		first?.channel === "cron"
			? "" // 标题就是「定时 · <名字>」
			: first?.channel === "board"
				? "你派的"
				: draft
					? draftLabel(draft)
					: first?.channel === "bot"
						? "私聊机器人"
						: first?.actorName || "";
	return {
		id: row.id,
		title: dev && (row.source === "board" || row.source === "cron" || row.source === "alert") ? dev.title : row.title,
		source: row.source,
		label,
		status: row.status as TaskStatus,
		need: row.need as Need | null,
		worker: last?.agent ?? null,
		tier: last?.info?.tier ?? (last?.actionKind === "dev" ? "task" : null),
		created: row.created,
		updated: row.updated,
		closed: row.closed,
		storyId: devs.find((d) => d.storyId)?.storyId ?? null,
		scheduleId: first?.channel === "cron" ? first.thread.slice("cron:".length) : null,
		runId,
		live: runId ? running.get(runId)?.label : undefined,
		result,
		error,
		retryId,
		drafts: drafts.map((d) => d.id),
		devTasks: devs.map((d) => d.id),
		approvals: o.approvals.map((a) => a.id),
		events,
		followups: pendingFollowups(row.id).map((f) => ({ key: f.key, at: f.at, about: f.about })),
	};
}

/** 收到了、还没分派的消息：排队等起草，或者 Yi 正在聊、先等他回 */
function queued(t: number): TaskView[] {
	if (!inflight.size) return [];
	const mids = [...inflight.keys()];
	const routed = new Set(
		db()
			.select({ id: schema.triggers.id })
			.from(schema.triggers)
			.where(
				and(
					inArray(
						schema.triggers.id,
						mids.flatMap((m) => [`lark:${m}`, `meego:${m}`]),
					),
					gte(schema.triggers.routeId, 0),
				),
			)
			.all()
			.map((x) => x.id.slice(x.id.indexOf(":") + 1)),
	);
	const busy = new Set([...running.values()].map((r) => r.chatId).filter(Boolean));
	return [...inflight]
		.filter(([mid]) => !routed.has(mid))
		.map(([mid, i]) => ({
			id: `q:${mid}`,
			title: i.text,
			source: i.chatMode === "meego" ? "meego" : "lark",
			label: i.label,
			status: busy.has(i.chatId) ? "in_progress" : "todo",
			need: null,
			created: i.since,
			updated: i.since,
			hold: i.waitUntil && i.waitUntil > t ? i.waitUntil : undefined,
			drafts: [],
			devTasks: [],
			approvals: [],
			events: [{ k: "msg", at: i.since, who: i.label, owner: false, text: i.text }],
		}));
}

/** 分派之前就失败的（比如分诊出错）：还没有任务，按原来的失败记录给出，重试走 retryTask */
function unrouted(records: RecordRow[], covered: Set<string>, t: number): TaskView[] {
	const out: TaskView[] = [];
	const settled = new Set<string>();
	for (const r of records) {
		const key = r.source;
		if (!key || settled.has(key)) continue;
		settled.add(key);
		if (r.status !== "failed" || covered.has(key) || inflight.has(key) || r.ts < t - WINDOW) continue;
		out.push({
			id: `${r.kind === "draft" ? "fail" : "qa"}-${key}`,
			title: r.question ?? "",
			source: r.kind === "draft" ? "lark" : "bot",
			label: r.label ?? "",
			status: "blocked",
			need: "retry",
			created: r.ts,
			updated: r.ts,
			error: r.error,
			retryId: r.retry ? `${r.kind === "draft" ? "fail" : "qa"}-${key}` : undefined,
			drafts: [],
			devTasks: [],
			approvals: [],
			events: [{ k: "msg", at: r.ts, who: r.label ?? "", owner: false, text: r.question ?? "" }],
		});
	}
	return out;
}

/** 有冲突的记忆：两条一组，等 Yi 在记忆页裁定 */
function conflicts(): TaskView[] {
	const ms = listMemories(["contested"]);
	const seen = new Set<number>();
	const out: TaskView[] = [];
	for (const m of ms) {
		if (seen.has(m.id)) continue;
		const group = [m, ...ms.filter((x) => x.id !== m.id && (m.conflicts.includes(x.id) || x.conflicts.includes(m.id)))];
		for (const x of group) seen.add(x.id);
		out.push({
			id: `mem:${m.id}`,
			title: `记忆冲突：${group.map((x) => `「${x.content.slice(0, 30)}」`).join(" / ")}`,
			source: "memory",
			label: "记忆",
			status: "blocked",
			need: "decide",
			created: m.updated,
			updated: m.updated,
			memories: group.map((x) => x.id),
			drafts: [],
			devTasks: [],
			approvals: [],
			events: [],
		});
	}
	return out;
}

function todayTriggers(since: number): number {
	return db().select({ n: count() }).from(schema.triggers).where(gte(schema.triggers.at, since)).get()?.n ?? 0;
}

function todayOutcomes(since: number): Record<string, number> {
	const rows = db()
		.select({ outcome: schema.results.outcome, n: count() })
		.from(schema.results)
		.where(gte(schema.results.at, since))
		.groupBy(schema.results.outcome)
		.all();
	return Object.fromEntries(rows.map((r) => [r.outcome, r.n]));
}

/** 每个 agent：配置、正在跑什么、今天跑了多少、花了多少 */
function agentStats(records: RecordRow[], today: string) {
	const isToday = (ts: number) => new Date(ts * 1000).toLocaleDateString("sv-SE") === today;
	const tasks = devTasksList();
	return Object.entries(loadAgents().agents).map(([name, raw]) => {
		// 看板上派的任务按 deep 档跑：显示这一档的模型和思考强度
		const a = withTier(raw, TASK_TIER);
		const recs = records.filter((r) => r.agent === name && isToday(r.ts));
		const own = tasks.filter((t) => t.agent === name && isToday(t.updated));
		const cost = recs.reduce((c, r) => c + ((r.usage as any)?.cost ?? 0), 0) + own.reduce((c, t) => c + (t.usage?.cost ?? 0), 0);
		return {
			name,
			desc: a.desc ?? "",
			model: a.model ?? PI_MODEL,
			thinking: a.thinking ?? PI_THINKING,
			manual: Boolean(a.manual),
			readOnly: !a.tools?.includes("edit"),
			running: [...running.values()].filter((r) => r.agent === name).map((r) => ({ label: r.label, started: r.started })),
			runs: recs.filter((r) => r.status === "drafted" || r.status === "failed").length + own.reduce((n, t) => n + t.runs, 0),
			failed: recs.filter((r) => r.status === "failed").length + own.filter((t) => t.status === "failed").length,
			cost,
		};
	});
}

/** MR 预审的草稿带上对应的 MR 和已经做过的动作（approve、发评论），看板上按这个出按钮 */
function withMr(drafts: Draft[]) {
	const mrs = draftMrs(drafts);
	return drafts.map((d) => (mrs.has(d.id) ? { ...d, mr: mrs.get(d.id) } : d));
}

export function dashboardState() {
	const drafts = db().select().from(schema.drafts).orderBy(desc(schema.drafts.created)).limit(300).all();
	const records = recentRecords(1000);
	const items = taskViews(records);
	const today = new Date().toLocaleDateString("sv-SE");
	const todays = records.filter((r) => new Date(r.ts * 1000).toLocaleDateString("sv-SE") === today);
	const usage = { input: 0, output: 0, cacheRead: 0, cost: 0 };
	for (const r of todays) for (const k of Object.keys(usage) as Array<keyof typeof usage>) usage[k] += (r.usage as any)?.[k] ?? 0;
	const countRecords = (...st: string[]) => todays.filter((r) => st.includes(r.status)).length;
	// 进来多少、结果如何按四段模型的表算：trigger 是今天进来的事件，result 是今天走完的 action
	const dayStart = new Date(`${today}T00:00:00`).getTime() / 1000;
	const outcomes = todayOutcomes(dayStart);
	return {
		now: now(),
		stats: {
			requests: todayTriggers(dayStart),
			replied: outcomes.replied ?? 0,
			drafted: countRecords("drafted"),
			sent: outcomes.sent ?? 0,
			discarded: outcomes.discarded ?? 0,
			failed: outcomes.failed ?? 0,
			usage,
			waiting: items.filter((x) => x.status === "in_review" || x.status === "blocked").length,
		},
		running: running.size,
		inflight: inflight.size,
		items,
		drafts: withMr(drafts.slice(0, 200)),
		agents: agentStats(records, today),
		devTasks: devTasksList()
			.filter((t) => !t.chat)
			.toSorted((a, b) => b.created - a.created)
			.slice(0, 100),
		// 对话页：最近说过话的在前
		chats: devTasksList()
			.filter((t) => t.chat && t.status !== "discarded")
			.toSorted((a, b) => b.updated - a.updated)
			.slice(0, 50),
		records: records.slice(0, 300),
		// 需求：最近动过的在前
		stories: listStories().toSorted((a, b) => b.updated - a.updated),
		// 写操作审批：卡片和看板都能批；learn 是「执行并以后放行」会记进规则的那条
		approvals: pendingApprovals().map((a) => {
			const learn = learnOf(a);
			return { ...a, command: describe(a), learn: learn && learnText(learn) };
		}),
		issues: watchdogIssues(),
		quota: quotaNow(),
	};
}

export interface Step {
	t: number;
	kind: "call" | "text";
	tool?: string;
	args?: unknown;
	text?: string;
	result?: string;
	error?: boolean;
	done?: number;
}

/** 这一次运行的步骤：工具调用、结果、最后的回答。新运行在 durable 里，迁移前的在 pi 会话文件里 */
export async function sessionLog(sessionId: string | undefined, start?: number, end?: number): Promise<Step[]> {
	if (sessionId) {
		const steps = await conversationLog(sessionId, start, end).catch(() => undefined);
		if (steps) return steps;
	}
	return legacySessionLog(sessionId, start, end);
}

function legacySessionLog(sessionId: string | undefined, start?: number, end?: number): Step[] {
	if (!sessionId || !/^[\w-]+$/.test(sessionId) || !existsSync(PATHS.sessions)) return [];
	const file = readdirSync(PATHS.sessions)
		.filter((f) => f.endsWith(`_${sessionId}.jsonl`))
		.toSorted()
		.at(-1);
	if (!file) return [];
	const lo = (start ?? 0) - 5;
	const hi = (end ?? now()) + 5;
	const steps: Step[] = [];
	const calls = new Map<string, Step>();
	for (const line of readFileSync(path.join(PATHS.sessions, file), "utf8").split("\n")) {
		let e: any;
		try {
			e = JSON.parse(line);
		} catch {
			continue;
		}
		if (e.type !== "message") continue;
		const t = Date.parse(e.timestamp) / 1000;
		if (!(t >= lo && t <= hi)) continue;
		const m = e.message ?? {};
		const content: any[] = Array.isArray(m.content) ? m.content : [];
		if (m.role === "assistant") {
			for (const c of content) {
				if (c.type === "toolCall") {
					const step: Step = { t, kind: "call", tool: c.name, args: c.arguments ?? {} };
					calls.set(c.id, step);
					steps.push(step);
				} else if (c.type === "text" && c.text?.trim()) steps.push({ t, kind: "text", text: c.text.slice(0, 3000) });
			}
		} else if (m.role === "toolResult") {
			const text = content
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("\n");
			const step = calls.get(m.toolCallId);
			const target = step ?? { t, kind: "call" as const, tool: m.toolName, args: {} };
			Object.assign(target, { result: text.slice(0, 2000), error: Boolean(m.isError), done: t });
			if (!step) steps.push(target);
		}
	}
	return steps;
}
