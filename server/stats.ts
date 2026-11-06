// 统计页：按 runs 表（每次 agent 运行一条，见 driver.logRun）算消耗趋势和按 agent / 档位 / 模型的拆分，
// 再按 drafts 表算草稿的结果分布（你发了、你自己回了、不发、标记完成…），看起草到底帮上了多少忙
import { gte } from "drizzle-orm";
import { db, schema } from "./db/index.ts";
import { now } from "./util.ts";

export type Range = "today" | "7d" | "30d";
export const RANGES: Range[] = ["today", "7d", "30d"];

export interface Bucket {
	/** 桶的开始时间（unix 秒） */
	t: number;
	label: string;
	runs: number;
	failed: number;
	cost: number;
	tokens: number;
}

export interface Group {
	name: string;
	runs: number;
	failed: number;
	cost: number;
	tokens: number;
	/** 平均耗时（秒），只算成功的 */
	seconds: number;
}

const pad = (n: number) => String(n).padStart(2, "0");
const dayStart = (t: number) => {
	const d = new Date(t * 1000);
	d.setHours(0, 0, 0, 0);
	return d.getTime() / 1000;
};

/** 范围的开始和桶：今天按小时，7 天 / 30 天按天（本地时区） */
export function buckets(range: Range, t = now()): Bucket[] {
	const start = dayStart(t);
	const empty = { runs: 0, failed: 0, cost: 0, tokens: 0 };
	if (range === "today") return Array.from({ length: 24 }, (_, h) => ({ t: start + h * 3600, label: `${pad(h)}:00`, ...empty }));
	const days = range === "7d" ? 7 : 30;
	return Array.from({ length: days }, (_, i) => {
		const d = new Date(start * 1000);
		d.setDate(d.getDate() - (days - 1 - i));
		return { t: d.getTime() / 1000, label: `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, ...empty };
	});
}

type RunRow = typeof schema.runs.$inferSelect;
type DraftRow = Pick<typeof schema.drafts.$inferSelect, "status" | "kind">;

/** 草稿的结果：给 Yi 看的叫法 */
export const OUTCOME: Record<string, string> = {
	sent: "你发了",
	completed: "标记完成",
	expired: "你自己回了",
	discarded: "不发",
	merged: "合并到后一条",
	replaced: "改写替换",
	pending: "待确认",
	noreply: "建议不回",
	sending: "发送中",
	revising: "改写中",
};

export function summarize(range: Range, rows: RunRow[], drafts: DraftRow[], t = now()) {
	const series = buckets(range, t);
	const total = { runs: 0, failed: 0, cost: 0, tokens: 0 };
	const groups = { agent: new Map<string, Group & { okRuns: number }>(), tier: new Map(), model: new Map() } as Record<
		"agent" | "tier" | "model",
		Map<string, Group & { okRuns: number }>
	>;
	for (const r of rows) {
		const tokens = r.input + r.output + r.cacheRead;
		// 找最后一个开始时间不晚于它的桶
		let i = series.length - 1;
		while (i > 0 && series[i].t > r.ts) i--;
		if (r.ts < series[0].t) continue;
		const b = series[i];
		for (const x of [b, total]) {
			x.runs++;
			x.cost += r.cost;
			x.tokens += tokens;
			if (!r.ok) x.failed++;
		}
		const keys = { agent: r.agent || "未知", tier: r.tier || "未记录", model: r.model || "未记录" };
		for (const dim of ["agent", "tier", "model"] as const) {
			const m = groups[dim];
			const g = m.get(keys[dim]) ?? { name: keys[dim], runs: 0, failed: 0, cost: 0, tokens: 0, seconds: 0, okRuns: 0 };
			g.runs++;
			g.cost += r.cost;
			g.tokens += tokens;
			if (!r.ok) g.failed++;
			else if (r.seconds != null) {
				g.seconds = (g.seconds * g.okRuns + r.seconds) / (g.okRuns + 1);
				g.okRuns++;
			}
			m.set(keys[dim], g);
		}
	}
	const list = (m: Map<string, Group & { okRuns: number }>): Group[] =>
		[...m.values()].map((g) => ({ name: g.name, runs: g.runs, failed: g.failed, cost: g.cost, tokens: g.tokens, seconds: g.seconds })).toSorted((a, b) => b.cost - a.cost || b.runs - a.runs);
	const outcomes = new Map<string, number>();
	for (const d of drafts) outcomes.set(d.status, (outcomes.get(d.status) ?? 0) + 1);
	// 命中率：草稿真的被用上（你发了、标记完成）占已有结果的比例；还在等你的不算
	const used = (outcomes.get("sent") ?? 0) + (outcomes.get("completed") ?? 0);
	const settled = [...outcomes].filter(([s]) => !["pending", "noreply", "sending", "revising"].includes(s)).reduce((n, [, c]) => n + c, 0);
	return {
		range,
		series,
		total,
		byAgent: list(groups.agent),
		byTier: list(groups.tier),
		byModel: list(groups.model),
		drafts: [...outcomes]
			.map(([status, count]) => ({ status, name: OUTCOME[status] ?? status, count }))
			.toSorted((a, b) => b.count - a.count),
		hitRate: settled ? used / settled : null,
	};
}

export function stats(range: Range, t = now()) {
	const start = buckets(range, t)[0].t;
	const rows = db().select().from(schema.runs).where(gte(schema.runs.ts, start)).all();
	const drafts = db()
		.select({ status: schema.drafts.status, kind: schema.drafts.kind })
		.from(schema.drafts)
		.where(gte(schema.drafts.created, start))
		.all();
	return summarize(range, rows, drafts, t);
}
