// 日报：把某一天的消息、草稿、助手任务、需求进度、审批和花费汇成一份 Markdown（不调模型，随时可看）；
// 需要的话再让模型据此写成一段文字总结，存起来。参考 ace-cli 的每日工作日志。
import { and, gte, lt } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { changed } from "./bus.ts";
import { JOURNAL_MODEL } from "./config.ts";
import { db, getKv, schema, setKv } from "./db/index.ts";
import { complete } from "./agent/models.ts";
import { DraftError } from "./drafts/store.ts";
import { OUTCOME } from "./stats.ts";
import { now } from "./util.ts";

// 状态的叫法和看板、飞书卡片一致（docs/ui.md）
const STAGE: Record<string, string> = { dev: "开发中", test: "测试中", release: "发布中", done: "已发布", dropped: "不再跟进" };
const APPROVAL: Record<string, string> = {
	pending: "等你批准",
	running: "执行中",
	done: "已执行",
	rejected: "已拒绝",
	expired: "已过期",
	failed: "执行失败",
};
const DEV_STATUS: Record<string, string> = {
	running: "进行中",
	review: "待查看",
	failed: "失败",
	pushing: "推送中",
	pushed: "已创建 MR",
	done: "已完成",
	discarded: "已放弃",
};

export function dayRange(date: string): [number, number] {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new DraftError("日期格式是 YYYY-MM-DD");
	const start = new Date(`${date}T00:00:00`).getTime() / 1000;
	return [start, start + 86400];
}

/** 截图在消息里是一长串 [图片 img_v3_…]，汇总里只留个占位；顺带去掉 HTML 标签 */
const clean = (t: string) =>
	t
		.replace(/\[图片 [^\]]+\]/g, "[图片]")
		.replace(/<[^>]+>/g, "")
		.replace(/\s+/g, " ");

const between = (col: SQLiteColumn, [a, b]: [number, number]) => and(gte(col, a), lt(col, b));

/** 这一天的原始数据 */
export function dayData(date: string) {
	const range = dayRange(date);
	const drafts = db().select().from(schema.drafts).where(between(schema.drafts.created, range)).all();
	const triggers = db().select().from(schema.triggers).where(between(schema.triggers.at, range)).all();
	const tasks = db()
		.select()
		.from(schema.devTasks)
		.where(between(schema.devTasks.updated, range))
		.all()
		.filter((t) => !t.chat && !t.patrol);
	const stories = db().select().from(schema.stories).where(between(schema.stories.updated, range)).all();
	const approvals = db().select().from(schema.approvals).where(between(schema.approvals.created, range)).all();
	const runs = db().select().from(schema.runs).where(between(schema.runs.ts, range)).all();
	return { date, drafts, triggers, tasks, stories, approvals, runs };
}

/** 不调模型的汇总：数字和清单 */
export function dayMarkdown(d: ReturnType<typeof dayData>): string {
	const out: string[] = [`# ${d.date} 工作日报`, ""];
	const cost = d.runs.reduce((n, r) => n + r.cost, 0);
	const incoming = d.triggers.filter((t) => !t.owner).length;
	out.push(
		`进来 ${incoming} 条消息，起草 ${d.drafts.length} 份，助手任务 ${d.tasks.length} 个，运行 ${d.runs.length} 次，花费 $${cost.toFixed(2)}。`,
		"",
	);
	if (d.drafts.length) {
		const by = new Map<string, number>();
		for (const x of d.drafts) by.set(x.status, (by.get(x.status) ?? 0) + 1);
		const people = new Map<string, number>();
		for (const x of d.drafts) people.set(x.senderName || x.senderId, (people.get(x.senderName || x.senderId) ?? 0) + 1);
		out.push("## 沟通", "");
		out.push(`- 草稿结果：${[...by].map(([s, n]) => `${OUTCOME[s] ?? s} ${n}`).join("、")}`);
		const top = [...people].toSorted((a, b) => b[1] - a[1]).slice(0, 5);
		out.push(`- 找你最多：${top.map(([p, n]) => `${p}（${n}）`).join("、")}`);
		const questions = d.drafts.filter((x) => x.kind === "text" && x.text.length > 8).slice(0, 8);
		if (questions.length) {
			out.push("- 主要问题：");
			for (const q of questions) out.push(`  - ${q.senderName}：${clean(q.text).slice(0, 80)}`);
		}
		out.push("");
	}
	if (d.tasks.length) {
		out.push("## 助手任务", "");
		for (const t of d.tasks)
			out.push(`- [${DEV_STATUS[t.status] ?? t.status}] ${t.title.replace(/\s+/g, " ").slice(0, 80)}${t.mrUrl ? `（${t.mrUrl}）` : ""}`);
		out.push("");
	}
	if (d.stories.length) {
		out.push("## 需求进度", "");
		for (const s of d.stories) {
			const tickets = s.tickets.filter((t) => !t.removed);
			const gd = tickets.length ? `；发布工单 ${tickets.map((t) => `${t.key} ${t.status}`).join("、")}` : "";
			out.push(`- [${STAGE[s.stage] ?? s.stage}] ${s.title}${gd}`);
		}
		out.push("");
	}
	if (d.approvals.length) {
		out.push("## 审批", "");
		for (const a of d.approvals) out.push(`- [${APPROVAL[a.status] ?? a.status}] ${a.reason}${a.origin ? `（${a.origin}）` : ""}`);
		out.push("");
	}
	return out.join("\n").trim();
}

export interface JournalSummary {
	text: string;
	at: number;
	model: string;
}

const KEY = (date: string) => `journal:${date}`;

export function journal(date: string) {
	return { date, markdown: dayMarkdown(dayData(date)), summary: getKv<JournalSummary | null>(KEY(date), null) };
}

const SYSTEM = [
	"你在帮向懿（Yi，后端开发）写当天的工作日报，给他自己回顾用。",
	"只根据给出的数据写，不编造没出现的事；数据里没有的就不写。",
	"先一句话总结这一天，再分「沟通」「开发与任务」「需求进度」「值得注意」几段，每段 2~5 条要点；没有内容的段落省略。",
	"用中文，简洁，不要客套话，不要重复罗列所有数字。",
].join("\n");

/** 让模型据当天汇总写一段文字总结，存下来（再生成会覆盖） */
export async function generateJournal(date: string): Promise<JournalSummary> {
	const md = dayMarkdown(dayData(date));
	const text = (await complete(JOURNAL_MODEL, SYSTEM, md)).trim();
	if (!text) throw new Error("模型没有输出");
	const s = { text, at: now(), model: JOURNAL_MODEL };
	setKv(KEY(date), s);
	changed();
	return s;
}
