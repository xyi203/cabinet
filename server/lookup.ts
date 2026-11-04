// 链式召回（Chain of Recall）：agent 按 ID 查 cabinet 里的对象，每个结果只给摘要，并内联下一跳对象的 ID，
// 需要更多再沿 ID 往下查（Inline & Spill）。只读；只给结果先经 Yi 过目的运行用（起草、改写、agent 任务），
// 群里 @机器人的问答不给：免得别人借机器人问出 Yi 的私聊内容。
import { desc, eq, like, or } from "drizzle-orm";
import { db, schema } from "./db/index.ts";
import type { DevTask, Draft, ResultRow, RouteRow, TriggerRow } from "./db/schema.ts";
import { describeReply } from "./drafts/format.ts";
import { subscriptionsOf } from "./pipeline.ts";

const SHORT = 120;
const LONG = 1500;
const cut = (s: string | null | undefined, n: number) => {
	const t = (s ?? "").replace(/\s+/g, " ").trim();
	return t.length > n ? `${t.slice(0, n)}…（截断）` : t;
};
const time = (ts: number) => new Date(ts * 1000).toLocaleString("sv-SE", { hour12: false }).slice(0, 16);

export const LOOKUP_HELP =
	"ID 的写法：trigger 用 `<渠道>:<消息 id>`（lark:om_x、meego:om_x、bot:om_x、alert:om_x、board:dev-x、cron:<任务>:<时间>）；" +
	"分派 `route:<数字>`；草稿 `draft:<id>`；agent 任务 `dev-<数字>`；事件流 `thread:<thread>`（比如 thread:lark:oc_x）；MR `gitlab:<项目>!<iid>`。";

function triggerLine(t: TriggerRow) {
	return `- ${t.id} · ${time(t.at)} · ${t.actorName || t.actorId || "?"}${t.owner ? "（Yi）" : ""}：${cut(t.text, SHORT)}`;
}

function resultLine(r: ResultRow) {
	return `- ${time(r.at)} ${r.outcome}（${r.effect}）${r.ref ? ` · ${r.ref}` : ""}${r.detail ? ` · ${cut(r.detail, SHORT)}` : ""}`;
}

function actionRef(r: Pick<RouteRow, "actionKind" | "actionId">) {
	if (!r.actionId) return "";
	if (r.actionKind === "draft") return `draft:${r.actionId}`;
	if (r.actionKind === "dev") return r.actionId;
	if (r.actionKind === "command") return r.actionId.startsWith("dev-") ? r.actionId : `draft:${r.actionId}`;
	return `${r.actionKind}:${r.actionId}`;
}

const resultsOf = (routeId: number) =>
	db().select().from(schema.results).where(eq(schema.results.routeId, routeId)).orderBy(schema.results.at).all();

function showTrigger(t: TriggerRow): string {
	const out = [
		`trigger ${t.id}`,
		`渠道 ${t.channel} · 事件流 thread:${t.thread} · ${time(t.at)} · ${t.actorName || t.actorId}${t.owner ? "（Yi 本人）" : ""}`,
		`正文：${cut(t.text, LONG)}`,
	];
	const next = [`thread:${t.thread}`, ...t.refs];
	if (t.routeId) {
		const r = db().select().from(schema.routes).where(eq(schema.routes.id, t.routeId)).get();
		if (r) {
			out.push(`分派 route:${r.id}：${r.agent ?? "不处理"} · ${r.rule}${r.actionId ? ` → ${actionRef(r)}` : ""}`);
			next.push(`route:${r.id}`);
			if (r.actionId) next.push(actionRef(r));
			const results = resultsOf(r.id);
			if (results.length) out.push("结果：", ...results.map(resultLine));
		}
	} else out.push(`状态：${t.status}`);
	return [...out, `相关：${[...new Set(next)].join(" ")}`].join("\n");
}

function showRoute(r: RouteRow): string {
	const triggers = r.triggers.length
		? db()
				.select()
				.from(schema.triggers)
				.where(or(...r.triggers.map((id) => eq(schema.triggers.id, id))))
				.all()
		: [];
	const results = resultsOf(r.id);
	const out = [
		`route:${r.id} · ${time(r.at)} · ${r.agent ?? "不处理"} · ${r.rule}`,
		`产出：${r.actionKind}${r.actionId ? ` ${actionRef(r)}` : ""}${r.session ? ` · 会话 ${r.session}` : ""}`,
		`trigger（${triggers.length}）：`,
		...triggers.slice(0, 20).map(triggerLine),
	];
	if (triggers.length > 20) out.push(`…另有 ${triggers.length - 20} 条`);
	if (results.length) out.push("结果：", ...results.map(resultLine));
	const next = [...triggers.slice(0, 5).map((t) => t.id), actionRef(r)].filter(Boolean);
	return [...out, `相关：${next.join(" ")}`].join("\n");
}

