// Task：一件事（docs/router-worker.md §2、docs/flow.md）。
// 分派（pipeline.ts decide）时决定这次分派属于哪件事：同一话题 / 工作项 / MR 的接着用，别的新建；
// 状态不在各流程里分散写，而是按挂着的产出（草稿、agent 任务、审批、结果）推出来再存回 tasks 表。
import { and, desc, eq, gte, inArray, isNull, like, or } from "drizzle-orm";
import { routeRules } from "./rules.ts";
import { db, getKv, schema, setKv } from "./db/index.ts";
import type { Approval, DevTask, Draft, ResultRow, RouteRow, TriggerRow } from "./db/schema.ts";
import { log, now } from "./util.ts";

export type TaskRow = typeof schema.tasks.$inferSelect;
export type TaskStatus = "todo" | "in_progress" | "in_review" | "blocked" | "done" | "cancelled";
export type Need = "send" | "approve" | "read" | "decide" | "retry";

const CLOSED = new Set(["done", "cancelled"]);
export const isClosed = (status: string) => CLOSED.has(status);

/** 话题、工作项、MR、机器人话题这类「一件事」的事件流：关闭后重开时间（routeRules().reopen）内再来消息就重开；私聊和群的主线只接没关闭的 */
const topical = (thread: string) => thread.includes("#") || /^(meego|gitlab):/.test(thread);

