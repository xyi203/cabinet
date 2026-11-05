import assert from "node:assert/strict";
import { test } from "node:test";
const { openDb, useDb } = await import("../server/db/index.ts");
useDb(openDb(":memory:"));
const { CronError, nextRun, parseCron, saveSchedule, listSchedules, deleteSchedule } = await import("../server/schedules.ts");
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
