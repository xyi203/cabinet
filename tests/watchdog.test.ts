import assert from "node:assert/strict";
import { test } from "node:test";
process.env.POLL_INTERVAL = "30";
process.env.ALERT_MAX_WAIT = "600";
const { openDb, useDb } = await import("../server/db/index.ts");
useDb(openDb(":memory:"));
const { checkHealth, tick, watchdogIssues } = await import("../server/watchdog.ts");
const { getKv } = await import("../server/db/index.ts");

const T = 1_000_000;
const healthy = {
	now: T,
	pollEnabled: true,
	pollSince: T - 60,
	auth: { authorized: true, refreshExpiresAt: T + 30 * 86400 },
	devTasks: [],
	runningKeys: new Set<string>(),
	inflight: [],
	failures: [],
	alertBatches: [],
};

test("一切正常时没有问题", () => {
	assert.deepEqual(checkHealth(healthy), []);
});

const keys = (s: object) => checkHealth({ ...healthy, ...s }).map((i) => i.key);

test("按规则发现问题", () => {
	assert.deepEqual(keys({ pollSince: T - 3600 }), ["poll"]);
	assert.deepEqual(keys({ auth: { authorized: false } }), ["auth"]);
	assert.deepEqual(keys({ auth: { authorized: true, refreshExpiresAt: T + 86400 } }), ["auth-expiring"]);
	assert.deepEqual(keys({ inflight: [{ id: "om_1", since: T - 3600, label: "张三" }] }), ["draft-stuck:om_1"]);
	// 运行中但没有在跑的运行；刚更新过的先不算（可能正要开始）
	const task = { id: "dev-1", status: "running", updated: T - 600, title: "x" };
	assert.deepEqual(keys({ devTasks: [task] }), ["task-lost:dev-1"]);
	assert.deepEqual(keys({ devTasks: [task], runningKeys: new Set(["dev-dev-1"]) }), []);
	assert.deepEqual(keys({ devTasks: [{ ...task, updated: T - 60 }] }), []);
	assert.deepEqual(keys({ alertBatches: [{ chatId: "oc_a", name: "告警群", first: T - 1200 }] }), ["alert-stuck:oc_a"]);
	assert.deepEqual(keys({ failures: Array.from({ length: 5 }, () => ({ ts: T - 60 })) }), ["failures"]);
	assert.deepEqual(keys({ failures: Array.from({ length: 5 }, () => ({ ts: T - 7200 })) }), []);
	// 没开轮询就不查轮询和授权
	assert.deepEqual(keys({ pollEnabled: false, auth: { authorized: false } }), []);
});

test("同一个问题只记一次，恢复后清掉", async () => {
	// 发卡片会失败（测试里没有飞书），只记日志；去重和恢复照常
	await tick({ ...healthy, pollSince: T - 3600 });
	assert.equal(getKv("watchdog:poll", null), T);
	assert.deepEqual(
		watchdogIssues().map((i) => i.key),
		["poll"],
	);
	await tick({ ...healthy, now: T + 300, pollSince: T - 3600 });
	assert.equal(getKv("watchdog:poll", null), T);
	await tick(healthy);
	assert.equal(getKv("watchdog:poll", null), null);
	assert.deepEqual(watchdogIssues(), []);
});