const newId = () => `tsk-${Math.round(now() * 1000).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

export interface AssignInput {
	actionKind: string;
	actionId?: string | null;
	/** 指定挂到哪件事上（草稿转任务） */
	taskId?: string | null;
	/** 新建时的标题；不给就用第一条 trigger 的正文 */
	title?: string;
	/** 不建任务：对话页的聊天 */
	noTask?: boolean;
}

/** 这次分派属于哪件事；remember、不处理、对话页聊天返回 null */
export function assignTask(triggerIds: string[], r: AssignInput, at = now()): string | null {
	if (r.noTask) return null;
	if (r.taskId) return touch(r.taskId, at);
	if (r.actionKind === "command") {
		const id = r.actionId ? taskOfAction(r.actionId) : null;
		return id ? touch(id, at) : null;
	}
	if (!["draft", "qa", "dev"].includes(r.actionKind)) return null;
	const trs = triggerIds.length ? db().select().from(schema.triggers).where(inArray(schema.triggers.id, triggerIds)).all() : [];
	const first = trs.toSorted((a, b) => a.at - b.at)[0];
	if (!first) return null;
	const refs = [...new Set(trs.flatMap((t) => t.refs))];
	// 定时任务每次一件；告警新批每次一件（续批由 alerts.ts 记成 command）；看板派活每次一件，提到 MR 的挂到那个 MR 的事上
	const fresh =
		first.channel === "cron" || (first.channel === "board" && !refs.length) || (first.channel === "alert" && r.actionKind === "dev");
	const actors = new Set(trs.filter((t) => !t.owner && t.actorId).map((t) => t.actorId));
	const hit = fresh ? undefined : findOpen(first.thread, refs, actors, at);
	if (hit) return touch(hit, at);
	const id = newId();
	db()
		.insert(schema.tasks)
		.values({
			id,
			title: (r.title ?? firstLine(first.text)).slice(0, 200),
			source: first.channel,
			thread: first.thread,
			refs,
			status: "todo",
			created: at,
			updated: at,
		})
		.run();
	return id;
}

/** 标题取正文第一行；图片只留「[图片]」，不把 img_v3_… 这串 key 当标题 */
const firstLine = (s: string) => {
	const text = s.replace(/\[图片 [^\]]+\]/g, "[图片]").trim();
	const line =
		text
			.split("\n")
			.find((l) => l.trim())
			?.trim() ?? text;
	return line === "[图片]" ? "发来一张截图" : line;
};

/**
 * 同一事件流（或提到同一个 MR）上最近的那件事，还能接着用就返回它：
 * - 提到 MR：只接同一个 MR 的那件事（开着的，或关闭后 reopen 内）；同一会话里别的事不并，MR 自成一件
 * - 话题、工作项：开着的直接接，关闭后 reopen 内重开
 * - 私聊和群主线：同一个人的才接（群里别人的事不并），开着的直接接，关闭后 continueGap 内也算接着聊
 */
function findOpen(thread: string, refs: string[], actors: Set<string>, at: number): string | undefined {
	const { reopen: ttl, continueGap } = routeRules();
	const conds = [eq(schema.tasks.thread, thread), ...refs.map((r) => like(schema.tasks.refs, `%"${r}"%`))];
	const rows = db()
		.select()
		.from(schema.tasks)
		.where(and(or(...conds), gte(schema.tasks.updated, at - Math.max(ttl, continueGap))))
		.orderBy(desc(schema.tasks.updated))
		.limit(10)
		.all();
	const sameRef = (t: TaskRow) => refs.some((r) => t.refs.includes(r));
	const reusable = (t: TaskRow, within: number) => {
		const cur = refreshTask(t.id) ?? t;
		return !isClosed(cur.status) || (cur.closed ?? 0) >= at - within;
	};
	if (refs.length) return rows.find((t) => sameRef(t) && reusable(t, ttl))?.id;
	for (const t of rows) {
		if (t.thread !== thread) continue;
		if (topical(thread)) {
			if (reusable(t, ttl)) return t.id;
			continue;
		}
		// 群主线里别人的事不并进来；Yi 自己的消息（私聊机器人这类）没有对方，不比
		if (actors.size && !actorsOf(t.id).some((a) => actors.has(a))) continue;
		const cur = refreshTask(t.id) ?? t;
		if (!isClosed(cur.status) || (continueGap > 0 && (cur.closed ?? 0) >= at - continueGap)) return t.id;
	}
}

/** 这件事里对方（不含 Yi）是哪几个人 */
function actorsOf(taskId: string): string[] {
	return db()
		.selectDistinct({ id: schema.triggers.actorId })
		.from(schema.triggers)
		.innerJoin(schema.routes, eq(schema.triggers.routeId, schema.routes.id))
		.where(and(eq(schema.routes.taskId, taskId), eq(schema.triggers.owner, false)))
		.all()
		.map((x) => x.id)
		.filter(Boolean);
}

/** 挂上一次新的分派：时间往后推。关闭的会不会重开不在这里定，refreshTask 按最新一次分派的产出重推 */
function touch(id: string, at: number): string | null {
	const row = db().select({ id: schema.tasks.id }).from(schema.tasks).where(eq(schema.tasks.id, id)).get();
	if (!row) return null;
	db().update(schema.tasks).set({ updated: at }).where(eq(schema.tasks.id, id)).run();
	return id;
}

/** 草稿 id 或 agent 任务 id → 它所在的那件事 */
export function taskOfAction(actionId: string): string | null {
	const draft = db().select({ routeId: schema.drafts.routeId }).from(schema.drafts).where(eq(schema.drafts.id, actionId)).get();
	const dev = draft
		? undefined
		: db().select({ routeId: schema.devTasks.routeId }).from(schema.devTasks).where(eq(schema.devTasks.id, actionId)).get();
	const routeId = draft?.routeId ?? dev?.routeId;
	if (routeId == null) return null;
	return db().select({ taskId: schema.routes.taskId }).from(schema.routes).where(eq(schema.routes.id, routeId)).get()?.taskId ?? null;
}

// ---------- 状态：按产出推 ----------

export interface Outputs {
	routes: RouteRow[];
	drafts: Draft[];
	devs: DevTask[];
	approvals: Approval[];
	results: ResultRow[];
}

const DRAFT: Record<string, [TaskStatus, Need?]> = {
	pending: ["in_review", "send"],
	// 建议不回：直接完成，不打扰（docs/flow.md §6）；看板「今天完成」里能翻到、能撤回
	noreply: ["done"],
	sending: ["in_progress"],
	revising: ["in_progress"],
	sent: ["done"],
	completed: ["done"],
	expired: ["done"],
	discarded: ["cancelled"],
	replaced: ["done"],
	merged: ["done"],
};

export function deriveStatus(o: Outputs): { status: TaskStatus; need: Need | null } {
	if (o.approvals.some((a) => a.status === "pending")) return { status: "blocked", need: "approve" };
	// 最近一次产出动作的分派说了算：追问、改写、草稿转任务都会挂上新的分派
	const acting = o.routes.filter((r) => ["draft", "qa", "dev"].includes(r.actionKind)).toSorted((a, b) => b.at - a.at);
	const latest = acting[0];
	if (!latest) return { status: "todo", need: null };
	if (latest.actionKind === "dev") {
		// 告警续批、回复任务通知是 command，指向同一个 agent 任务：取最近更新的那个
		const dev = o.devs.toSorted((a, b) => b.updated - a.updated)[0];
		if (dev) return devStatus(dev);
	}
	if (latest.actionKind === "draft") {
		const d = o.drafts.filter((x) => x.routeId === latest.id).toSorted((a, b) => b.created - a.created)[0];
		if (d) {
			const [status, need] = DRAFT[d.status] ?? ["in_review", "send"];
			return { status, need: need ?? null };
		}
	}
	const res = o.results.filter((r) => r.routeId === latest.id).toSorted((a, b) => b.at - a.at)[0];
	if (res?.outcome === "failed") return { status: "blocked", need: "retry" };
	if (res) return { status: res.outcome === "discarded" ? "cancelled" : "done", need: null };
	return { status: "in_progress", need: null };
}

function devStatus(d: DevTask): { status: TaskStatus; need: Need | null } {
	switch (d.status) {
		case "running":
		case "pushing":
			return { status: "in_progress", need: null };
		case "review":
			return { status: "in_review", need: d.agent === "dev" ? "send" : "read" };
		case "failed":
			return { status: "blocked", need: "retry" };
		case "discarded":
			return { status: "cancelled", need: null };
		default:
			return { status: "done", need: null };
	}
}

/** 一批任务的产出，按 task id 分好 */
export function outputsOf(taskIds: string[]): Map<string, Outputs> {
	const out = new Map<string, Outputs>(taskIds.map((id) => [id, { routes: [], drafts: [], devs: [], approvals: [], results: [] }]));
	if (!taskIds.length) return out;
	const routes = db().select().from(schema.routes).where(inArray(schema.routes.taskId, taskIds)).all();
	const routeIds = routes.map((r) => r.id);
	const taskOfRoute = new Map(routes.map((r) => [r.id, r.taskId!]));
	for (const r of routes) out.get(r.taskId!)!.routes.push(r);
	if (!routeIds.length) return out;
	const drafts = db().select().from(schema.drafts).where(inArray(schema.drafts.routeId, routeIds)).all();
	for (const d of drafts) out.get(taskOfRoute.get(d.routeId!)!)!.drafts.push(d);
	// agent 任务：自己的分派，或续批 / 回复这类 command 指向它
	const devIds = [
		...new Set(routes.filter((r) => r.actionId && (r.actionKind === "dev" || r.actionKind === "command")).map((r) => r.actionId!)),
	];
	const devs = devIds.length ? db().select().from(schema.devTasks).where(inArray(schema.devTasks.id, devIds)).all() : [];
	const taskOfDev = new Map<string, string>();
	for (const d of devs) {
		const r = routes.find((x) => x.actionId === d.id);
		if (!r) continue;
		taskOfDev.set(d.id, r.taskId!);
		out.get(r.taskId!)!.devs.push(d);
	}
	const results = db().select().from(schema.results).where(inArray(schema.results.routeId, routeIds)).all();
	for (const r of results) out.get(taskOfRoute.get(r.routeId!)!)!.results.push(r);
	// 审批：agent 任务发起的按任务对；起草发起的按被回复的那条消息对到 trigger
	const replyTos = new Map<string, string>();
	for (const r of routes) for (const t of r.triggers) replyTos.set(t.slice(t.indexOf(":") + 1), r.taskId!);
	const conds = [];
	if (devs.length)
		conds.push(
			inArray(
				schema.approvals.devTaskId,
				devs.map((d) => d.id),
			),
		);
	if (replyTos.size) conds.push(inArray(schema.approvals.draftReplyTo, [...replyTos.keys()]));
	if (conds.length)
		for (const a of db()
			.select()
			.from(schema.approvals)
			.where(or(...conds))
			.all()) {
			const tid = (a.devTaskId && taskOfDev.get(a.devTaskId)) || (a.draftReplyTo && replyTos.get(a.draftReplyTo));
			if (tid) out.get(tid)!.approvals.push(a);
		}
	return out;
}

/** 按产出重推一件事的状态，变了就存回去；返回最新的行 */
export function refreshTask(id: string, outs?: Outputs): TaskRow | undefined {
	const row = db().select().from(schema.tasks).where(eq(schema.tasks.id, id)).get();
	if (!row) return;
	return applyStatus(row, outs ?? outputsOf([id]).get(id)!);
}

export function applyStatus(row: TaskRow, o: Outputs): TaskRow {
	const { status, need } = deriveStatus(o);
	if (status === row.status && need === row.need) return row;
	const t = now();
	// 关闭时间取最后一次产出的时间：回填、或者隔了一阵才刷新时，不把关闭时间记成现在
	const closed = isClosed(status) ? (row.closed ?? lastAt(o) ?? t) : null;
	db().update(schema.tasks).set({ status, need, updated: t, closed }).where(eq(schema.tasks.id, row.id)).run();
	return { ...row, status, need, updated: t, closed };
}

/** 这件事最后一次动静：结果、草稿、agent 任务的更新、分派里最晚的 */
function lastAt(o: Outputs): number | undefined {
	const ts = [
		...o.results.map((r) => r.at),
		...o.drafts.map((d) => d.created),
		...o.devs.map((d) => d.updated),
		...o.routes.map((r) => r.at),
	];
	return ts.length ? Math.max(...ts) : undefined;
}

// ---------- 回填 ----------

/** 上线前的分派补挂到任务上：按时间顺序走一遍和线上相同的归属规则。只处理还没挂的，重复跑无害 */
export function backfillTasks(days = 7) {
	if (getKv<boolean>("tasks:backfilled", false)) return;
	const since = now() - days * 86400;
	const rows = db()
		.select()
		.from(schema.routes)
		.where(and(isNull(schema.routes.taskId), gte(schema.routes.at, since)))
		.orderBy(schema.routes.at)
		.all();
	let n = 0;
	for (const r of rows) {
		const taskId = assignTask(r.triggers, { actionKind: r.actionKind, actionId: r.actionId, title: titleOfRoute(r) }, r.at);
		if (!taskId) continue;
		db().update(schema.routes).set({ taskId }).where(eq(schema.routes.id, r.id)).run();
		n++;
	}
	// 新建时都是 todo：按产出重推一遍
	const ids = db()
		.select({ id: schema.tasks.id })
		.from(schema.tasks)
		.all()
		.map((x) => x.id);
	const outs = outputsOf(ids);
	for (const id of ids) refreshTask(id, outs.get(id));
	setKv("tasks:backfilled", true);
	log(`任务回填：${rows.length} 次分派，挂上 ${n} 次，共 ${ids.length} 件`);
}

/** 回填时 agent 任务的标题比 trigger 正文好认 */
function titleOfRoute(r: RouteRow): string | undefined {
	if (r.actionKind !== "dev" || !r.actionId) return;
	return db().select({ title: schema.devTasks.title }).from(schema.devTasks).where(eq(schema.devTasks.id, r.actionId)).get()?.title;
}

export type { TriggerRow };
