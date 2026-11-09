// 四段模型：trigger -> route -> action -> result。每段落库、带 ID、互相引用（docs/pipeline.md）。
// - trigger：渠道来的事件，过了程序规则才记；同一事件重复到达只记一次
// - route：一次分派的决定，可以合并几条 trigger，也可以决定不处理
// - action：现在仍是各自的表（drafts / dev_tasks / 问答的 records），route.actionId 指向它，它带 routeId 指回来
// - result：action 的最终结果，只经 settle() 写入；结果之后外部再有动静，作为新的 trigger 回到入口
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { changed } from "./bus.ts";
import { db, schema } from "./db/index.ts";
import type { ResultRow, RouteRow, Subscription, TriggerRow } from "./db/schema.ts";
import { MR_RE } from "./agent/router.ts";
import { assignTask } from "./taskstore.ts";
import { routeRules } from "./rules.ts";
import { now } from "./util.ts";

export type Channel = "lark" | "meego" | "bot" | "board" | "alert" | "cron";
export type ActionKind = "draft" | "qa" | "dev" | "remember" | "command" | "none";
export type Effect = "internal" | "bot" | "local" | "outward";

export interface TriggerInput {
	channel: Channel;
	/** 渠道内的 id（消息 id、任务 id） */
	externalId: string;
	thread: string;
	actorId?: string;
	actorName?: string;
	owner?: boolean;
	text: string;
	url?: string | null;
	at?: number;
}

export const triggerId = (channel: Channel, externalId: string) => `${channel}:${externalId}`;

/** 正文里提到的其他事件流：现在只认 GitLab MR */
export function refsOf(text: string): string[] {
	const refs = new Set<string>();
	const re = new RegExp(MR_RE.source, "g");
	for (const m of text.matchAll(re)) refs.add(`gitlab:${m[1]}!${m[2]}`);
	return [...refs];
}

/** 记下一条 trigger，返回它的 id；已经记过的不覆盖（trigger 落库后不再改内容） */
export function receive(t: TriggerInput): string {
	const id = triggerId(t.channel, t.externalId);
	db()
		.insert(schema.triggers)
		.values({
			id,
			channel: t.channel,
			thread: t.thread,
			actorId: t.actorId ?? "",
			actorName: t.actorName ?? "",
			owner: Boolean(t.owner),
			text: t.text.slice(0, 2000),
			url: t.url ?? null,
			refs: refsOf(t.text),
			at: t.at ?? now(),
			status: "received",
		})
		.onConflictDoNothing()
		.run();
	return id;
}

export interface RouteInput {
	/** null：决定不处理 */
	agent?: string | null;
	rule: string;
	session?: string | null;
	info?: Record<string, string>;
	actionKind: ActionKind;
	actionId?: string | null;
	/** 挂到指定的任务上（草稿转任务）；不给就按 thread / MR 归属（taskstore.ts assignTask） */
	taskId?: string | null;
	/** 新建任务时的标题 */
	title?: string;
	/** 不算一件事：对话页的聊天 */
	noTask?: boolean;
}

/** 记下一次分派，把这批 trigger 标成已分派（不处理的标成跳过），返回 route id */
export function decide(triggerIds: string[], r: RouteInput): number {
	// 归属要查已有任务的状态，放在事务外面先定
	const taskId = assignTask(triggerIds, r);
	const id = db().transaction((tx) => {
		const row = tx
			.insert(schema.routes)
			.values({
				triggers: triggerIds,
				agent: r.agent ?? null,
				rule: r.rule,
				session: r.session ?? null,
				info: r.info ?? {},
				actionKind: r.actionKind,
				actionId: r.actionId ?? null,
				at: now(),
				taskId,
			})
			.returning({ id: schema.routes.id })
			.get();
		if (triggerIds.length)
			tx.update(schema.triggers)
				.set({ status: r.actionKind === "none" ? "skipped" : "routed", routeId: row.id })
				.where(inArray(schema.triggers.id, triggerIds))
				.run();
		return row.id;
	});
	if (taskId) changed();
	return id;
}

/**
 * 这批 trigger 上还没走完的那次分派：同一种 action、还没有结果。重启接回时沿用它，不重新分诊——
 * 重新分诊可能换了 agent 和会话，同一个 requestId 就接不回 durable 里原来那次运行了。
 * 已经有结果的（比如失败了，手动重试）不算，重试是一次新的分派。
 */
export function openRoute(triggerIds: string[], actionKind: ActionKind): RouteRow | undefined {
	if (!triggerIds.length) return;
	const rows = db().select({ routeId: schema.triggers.routeId }).from(schema.triggers).where(inArray(schema.triggers.id, triggerIds)).all();
	const ids = new Set(rows.map((r) => r.routeId));
	if (rows.length !== triggerIds.length || ids.size !== 1) return;
	const routeId = [...ids][0];
	if (routeId == null) return;
	const route = db().select().from(schema.routes).where(eq(schema.routes.id, routeId)).get();
	if (!route || route.actionKind !== actionKind) return;
	const done = db().select({ id: schema.results.id }).from(schema.results).where(eq(schema.results.routeId, routeId)).get();
	return done ? undefined : route;
}

