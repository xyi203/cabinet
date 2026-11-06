// 任务模型（借鉴 multica：6 个状态归入 4 个生命周期分类）
// todo 待办 / in_progress 进行中 / in_review 审核中 / blocked 已阻塞 / done 已完成 / cancelled 已取消
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { PATHS } from "./config.ts";
import { db, schema } from "./db/index.ts";
import type { Approval, DevTask, Draft, RecordRow } from "./db/schema.ts";
import { describe, pendingApprovals } from "./approvals.ts";
import { draftLabel } from "./drafts/format.ts";
import { inflight } from "./drafts/store.ts";
import { draftMrs } from "./drafts/mr.ts";
import { PI_MODEL, PI_THINKING } from "./config.ts";
import { devTasksList } from "./dev.ts";
import { listStories } from "./stories.ts";
import { TASK_TIER, loadAgents, withTier } from "./agent/router.ts";
import { recentRecords } from "./records.ts";
import { conversationLog, running } from "./agent/driver.ts";
import { listMemories, type Memory } from "./memory/store.ts";
import { ALERT_AGENT } from "./config.ts";
import { now } from "./util.ts";
import { type Issue, watchdogIssues } from "./watchdog.ts";
import { count, desc, gte } from "drizzle-orm";
import { quotaNow } from "./quota.ts";

const DRAFT_TASK_STATUS: Record<string, string> = {
	pending: "in_review",
	noreply: "in_review",
	sending: "in_progress",
	revising: "in_progress",
	sent: "done",
	completed: "done",
	discarded: "cancelled",
	expired: "cancelled",
	replaced: "cancelled",
	merged: "cancelled",
};
const STATUS_TEXT: Record<string, string> = {
	pending: "待确认",
	noreply: "建议不回",
	sending: "发送中",
	revising: "改写中",
	sent: "已发出",
	completed: "已标记完成",
	discarded: "不发",
	expired: "已亲自回复",
	replaced: "已改写",
	merged: "已合并",
};

export interface Task {
	id: string;
	type: "draft" | "qa" | "dev";
	status: string;
	sub: string;
	title: string;
	label: string;
	chatMode?: string | null;
	created: number;
	session?: string | null;
	start?: number;
	end?: number;
	seconds?: number | null;
	usage?: unknown;
	draft?: string;
	agent?: string | null;
	route?: string | null;
	error?: string | null;
	answer?: string | null;
	retryable?: boolean;
	runId?: string;
	dev?: string;
}

const DEV_STATUS: Record<string, [string, string]> = {
	running: ["in_progress", "开发中"],
	pushing: ["in_progress", "推送中"],
	review: ["in_review", "待审核"],
	failed: ["blocked", "失败"],
	pushed: ["done", "已提 MR"],
	// 查询类 agent 任务看完点「完成」就是 done；漏了这一项会被兜底成审核中、一直挂在需介入里
	done: ["done", "已完成"],
	discarded: ["cancelled", "已放弃"],
};