function showDraft(d: Draft): string {
	const versions = db().select().from(schema.drafts).where(eq(schema.drafts.replyTo, d.replyTo)).orderBy(schema.drafts.created).all();
	const out = [
		`draft:${d.id} · ${time(d.created)} · ${d.status} · agent ${d.agent ?? "?"}`,
		`回复对象：${d.senderName}（${d.chatMode === "p2p" ? "私聊" : d.chatMode === "meego" ? `飞书项目「${d.chatName}」` : `群「${d.chatName}」`}）`,
		`原消息：${cut(d.text, LONG)}`,
		`草稿：${cut(describeReply(d.kind, d.draft), LONG)}`,
	];
	if (d.note) out.push(`备注：${cut(d.note, SHORT)}`);
	if (versions.length > 1) out.push(`同一条消息的各版草稿：${versions.map((v) => `draft:${v.id}（${v.status}）`).join(" ")}`);
	const results = db().select().from(schema.results).where(eq(schema.results.actionId, d.id)).all();
	if (results.length) out.push("结果：", ...results.map(resultLine));
	const channel = d.chatMode === "meego" ? "meego" : "lark";
	const next = [
		`${channel}:${d.replyTo}`,
		d.routeId ? `route:${d.routeId}` : "",
		`thread:${d.chatMode === "meego" ? `meego:${d.meego?.workItemId}` : `lark:${d.chatId}`}`,
	];
	return [...out, `相关：${next.filter(Boolean).join(" ")}`].join("\n");
}

function showDev(t: DevTask): string {
	const out = [
		`${t.id} · agent ${t.agent} · ${t.status} · ${time(t.created)} 建 · ${time(t.updated)} 更新 · ${t.runs} 轮`,
		`标题：${cut(t.title, SHORT)}`,
		`任务：${cut(t.request, LONG)}`,
	];
	if (t.repo) out.push(`仓库 ${t.repo}${t.branch ? ` · 分支 ${t.branch}` : ""}`);
	if (t.mrUrl) out.push(`MR ${t.mrUrl}`);
	if (t.summary) out.push(`最近一轮的结论：${cut(t.summary, LONG)}`);
	if (t.error) out.push(`错误：${cut(t.error, SHORT)}`);
	const next = [t.routeId ? `route:${t.routeId}` : "", t.draftId ? `draft:${t.draftId}` : ""].filter(Boolean);
	return [...out, next.length ? `相关：${next.join(" ")}` : ""].filter(Boolean).join("\n");
}

/** 一条事件流（或被引用的 MR）里最近的 trigger */
function showThread(thread: string): string {
	const rows = thread.startsWith("gitlab:")
		? db()
				.select()
				.from(schema.triggers)
				.where(or(eq(schema.triggers.thread, thread), like(schema.triggers.refs, `%"${thread}"%`)))
				.orderBy(desc(schema.triggers.at))
				.limit(30)
				.all()
		: db().select().from(schema.triggers).where(eq(schema.triggers.thread, thread)).orderBy(desc(schema.triggers.at)).limit(30).all();
	const subs = subscriptionsOf(thread).map((s) => `${s.agent} 的会话 ${s.session}（${time(s.updated)} 更新）`);
	if (!rows.length && !subs.length) return `事件流 ${thread} 里没有记录`;
	return [
		`事件流 ${thread}，最近 ${rows.length} 条（新的在前）：`,
		...rows.map(triggerLine),
		...(subs.length ? [`订阅在：${subs.join("；")}`] : []),
		"用 lookup <trigger id> 看某一条的分派和结果。",
	].join("\n");
}

/** 按 ID 查一个对象；查不到时说明 ID 的写法 */
export function lookup(rawId: string): string {
	const id = rawId.trim();
	const route = /^route:(\d+)$/.exec(id);
	if (route) {
		const r = db()
			.select()
			.from(schema.routes)
			.where(eq(schema.routes.id, Number(route[1])))
			.get();
		return r ? showRoute(r) : `没有 ${id}`;
	}
	if (id.startsWith("thread:")) return showThread(id.slice("thread:".length));
	if (id.startsWith("gitlab:")) return showThread(id);
	if (id.startsWith("dev-")) {
		const t = db().select().from(schema.devTasks).where(eq(schema.devTasks.id, id)).get();
		return t ? showDev(t) : `没有任务 ${id}`;
	}
	if (id.startsWith("draft:") || id.startsWith("om_")) {
		const d = db()
			.select()
			.from(schema.drafts)
			.where(eq(schema.drafts.id, id.replace(/^draft:/, "")))
			.get();
		if (d) return showDraft(d);
	}
	const t = db().select().from(schema.triggers).where(eq(schema.triggers.id, id)).get();
	if (t) return showTrigger(t);
	return `没找到 ${id}。${LOOKUP_HELP}`;
}
