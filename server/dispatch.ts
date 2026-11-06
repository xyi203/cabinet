// 分发页：现在谁在跑、谁在排队、最近每次分派去了哪、走完用了多久，以及「可疑」的会话（跑太久、排队太久、看门狗发现的问题）。
// 只读汇总；停止、重试走已有接口（abortRun、stopDev、messageDev）。参考 ace-cli 的会话分发 / 消息分派 / 对话自愈。
import { desc, inArray } from "drizzle-orm";
import { MAX_CONCURRENCY } from "./config.ts";
import { db, schema } from "./db/index.ts";
import { running } from "./agent/driver.ts";
import { sem } from "./agent/slots.ts";
import { devTasksList } from "./dev.ts";
import { inflight } from "./drafts/store.ts";
import { now } from "./util.ts";
import { watchdogIssues } from "./watchdog.ts";

/** 单次运行超过这么久算可疑（运行超时 PI_TIMEOUT 默认 10 分钟，到点会自己失败） */
export const SUSPECT_RUN = 5 * 60;
/** 消息进来这么久还没开始起草算可疑 */
export const SUSPECT_QUEUE = 5 * 60;

export interface Suspect {
	key: string;
	title: string;
	detail: string;
	/** 页面上给的操作：stop 停掉这次运行；retry 让 agent 任务继续；open 打开看看 */
	action?: { kind: "stop" | "retry" | "open"; ref: string };
}

export function suspects(t = now()): Suspect[] {
	const out: Suspect[] = [];
	for (const [key, r] of running) {
		const sec = t - r.started;
		if (sec < SUSPECT_RUN) continue;
		out.push({
			key: `run:${key}`,
			title: `运行了 ${Math.round(sec / 60)} 分钟还没结束`,
			detail: `${r.label}${r.agent ? ` · ${r.agent}` : ""}`,
			action: { kind: "stop", ref: key },
		});
	}
	const busyChats = new Set([...running.values()].map((r) => r.chatId).filter(Boolean));
	for (const [mid, i] of inflight) {
		if (busyChats.has(i.chatId) || t - i.since < SUSPECT_QUEUE) continue;
		out.push({
			key: `queue:${mid}`,
			title: `排队 ${Math.round((t - i.since) / 60)} 分钟还没开始起草`,
			detail: `${i.label}：${i.text.slice(0, 80)}`,
		});
	}
	// 最近一天失败、还没处理的 agent 任务：可以让它接着做
	for (const d of devTasksList())
		if (d.status === "failed" && !d.chat && t - d.updated < 86400)
			out.push({
				key: `failed:${d.id}`,
				title: "agent 任务失败",
				detail: `${d.title.slice(0, 60)}：${(d.error ?? "").slice(0, 120)}`,
				action: { kind: "retry", ref: d.id },
			});
	for (const i of watchdogIssues()) out.push({ key: `watch:${i.key}`, title: i.title, detail: i.detail });
	return out;
}

export interface RouteView {
	id: number;
	/** 进来的时间（第一条 trigger） */
	received: number | null;
	routed: number;
	/** 走完的时间（第一条 result） */
	settled: number | null;
	channel: string;
	actor: string;
	text: string;
	agent: string | null;
	tier: string | null;
	rule: string;
	actionKind: string;
	outcome: string | null;
}

/** 最近的分派：一次分派可以合并几条 trigger，取第一条的来源和内容 */
export function recentRoutes(limit = 50): RouteView[] {
	const routes = db().select().from(schema.routes).orderBy(desc(schema.routes.id)).limit(limit).all();
	if (!routes.length) return [];
	const tids = [...new Set(routes.flatMap((r) => r.triggers))];
	const triggers = new Map(
		(tids.length ? db().select().from(schema.triggers).where(inArray(schema.triggers.id, tids)).all() : []).map((x) => [x.id, x]),
	);
	const results = db()
		.select()
		.from(schema.results)
		.where(
			inArray(
				schema.results.routeId,
				routes.map((r) => r.id),
			),
		)
		.all();
	const firstResult = new Map<number, (typeof results)[number]>();
	for (const x of results.toSorted((a, b) => a.at - b.at))
		if (x.routeId != null && !firstResult.has(x.routeId)) firstResult.set(x.routeId, x);
	return routes.map((r) => {
		const tr = r.triggers.map((id) => triggers.get(id)).filter((x) => x != null);
		const first = tr[0];
		const res = firstResult.get(r.id);
		return {
			id: r.id,
			received: first ? Math.min(...tr.map((x) => x.at)) : null,
			routed: r.at,
			settled: res?.at ?? null,
			channel: first?.channel ?? "",
			actor: first?.actorName ?? "",
			text: (first?.text ?? "").slice(0, 200),
			agent: r.agent,
			tier: (r.info as Record<string, string>)?.tier ?? null,
			rule: r.rule,
			actionKind: r.actionKind,
			// 判成不处理的分派（比如 Yi 已经亲自回了）没有 result，不能当成还在进行
			outcome: res?.outcome ?? (r.actionKind === "none" ? "none" : null),
		};
	});
}

export function dispatchState(t = now()) {
	return {
		now: t,
		queue: { capacity: MAX_CONCURRENCY, free: sem.free, waiting: sem.waiting },
		running: [...running].map(([key, r]) => ({
			key,
			label: r.label,
			agent: r.agent ?? null,
			chatId: r.chatId ?? null,
			started: r.started,
			suspicious: t - r.started >= SUSPECT_RUN,
		})),
		inflight: [...inflight].map(([id, i]) => ({
			id,
			label: i.label,
			text: i.text.slice(0, 200),
			since: i.since,
			waitUntil: i.waitUntil ?? null,
		})),
		suspects: suspects(t),
		routes: recentRoutes(),
	};
}