export function buildTasks(drafts: Draft[], records: RecordRow[]): Task[] {
	const tasks: Task[] = [];
	const t = now();
	// 已结束的只看最近 24 小时，免得看板越堆越长
	const recent = (ts: number) => ts >= t - 86400;
	const drafted = new Map(records.filter((r) => r.kind === "draft" && r.status === "drafted" && r.dm).map((r) => [r.dm!, r]));
	const busy = new Map([...running].filter(([, r]) => r.chatId).map(([id, r]) => [r.chatId!, id]));

	for (const [mid, info] of inflight) {
		const runId = busy.get(info.chatId);
		tasks.push({
			id: mid,
			type: "draft",
			status: runId ? "in_progress" : "todo",
			sub: runId ? "起草中" : "排队等起草",
			title: info.text,
			label: info.label,
			chatMode: info.chatMode,
			created: info.since,
			session: runId,
			start: info.since,
			runId,
		});
	}
	for (const d of drafts) {
		const st = DRAFT_TASK_STATUS[d.status] ?? "in_review";
		if ((st === "done" || st === "cancelled") && !recent(d.created)) continue;
		const r = drafted.get(d.id);
		const end = r?.ts ?? d.created;
		tasks.push({
			id: d.id,
			type: "draft",
			status: st,
			sub: STATUS_TEXT[d.status] ?? d.status,
			title: d.text,
			label: draftLabel(d),
			chatMode: d.chatMode,
			created: d.created,
			session: d.session,
			start: end - (r?.seconds ?? 0),
			end,
			seconds: r?.seconds,
			usage: r?.usage,
			draft: d.id,
			agent: d.agent,
			route: d.route,
		});
	}
	// 失败：同一条来源之后成功过（或正在重试）就不再算阻塞；records 已按时间倒序
	const settled = new Set<string>();
	for (const r of records) {
		const key = r.source;
		if (!key) continue;
		if (["replied", "drafted", "skipped", "dismissed"].includes(r.status)) settled.add(key);
		else if (r.status === "failed" && !settled.has(key) && !inflight.has(key) && recent(r.ts)) {
			settled.add(key); // 同一来源只保留最新一次失败
			tasks.push({
				id: `${r.kind === "draft" ? "fail" : "qa"}-${key}`,
				type: r.kind as Task["type"],
				status: "blocked",
				sub: "失败",
				title: r.question ?? "",
				label: r.label ?? "",
				created: r.ts,
				session: r.session,
				start: r.ts - (r.seconds ?? 0),
				end: r.ts,
				seconds: r.seconds,
				error: r.error,
				retryable: Boolean(r.retry),
				agent: r.agent,
			});
		}
	}
	for (const r of records) {
		if (r.status === "skipped" && recent(r.ts))
			tasks.push({
				id: `skip-${r.source}`,
				type: "draft",
				status: "cancelled",
				sub: "已亲自回复",
				title: r.question ?? "",
				label: r.label ?? "",
				created: r.ts,
				chatMode: r.chatId?.startsWith("meego-") ? "meego" : null,
			});
		if (r.kind === "qa" && (r.status === "replied" || r.status === "remembered") && recent(r.ts))
			tasks.push({
				id: `qa-${r.source ?? r.ts}`,
				type: "qa",
				status: "done",
				sub: r.status === "replied" ? "已回复" : "已记住",
				title: r.question ?? "",
				label: r.label ?? "问答",
				created: r.ts,
				session: r.session,
				start: r.ts - (r.seconds ?? 0),
				end: r.ts,
				seconds: r.seconds,
				usage: r.usage,
				answer: r.answer,
			});
	}
	for (const [runId, run] of running) {
		if (run.chatId || run.label === "分诊") continue; // 起草的进行中已经由 inflight / revising 表示
		tasks.push({
			id: `run-${runId}`,
			type: "qa",
			status: "in_progress",
			sub: "回答中",
			title: run.label,
			label: run.label,
			created: run.started,
			session: run.sessionId,
			start: run.started,
			runId,
		});
	}
	for (const d of devTasksList()) {
		// 对话页的聊天不进任务看板
		if (d.chat) continue;
		const [status, devSub] = DEV_STATUS[d.status] ?? ["in_review", d.status];
		// 查询类 agent 的结果是给 Yi 看的，不是审代码
		const sub = d.agent !== "dev" && d.status === "review" ? "待看" : devSub;
		if ((status === "done" || status === "cancelled") && !recent(d.updated)) continue;
		const runId = d.status === "running" ? `dev-${d.id}` : undefined;
		tasks.push({
			id: d.id,
			type: "dev",
			status,
			sub,
			title: d.title,
			label: d.agent === "dev" ? `${path.basename(d.repo)} · ${d.branch}` : `${d.agent}${d.repo ? ` · ${path.basename(d.repo)}` : ""}`,
			created: d.created,
			session: `dev-${d.id}`,
			start: d.created,
			end: d.updated,
			usage: d.usage,
			error: d.error,
			agent: d.agent,
			dev: d.id,
			runId,
		});
	}
	return tasks.toSorted((a, b) => b.created - a.created);
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

/**
 * 待你处理：需要 Yi 判断的事汇成一张表。
 * now：有人在等（待确认的草稿、起草失败、告警结论）；soon：agent 任务待看或失败；later：建议不回的草稿、有争议的记忆。
 * 推送规则（docs/pipeline.md）：now 和 soon 都已经私聊过，这里是汇总；有争议的记忆只在这里，不推送。
 */
export interface InboxItem {
	kind: "draft" | "failure" | "dev" | "memory" | "watch" | "approval";
	/** 打开用：草稿 id、看板任务 id、agent 任务 id、记忆 id */
	ref: string;
	level: "now" | "soon" | "later";
	why: string;
	title: string;
	label: string;
	at: number;
}

const LEVEL = { now: 0, soon: 1, later: 2 };

export function buildInbox(
	drafts: Draft[],
	tasks: Task[],
	devTasks: DevTask[],
	contested: Memory[],
	issues: Issue[] = [],
	approvals: Approval[] = [],
): InboxItem[] {
	const items: InboxItem[] = issues.map((i) => ({
		kind: "watch",
		ref: i.key,
		level: "now",
		why: i.title,
		title: i.detail,
		label: "Watchdog",
		at: now(),
	}));
	// 写操作审批：agent 在等，24 小时不处理就过期
	for (const a of approvals)
		items.push({
			kind: "approval",
			ref: a.id,
			level: "now",
			why: `写操作待审批：${a.reason}`,
			title: describe(a),
			label: a.origin,
			at: a.created,
		});
	for (const d of drafts) {
		if (d.status !== "pending" && d.status !== "noreply") continue;
		items.push({
			kind: "draft",
			ref: d.id,
			level: d.status === "pending" ? "now" : "later",
			why: d.status === "pending" ? "草稿待确认" : "建议不回，确认一下",
			title: d.text,
			label: draftLabel(d),
			at: d.created,
		});
	}
	for (const t of tasks) {
		// agent 任务失败在下面按 devTasks 列，这里只管起草和问答
		if (t.status !== "blocked" || t.type === "dev") continue;
		items.push({
			kind: "failure",
			ref: t.id,
			level: t.type === "draft" ? "now" : "soon",
			why: `${t.type === "draft" ? "起草失败" : "问答失败"}：${(t.error ?? "").slice(0, 80)}`,
			title: t.title,
			label: t.label,
			at: t.created,
		});
	}
	for (const t of devTasks) {
		if (t.chat || (t.status !== "review" && t.status !== "failed")) continue;
		const alert = t.agent === ALERT_AGENT;
		items.push({
			kind: "dev",
			ref: t.id,
			level: alert && t.status === "review" ? "now" : "soon",
			why: t.status === "failed" ? "agent 任务失败" : alert ? "告警结论待看" : t.agent === "dev" ? "开发任务待审核" : "agent 任务待看",
			title: t.title,
			label: t.agent,
			at: t.updated,
		});
	}
	for (const m of contested)
		items.push({
			kind: "memory",
			ref: String(m.id),
			level: "later",
			why: "记忆有冲突，等你裁定",
			title: m.content,
			label: m.kind,
			at: m.updated,
		});
	return items.toSorted((a, b) => LEVEL[a.level] - LEVEL[b.level] || b.at - a.at);
}

/** MR 预审的草稿带上对应的 MR 和已经做过的动作（approve、发评论），看板上按这个出按钮 */
function withMr(drafts: Draft[]) {
	const mrs = draftMrs(drafts);
	return drafts.map((d) => (mrs.has(d.id) ? { ...d, mr: mrs.get(d.id) } : d));
}

export function dashboardState() {
	const drafts = db().select().from(schema.drafts).orderBy(desc(schema.drafts.created)).limit(300).all();
	const records = recentRecords(1000);
	const tasks = buildTasks(drafts, records);
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
			pending: drafts.filter((d) => d.status === "pending" || d.status === "noreply").length,
		},
		running: running.size,
		inflight: inflight.size,
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
		// 需求任务：最近动过的在前
		stories: listStories().toSorted((a, b) => b.updated - a.updated),
		tasks,
		quota: quotaNow(),
		inbox: buildInbox(drafts, tasks, devTasksList(), listMemories(["contested"]), watchdogIssues(), pendingApprovals()),
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
