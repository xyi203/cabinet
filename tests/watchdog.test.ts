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
	memoryDown: [],
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
	// 记忆服务调不通超过 15 分钟才算
	assert.deepEqual(keys({ memoryDown: [{ service: "hindsight", since: T - 1200, error: "ECONNREFUSED" }] }), ["memory-down:hindsight"]);
	assert.deepEqual(keys({ memoryDown: [{ service: "hindsight", since: T - 300, error: "ECONNREFUSED" }] }), []);
	// 没开轮询就不查轮询和授权
	assert.deepEqual(keys({ pollEnabled: false, auth: { authorized: false } }), []);
});

// 测试里不真派助手：记下派了哪些
const started: string[] = [];
const fakeStart = async (i: { key: string }) => {
	started.push(i.key);
	return `dev-${i.key}`;
};

test("同一个问题只提醒一次，恢复后清掉；提醒没发出去的下一轮再发", async () => {
	started.length = 0;
	const sent: string[][] = [];
	const ok = async (fresh: Array<{ key: string }>) => void sent.push(fresh.map((i) => i.key));
	// 发不出去（网络、飞书出问题）：不记成提醒过，看板上照样列着
	await tick(
		{ ...healthy, pollSince: T - 3600 },
		async () => {
			throw new Error("发不出去");
		},
		fakeStart,
	);
	assert.equal(getKv("watchdog:poll", null), null);
	// 提醒没发出去，助手照样派了
	assert.deepEqual(started, ["poll"]);
	assert.deepEqual(
		watchdogIssues().map((i) => i.key),
		["poll"],
	);
	await tick({ ...healthy, pollSince: T - 3600 }, ok, fakeStart);
	assert.equal(getKv("watchdog:poll", null), T);
	await tick({ ...healthy, now: T + 300, pollSince: T - 3600 }, ok, fakeStart);
	assert.equal(getKv("watchdog:poll", null), T);
	assert.deepEqual(sent, [["poll"]]);
	// 重发提醒不会再派一个助手
	assert.deepEqual(started, ["poll"]);
	assert.equal(getKv("watchdog-agent:poll", null), "dev-poll");
	await tick(healthy, ok, fakeStart);
	assert.equal(getKv("watchdog:poll", null), null);
	assert.equal(getKv("watchdog-agent:poll", null), null);
	assert.deepEqual(watchdogIssues(), []);
});

test("新问题派助手排查，模型出的问题不派；派失败下一轮再派", async () => {
	started.length = 0;
	const ok = async () => {};
	const fails = (error: string) => Array.from({ length: 5 }, () => ({ ts: T - 60, error }));
	// 一小时失败多数是模型额度、限流：不派
	await tick({ ...healthy, failures: fails("429 rate limit exceeded") }, ok, fakeStart);
	assert.equal(watchdogIssues()[0]?.model, true);
	assert.deepEqual(started, []);
	await tick(healthy, ok, fakeStart);
	// 失败是飞书接口的：派
	await tick({ ...healthy, failures: fails("飞书接口 code=99991400") }, ok, fakeStart);
	assert.deepEqual(started, ["failures"]);
	await tick(healthy, ok, fakeStart);
	// Hindsight 连不上：派；第一次派失败，下一轮补派
	const down = { ...healthy, memoryDown: [{ service: "hindsight", since: T - 1200, error: "fetch failed（ECONNREFUSED）" }] };
	let n = 0;
	// 提醒发出去了、派助手失败了：下一轮照样补派
	await tick(down, ok, async (i) => {
		if (n++ === 0) throw new Error("派不出去");
		return fakeStart(i);
	});
	assert.equal(getKv("watchdog-agent:memory-down:hindsight", null), null);
	assert.ok(getKv("watchdog:memory-down:hindsight", null));
	await tick({ ...down, now: T + 300 }, ok, fakeStart);
	assert.deepEqual(started, ["failures", "memory-down:hindsight"]);
	await tick(healthy, ok, fakeStart);
});
