// 看板状态：以「一件事」（tasks 表，见 taskstore.ts）为单位，每件带状态、等 Yi 做什么、时间线和挂着的产出。
// 还没分派的排队消息、分派前就失败的、记忆冲突，也按同样的形状给出（id 带前缀，不在 tasks 表里）。
import { createHash } from "node:crypto";
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
import { latestRecord, recentRecords } from "./records.ts";
import { conversationLog, running } from "./agent/driver.ts";
import { now } from "./util.ts";
import { watchdogIssues } from "./watchdog.ts";
import { quotaNow } from "./quota.ts";
import { getAsk } from "./asks.ts";
import { pendingFollowups } from "./followups.ts";
import { openSuggestions } from "./suggestions.ts";
import { type Need, type Outputs, type TaskStatus, applyStatus, outputsOf } from "./taskstore.ts";

export type TaskEvent =
	| { k: "msg"; at: number; who: string; owner: boolean; text: string; url?: string | null }
	| { k: "route"; at: number; rule: string; agent: string | null; tier?: string; kind: string }
	| { k: "result"; at: number; outcome: string; detail?: string | null; ref?: string | null }
	/** Yi 在看板 / 卡片上对助手说的话（改写意见、让它先去查什么、办完后接着追问），不是发给对方的 */
	| { k: "ask"; at: number; text: string };

export interface TaskView {
	id: string;
	title: string;
	/** lark meego doc bot board alert cron */
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
	/** 还没起草、在等 Yi 批准的消息：分诊出的档位 */
	approval?: string;
	/** 正在跑的运行（停止、看步骤用） */
	runId?: string;
	live?: string;
	/** 正在跑的那次运行从什么时候开始：看板按它只取这一次的执行记录（同一会话里还有以前几轮） */
	liveSince?: number;
	/** 关闭时的一句话结果 */
	result?: string;
	error?: string | null;
	/** 失败可重试时交给 retryTask 的 id（fail-<消息> / qa-<消息>） */
	retryId?: string;
	drafts: string[];
	devTasks: string[];
	approvals: string[];
	/** 记忆冲突：两条记忆的 id */
	events: TaskEvent[];
	/** agent 约好、还没到期的复查 */
	followups?: Array<{ key: string; at: number; about: string; until?: string }>;
	/** agent 挂着等 Yi 拍板的提问（server/asks.ts） */
	ask?: { title: string; options: string[]; recommend?: number; about: string; at: number };
}

function askView(taskId: string): TaskView["ask"] {
	const a = getAsk(taskId);
	return a && { title: a.title, options: a.options, recommend: a.recommend, about: a.about, at: a.created };
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
	const asks = asksOf([...outs.values()].flatMap((o) => o.drafts.map((d) => d.id)));
	const trigIds = [...new Set([...outs.values()].flatMap((o) => o.routes.flatMap((r) => r.triggers)))];
	const asked = askedOf(trigIds.map((id) => id.slice(id.indexOf(":") + 1)));
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
		views.push(view(row, o, trs, asks, asked));
	}
	const out = [...views, ...queued(t), ...unrouted(records, covered, t)];
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

/**
 * 草稿上 Yi 对助手说的话（改写意见、让它先去查什么、办完后接着追问），question 是他的原话。
 * 现在说出口就记一条 instructed 流水（drafts/actions.ts instructed）；之前只有跑完才写的 revised 流水，
 * 老数据从 revised 读（减去耗时才是说话的时刻），同一句已经有 instructed 的就不再重复。
 * 追问带「接着追问：」前缀，MR 上的追问走复审带「复审：Yi 追问：」；自动复审、到期复查不是他说的，不进来
 */
