import assert from "node:assert/strict";
import { test } from "node:test";
const { parseRateLimitHeaders } = await import("../server/quota.ts");
const { buckets, summarize } = await import("../server/stats.ts");

test("额度：读 magpie 转发的 anthropic-ratelimit-unified-* 头，5h / 7d 换成窗口名，其他窗口原样保留", () => {
	const q = parseRateLimitHeaders(
		new Headers({
			"Anthropic-Ratelimit-Unified-5h-Reset": "1793939400",
			"Anthropic-Ratelimit-Unified-5h-Utilization": "0.15",
			"Anthropic-Ratelimit-Unified-7d-Reset": "1794297600",
			"Anthropic-Ratelimit-Unified-7d-Utilization": "0.41",
			"Anthropic-Ratelimit-Unified-7d_oi-Utilization": "0",
			"X-Magpie-Provider": "claude",
		}).entries(),
		100,
	);
	assert.deepEqual(q, {
		at: 100,
		windows: {
			five_hour: { utilization: 0.15, resetsAt: 1793939400 },
			seven_day: { utilization: 0.41, resetsAt: 1794297600 },
			"7d_oi": { utilization: 0, resetsAt: 0 },
		},
	});
	assert.equal(parseRateLimitHeaders(new Headers({ "Content-Type": "application/json" }).entries()), undefined);
});

const at = (s: string) => new Date(s).getTime() / 1000;
const run = (ts: string, o: Record<string, unknown> = {}) =>
	({
		id: 0,
		ts: at(ts),
		agent: "assistant",
		tier: "answer",
		model: "claude/claude-opus-5-5",
		request: null,
		label: null,
		seconds: 10,
		ok: true,
		input: 10,
		output: 5,
		cacheRead: 100,
		cost: 0.1,
		...o,
	}) as any;

test("统计：今天按小时、7 天按天分桶，按 agent / 档位 / 模型拆分，草稿命中率不算还在等的", () => {
	const t = at("2026-11-06T12:30:00");
	assert.equal(buckets("today", t).length, 24);
	assert.deepEqual(
		buckets("7d", t)
			.map((b) => b.label)
			.slice(-2),
		["11-05", "11-06"],
	);
	const s = summarize(
		"today",
		[
			run("2026-11-06T09:10:00"),
			run("2026-11-06T09:50:00", { tier: "deep", seconds: 30 }),
			run("2026-11-06T11:00:00", { agent: "dev", tier: "task", model: "codex/gpt-6.1-sol", ok: false, cost: 0 }),
			run("2026-11-05T23:00:00"),
		],
		[{ status: "sent" }, { status: "expired" }, { status: "expired" }, { status: "completed" }, { status: "pending" }] as any,
		t,
	);
	assert.equal(s.total.runs, 3);
	assert.equal(s.total.failed, 1);
	assert.equal(s.series[9].runs, 2);
	assert.equal(s.series[11].failed, 1);
	assert.deepEqual(
		s.byTier.map((g) => [g.name, g.runs]),
		[
			["answer", 1],
			["deep", 1],
			["task", 1],
		],
	);
	assert.equal(s.byAgent[0].seconds, 20);
	assert.equal(s.hitRate, 2 / 4);
	assert.equal(s.drafts[0].name, "你自己回了");
});