/** action 产出之后补上 route 指向它（起草要跑完才知道草稿 id） */
export function linkAction(routeId: number, actionId: string, session?: string | null) {
	db()
		.update(schema.routes)
		.set({ actionId, ...(session ? { session } : {}) })
		.where(eq(schema.routes.id, routeId))
		.run();
}

export interface ResultInput {
	actionKind: ActionKind;
	actionId?: string | null;
	routeId?: number | null;
	outcome: string;
	effect: Effect;
	ref?: string | null;
	detail?: string | null;
}

/** 记下 action 的最终结果。所有结果都从这里写，看板和记忆提取都读这一张表 */
export function settle(r: ResultInput) {
	db()
		.insert(schema.results)
		.values({
			actionKind: r.actionKind,
			actionId: r.actionId ?? null,
			routeId: r.routeId ?? null,
			outcome: r.outcome,
			effect: r.effect,
			ref: r.ref ?? null,
			detail: r.detail?.slice(0, 500) ?? null,
			at: now(),
		})
		.run();
	changed();
}

export interface Lineage {
	trigger: TriggerRow;
	route?: RouteRow;
	results: ResultRow[];
}

/** 一条 trigger 走到了哪：分派给谁、产出了什么、结果如何。看板和以后的链式召回都用它 */
export function lineage(id: string): Lineage | undefined {
	const trigger = db().select().from(schema.triggers).where(eq(schema.triggers.id, id)).get();
	if (!trigger) return;
	const route = trigger.routeId ? db().select().from(schema.routes).where(eq(schema.routes.id, trigger.routeId)).get() : undefined;
	const results = route
		? db().select().from(schema.results).where(eq(schema.results.routeId, route.id)).orderBy(schema.results.at).all()
		: [];
	return { trigger, route, results };
}

/** 最近的 trigger 和各自的去向，按时间倒序 */
export function recentLineage(limit = 200): Lineage[] {
	const triggers = db().select().from(schema.triggers).orderBy(desc(schema.triggers.at)).limit(limit).all();
	const routeIds = [...new Set(triggers.map((t) => t.routeId).filter((x): x is number => x != null))];
	const routes = routeIds.length ? db().select().from(schema.routes).where(inArray(schema.routes.id, routeIds)).all() : [];
	const results = routeIds.length ? db().select().from(schema.results).where(inArray(schema.results.routeId, routeIds)).all() : [];
	const byId = new Map(routes.map((r) => [r.id, r]));
	return triggers.map((trigger) => ({
		trigger,
		route: trigger.routeId ? byId.get(trigger.routeId) : undefined,
		results: results.filter((r) => r.routeId === trigger.routeId).toSorted((a, b) => a.at - b.at),
	}));
}

// ---------- 订阅：事件流 / 被引用的 MR -> agent 会话（订阅直通） ----------

/**
 * 能订阅的键：话题和飞书项目工作项这类「一件事」的事件流，加上提到的 MR。
 * 整个群聊、整个私聊不订阅：否则之后群里所有消息都会被拉进同一个会话。refs 排在前面，命中时优先。
 */
export function subscribable(thread: string, refs: string[]): string[] {
	const keys = [...refs];
	if (thread.startsWith("meego:") || (thread.startsWith("lark:") && thread.includes("#"))) keys.push(thread);
	return [...new Set(keys)];
}

/** 这些键里最先命中、最近还在用的订阅；过了重开时间（routeRules().reopen）没用到的不算 */
export function subscriber(keys: string[]): Subscription | undefined {
	if (!keys.length) return;
	const since = now() - routeRules().reopen;
	const rows = db()
		.select()
		.from(schema.subscriptions)
		.where(and(inArray(schema.subscriptions.key, keys), gte(schema.subscriptions.updated, since)))
		.all();
	for (const k of keys) {
		const hit = rows.filter((r) => r.key === k).toSorted((a, b) => b.updated - a.updated)[0];
		if (hit) return hit;
	}
}

/** 把这些键挂到会话上；已经挂着的刷新时间 */
export function subscribe(keys: string[], s: { agent: string; session: string; info?: Record<string, string>; routeId?: number }) {
	const t = now();
	for (const key of keys)
		db()
			.insert(schema.subscriptions)
			.values({ key, agent: s.agent, session: s.session, info: s.info ?? {}, routeId: s.routeId ?? null, updated: t })
			.onConflictDoUpdate({
				target: [schema.subscriptions.key, schema.subscriptions.session],
				set: { agent: s.agent, info: s.info ?? {}, routeId: s.routeId ?? null, updated: t },
			})
			.run();
}

export function subscriptionsOf(key: string): Subscription[] {
	return db()
		.select()
		.from(schema.subscriptions)
		.where(eq(schema.subscriptions.key, key))
		.orderBy(desc(schema.subscriptions.updated))
		.all();
}
