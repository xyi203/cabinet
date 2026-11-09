import assert from "node:assert/strict";
import { test } from "node:test";
const { openDb, useDb } = await import("../server/db/index.ts");
useDb(openDb(":memory:"));
const { CronError, nextRun, parseCron, saveSchedule, listSchedules, deleteSchedule, due } = await import("../server/schedules.ts");
const { DraftError } = await import("../server/drafts/store.ts");

const at = (s: string) => new Date(s).getTime() / 1000;
const fmt = (t: number | undefined) => (t ? new Date(t * 1000).toLocaleString("sv-SE", { hour12: false }).slice(0, 16) : "");

test("cron：工作日 9 点、每两小时、月底不存在的日子跳过", () => {
	// 2026-11-06 是周五
	assert.equal(fmt(nextRun("0 9 * * 1-5", at("2026-11-06T09:00:00"))), "2026-11-09 09:00");
	assert.equal(fmt(nextRun("0 9 * * 1-5", at("2026-11-06T08:59:00"))), "2026-11-06 09:00");
	assert.equal(fmt(nextRun("0 */2 * * *", at("2026-11-06T09:30:00"))), "2026-11-06 10:00");
	assert.equal(fmt(nextRun("30 18 * * 5", at("2026-11-06T19:00:00"))), "2026-11-13 18:30");
	assert.equal(fmt(nextRun("0 0 31 * *", at("2026-11-01T00:00:00"))), "2026-12-31 00:00");
	assert.equal(fmt(nextRun("15,45 8-9 * * *", at("2026-11-06T08:20:00"))), "2026-11-06 08:45");
	// 周日写 0 或 7 都行；日和周都限定时任一满足就算
	assert.equal(fmt(nextRun("0 12 * * 7", at("2026-11-06T00:00:00"))), "2026-11-08 12:00");
	assert.equal(fmt(nextRun("0 12 1 * 0", at("2026-11-06T00:00:00"))), "2026-11-08 12:00");
});

test("cron：写错的报出哪里错", () => {
	assert.throws(() => parseCron("0 9 * *"), CronError);
	assert.throws(() => parseCron("60 9 * * *"), /超出范围/);
	assert.throws(() => parseCron("0 9 * * mon"), /看不懂/);
	assert.throws(() => parseCron("*/0 * * * *"), CronError);
});

test("定时任务：校验 cron、agent 和内容，停用后没有下次", () => {
	assert.throws(() => saveSchedule({ name: "x", cron: "bad", agent: "assistant", prompt: "看看" }), DraftError);
	assert.throws(() => saveSchedule({ name: "x", cron: "0 9 * * *", agent: "dev", prompt: "改代码" }), /不能定时跑/);
	assert.throws(() => saveSchedule({ name: "x", cron: "0 9 * * *", agent: "nobody", prompt: "看看" }), /没有 agent/);
	assert.throws(() => saveSchedule({ name: "", cron: "0 9 * * *", agent: "assistant", prompt: "看看" }), /名字/);
	const s = saveSchedule({ name: "每日告警回顾", cron: "0 9 * * 1-5", agent: "assistant", prompt: "看看昨天的告警" });
	assert.ok(s.nextRun && s.nextRun > Date.now() / 1000);
	const off = saveSchedule({ ...s, enabled: false });
	assert.equal(off.id, s.id);
	assert.equal(off.nextRun, null);
	assert.equal(listSchedules().length, 1);
	deleteSchedule(s.id);
	assert.equal(listSchedules().length, 0);
});

test("巡检定时任务：记下模型和到期时间，过期后到点不跑、直接停用", async () => {
	const s = saveSchedule({
		name: "巡检 GD-1",
		cron: "*/30 * * * *",
		agent: "assistant",
		prompt: "巡检",
		model: "claude/claude-sonnet-5-5",
		until: Date.now() / 1000 - 1,
		patrol: true,
	});
	assert.equal(s.model, "claude/claude-sonnet-5-5");
	assert.equal(s.patrol, true);
	// 改名不带这些字段时保留原值
	assert.equal(
		saveSchedule({ id: s.id, name: "巡检 GD-1 改", cron: s.cron, agent: "assistant", prompt: "巡检" }).model,
		"claude/claude-sonnet-5-5",
	);
	await due((s.nextRun ?? 0) + 1);
	const after = listSchedules().find((x) => x.id === s.id)!;
	assert.equal(after.enabled, false);
	assert.equal(after.nextRun, null);
	assert.equal(after.lastTask, null);
});

test("执行记录：顺着 cron trigger 找到每次运行，新的在前；跳过、无变化、有结论、失败分得开", async () => {
	const { schema, db } = await import("../server/db/index.ts");
	const { receive, decide } = await import("../server/pipeline.ts");
	const { scheduleRuns } = await import("../server/schedules.ts");
	const s = saveSchedule({ name: "早报", cron: "0 9 * * *", agent: "assistant", prompt: "看看昨天的告警" });
	const dev = (id: string, status: string, summary: string, created: number, extra: Record<string, unknown> = {}) =>
		db()
			.insert(schema.devTasks)
			.values({
				id,
				agent: "assistant",
				title: "定时 · 早报",
				repo: "",
				base: "",
				branch: "",
				worktree: "",
				status,
				summary,
				created,
				updated: created + 42,
				...extra,
			})
			.run();
	const run = (t: number, route: Parameters<typeof decide>[1]) => {
		const tid = receive({
			channel: "cron",
			externalId: `${s.id}:${t}`,
			thread: `cron:${s.id}`,
			actorName: s.name,
			owner: true,
			text: s.prompt,
			at: t,
		});
		decide([tid], route);
	};
	dev("dev-sr-1", "done", "本轮无变化，告警都已恢复", 1000);
	dev("dev-sr-2", "review", "## 昨天 3 条告警\n**cart** 5xx 上升", 2000, { usage: { input: 1, output: 1, cacheRead: 0, cost: 0.123 } });
	dev("dev-sr-3", "failed", "", 3000, { error: "模型额度用完了\n详细堆栈" });
	run(1000, { rule: "定时任务：早报", actionKind: "dev", actionId: "dev-sr-1" });
	run(2000, { rule: "定时任务：早报", actionKind: "dev", actionId: "dev-sr-2" });
	run(3000, { rule: "定时任务：早报", actionKind: "dev", actionId: "dev-sr-3" });
	run(4000, { rule: "跳过：上一次（dev-sr-3）还在跑", actionKind: "none" });
	const runs = scheduleRuns(s.id);
	assert.deepEqual(
		runs.map((r) => [r.at, r.outcome, r.brief]),
		[
			[4000, "skipped", "上一次（dev-sr-3）还在跑"],
			[3000, "failed", "模型额度用完了"],
			[2000, "conclusion", "昨天 3 条告警"],
			[1000, "quiet", "告警都已恢复"],
		],
	);
	assert.deepEqual(
		runs.map((r) => r.label),
		["跳过", "失败", "有结论", "无变化"],
	);
	assert.equal(runs[1].detail, "模型额度用完了\n详细堆栈");
	assert.equal(runs[2].cost, 0.123);
	assert.equal(runs[2].seconds, 42);
	assert.equal(runs[0].taskId, null);
	assert.equal(scheduleRuns("cron-0").length, 0);
});