export function asksOf(draftIds: string[]): Map<string, Array<{ at: number; text: string }>> {
	const out = new Map<string, Array<{ at: number; text: string }>>();
	if (!draftIds.length) return out;
	const rows = db()
		.select({
			dm: schema.records.dm,
			ts: schema.records.ts,
			status: schema.records.status,
			seconds: schema.records.seconds,
			question: schema.records.question,
		})
		.from(schema.records)
		.where(
			and(
				eq(schema.records.kind, "draft"),
				inArray(schema.records.status, ["instructed", "revised"]),
				inArray(schema.records.dm, draftIds),
			),
		)
		.all();
	const said = new Set(rows.filter((r) => r.status === "instructed").map((r) => `${r.dm}\n${r.question}`));
	for (const r of rows) {
		const q = r.question?.trim();
		if (!r.dm || !q) continue;
		if (r.status === "revised" && said.has(`${r.dm}\n${r.question}`)) continue;
		let text = q;
		if (q.startsWith("接着追问：")) text = q.slice("接着追问：".length);
		else if (q.startsWith("复审：Yi 追问：")) text = q.slice("复审：Yi 追问：".length);
		else if (q.startsWith("复审：") || q.startsWith("到期复查：")) continue;
		const list = out.get(r.dm) ?? [];
		list.push({ at: r.status === "revised" ? r.ts - (r.seconds ?? 0) : r.ts, text: text.trim() });
		out.set(r.dm, list);
	}
	return out;
}

/** 消息还没起草时 Yi 交代的话（drafts/make.ts draftWithAsk 记的 asked 流水），按消息 id 分组 */
function askedOf(mids: string[]): Map<string, Array<{ at: number; text: string }>> {
	const out = new Map<string, Array<{ at: number; text: string }>>();
	if (!mids.length) return out;
	const rows = db()
		.select({ source: schema.records.source, ts: schema.records.ts, question: schema.records.question })
		.from(schema.records)
		.where(and(eq(schema.records.kind, "draft"), eq(schema.records.status, "asked"), inArray(schema.records.source, mids)))
		.all();
	for (const r of rows) {
		if (!r.source || !r.question?.trim()) continue;
		const list = out.get(r.source) ?? [];
		list.push({ at: r.ts, text: r.question.trim() });
		out.set(r.source, list);
	}
	return out;
}

function view(
	input: typeof schema.tasks.$inferSelect,
	o: Outputs,
	trs: Array<typeof schema.triggers.$inferSelect>,
	asks: Map<string, Array<{ at: number; text: string }>>,
	asked: Map<string, Array<{ at: number; text: string }>>,
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
		...drafts.flatMap((d) => (asks.get(d.id) ?? []).map((a) => ({ k: "ask" as const, at: a.at, text: a.text }))),
		...trs.flatMap((x) => (asked.get(x.id.slice(x.id.indexOf(":") + 1)) ?? []).map((a) => ({ k: "ask" as const, at: a.at, text: a.text }))),
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
		// 这几条消息最新的记录：失败之后 Yi 点了忽略（retry.ts dismissTask 只记流水），或者亲自回了（跳过走的是不处理的分派，不挂任务）：这件事就结束了
		const latest = latestRecord([...sources]);
		if (latest?.status === "dismissed" || latest?.status === "skipped") {
			const status = latest.status === "dismissed" ? "cancelled" : "done";
			const closed = latest.ts;
			db().update(schema.tasks).set({ status, need: null, closed }).where(eq(schema.tasks.id, row.id)).run();
			row = { ...row, status, need: null, closed };
			result = latest.status === "dismissed" ? "已忽略" : "你已亲自回复";
		}
		const rec = latestRecord([...sources], { status: "failed" });
		if (rec && row.need === "retry") {
			retryId = `${rec.kind === "draft" ? "fail" : "qa"}-${rec.source}`;
			error = rec.error;
		}
		// 失败记录没了也别只写「这次处理失败了」：时间线上最后一次失败的原因还在
		if (row.need === "retry" && !error && lastResult?.outcome === "failed") error = lastResult.detail;
	}
	// 办完 / 等你的事在起草的会话里又跑起来了（接着追问、到期复查、复审）：任务行没改状态，看板上按进行中显示，不然看不出它在查
	const rerunId =
		row.status !== "in_progress" && draft?.session
			? [...running].find(([, r]) => r.sessionId && r.sessionId === draft.session)?.[0]
			: undefined;
	const runId =
		dev && (dev.status === "running" || dev.status === "pushing")
			? `dev-${dev.id}`
			: row.status === "in_progress"
				? [...running].find(([, r]) => r.sessionId && r.sessionId === last?.session)?.[0]
				: rerunId;
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
		status: (rerunId ? "in_progress" : row.status) as TaskStatus,
		need: (rerunId ? null : row.need) as Need | null,
		worker: last?.agent ?? null,
		tier: last?.info?.tier ?? (last?.actionKind === "dev" ? "task" : null),
		created: row.created,
		updated: row.updated,
		closed: row.closed,
		storyId: devs.find((d) => d.storyId)?.storyId ?? null,
		scheduleId: first?.channel === "cron" ? first.thread.slice("cron:".length) : null,
		runId,
		live: runId ? running.get(runId)?.label : undefined,
		liveSince: runId ? running.get(runId)?.started : undefined,
		result,
		error,
		retryId,
		drafts: drafts.map((d) => d.id),
		devTasks: devs.map((d) => d.id),
		approvals: o.approvals.map((a) => a.id),
		events,
		followups: pendingFollowups(row.id).map((f) => ({ key: f.key, at: f.at, about: f.about, until: f.until })),
		ask: askView(row.id),
	};
}

