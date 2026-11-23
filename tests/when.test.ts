import assert from "node:assert/strict";
import { test } from "node:test";
import { describeTimes, humanCron, nextRuns, parseOneLine, whenOf } from "../src/lib/when.ts";

// 2026-11-23 是周一，现在 14:10
const NOW = new Date(2026, 10, 23, 14, 10).getTime();
const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime() / 1000;
const p = (s: string) => parseOneLine(s, NOW);

test("一句话：原来认的几种照旧", () => {
	assert.deepEqual(p("每天 9 点，看看告警"), { name: "看看告警", cron: "0 9 * * *" });
	assert.equal(p("每个工作日下午 3 点半 看 MR")?.cron, "30 15 * * 1-5");
	assert.equal(p("每周五 17 点 周报")?.cron, "0 17 * * 5");
	assert.equal(p("每 30 分钟 看一眼")?.cron, "*/30 * * * *");
	// 没写每、也没写哪天的按每天
	assert.equal(p("9点 看看")?.cron, "0 9 * * *");
	assert.equal(p("随便看看"), null);
});

test("一句话：每月几号、每周几天、周末", () => {
	assert.deepEqual(p("每月 1 号 10 点，出上月账单"), { name: "出上月账单", cron: "0 10 1 * *" });
	assert.equal(p("每周一三五 9 点 站会提醒")?.cron, "0 9 * * 1,3,5");
	assert.equal(p("每周一、周四 早上 9 点")?.cron, "0 9 * * 1,4");
	assert.equal(p("每周一到周五 18 点")?.cron, "0 18 * * 1-5");
	assert.equal(p("周末 10 点 看看")?.cron, "0 10 * * 0,6");
	assert.equal(p("每月 32 号 9 点"), null);
});

test("一句话：只跑一次", () => {
	assert.deepEqual(p("明天 9 点提醒我开会"), {
		name: "提醒我开会",
		cron: "一次 11月24日 09:00",
		times: [at(2026, 11, 24, 9)],
		past: false,
	});
	assert.deepEqual(p("今天晚上 8 点 看下发布")?.times, [at(2026, 11, 23, 20)]);
	assert.equal(p("今天 9 点 看看")?.past, true);
	assert.deepEqual(p("后天中午 12 点")?.times, [at(2026, 11, 25, 12)]);
	assert.deepEqual(p("11月30日 10点 复查")?.times, [at(2026, 11, 30, 10)]);
	// 过了的日子是明年
	assert.deepEqual(p("1月5日 9点")?.times, [at(2027, 1, 5, 9)]);
	assert.deepEqual(p("周五 15 点 看 CI")?.times, [at(2026, 11, 27, 15)]);
	assert.deepEqual(p("下周一 9 点")?.times, [at(2026, 11, 30, 9)]);
	assert.deepEqual(p("30 分钟后 看下 pod")?.times, [at(2026, 11, 23, 14, 40)]);
	// 正文里别处的「每」不算重复
	assert.deepEqual(p("明天 9 点看看每个店铺")?.times, [at(2026, 11, 24, 9)]);
});

test("cron 说成人话、预览接下来几次", () => {
	assert.equal(humanCron("0 10 1 * *"), "每月 1 号 10:00");
	assert.equal(humanCron("0 10 * * 0,6"), "每个周末 10:00");
	assert.equal(humanCron("0 9 * * 1,3,5"), "每周一、三、五 09:00");
	const runs = nextRuns("0 10 1 * *", 3, NOW).map((d) => d.getTime() / 1000);
	assert.deepEqual(runs, [at(2026, 12, 1, 10), at(2027, 1, 1, 10), at(2027, 2, 1, 10)]);
	assert.deepEqual(
		nextRuns("0 9 * * 1,3,5", 2, NOW).map((d) => d.getTime() / 1000),
		[at(2026, 11, 25, 9), at(2026, 11, 27, 9)],
	);
	assert.equal(describeTimes([at(2026, 11, 24, 9), at(2026, 11, 25, 9)]), "2 次：11月24日 09:00、11月25日 09:00");
	assert.deepEqual(whenOf("0 9 * * *", NOW), { cron: "0 9 * * *" });
});