/** 收到了、还没分派的消息：排队等起草，或者 Yi 正在聊、先等他回 */
function queued(t: number): TaskView[] {
	if (!inflight.size) return [];
	const mids = [...inflight.keys()];
	// 排队时交代过的话：还没分派，不在任务的 trigger 里，按消息 id 单独查
	const asked = askedOf(mids);
	const routed = new Set(
		db()
			.select({ id: schema.triggers.id })
			.from(schema.triggers)
			.where(
				and(
					inArray(
						schema.triggers.id,
						mids.flatMap((m) => [`lark:${m}`, `meego:${m}`, `doc:${m}`]),
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
			source: i.chatMode === "meego" || i.chatMode === "doc" ? i.chatMode : "lark",
			label: i.label,
			// 等批准的固定是待办：同一个聊天里有别的运行在跑也不算它在进行
			status: busy.has(i.chatId) && !i.approval ? "in_progress" : "todo",
			need: null,
			created: i.since,
			updated: i.since,
			hold: i.waitUntil && i.waitUntil > t ? i.waitUntil : undefined,
			approval: i.approval,
			drafts: [],
			devTasks: [],
			approvals: [],
			events: [
				{ k: "msg" as const, at: i.since, who: i.label, owner: false, text: i.text },
				...(asked.get(mid) ?? []).map((a) => ({ k: "ask" as const, at: a.at, text: a.text })),
			],
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
		// 最近活跃：最近一条运行记录或 agent 任务；records 只取了最近 1000 条，更早的不算
		const last = Math.max(
			0,
			...records.filter((r) => r.agent === name).map((r) => r.ts),
			...tasks.filter((t) => t.agent === name).map((t) => t.updated),
		);
		return {
			name,
			// 智能体页展示配置用：提示词文件（config/ 下的相对路径）、档位、能用什么
			prompt: raw.prompt ?? null,
			runner: raw.runner ?? "pi",
			tiers: Object.entries(raw.tiers ?? {}).map(([k, t]) => ({
				name: k,
				desc: t.desc ?? "",
				model: t.model ?? raw.model ?? PI_MODEL,
				thinking: t.thinking ?? raw.thinking ?? PI_THINKING,
				prompt: t.prompt ?? null,
				runner: t.runner ?? raw.runner ?? "pi",
			})),
			tools: raw.tools ?? null,
			skills: raw.skills ?? null,
			mcp: raw.mcp ?? null,
			bash: raw.bash ?? null,
			lastActive: last || null,
			// 说明用助手自己的；model / thinking 是看板派活那一档的
			desc: raw.desc ?? a.desc ?? "",
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

/** 前端这一版的标识：构建产物里带哈希的文件名，重新构建才会变（只重启不变）。打开着的页面发现它变了就自己刷新；
 * 开发模式没有 dist 就是空，页面不比对 */
const BUILD = (() => {
	try {
		const files = readdirSync(path.join(PATHS.web, "client", "assets")).toSorted();
		return createHash("sha1").update(files.join("\n")).digest("hex").slice(0, 12);
	} catch {
		return "";
	}
})();

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
		// 只出建议的巡查交上来、还挂着的建议（server/suggestions.ts）
		suggestions: openSuggestions().map(({ id, title, why, link, source, created }) => ({ id, title, why, link, source, created })),
		quota: quotaNow(),
		build: BUILD,
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
