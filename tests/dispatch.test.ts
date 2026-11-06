import assert from "node:assert/strict";
import { test } from "node:test";
const { openDb, useDb } = await import("../server/db/index.ts");
useDb(openDb(":memory:"));
const { decide, receive, settle } = await import("../server/pipeline.ts");
const { recentRoutes, suspects, SUSPECT_RUN } = await import("../server/dispatch.ts");
const { running } = await import("../server/agent/driver.ts");

test("最近分派：带上第一条 trigger 的来源和内容、档位、第一次结果和时间", () => {
	const a = receive({ channel: "lark", externalId: "m1", thread: "lark:c1", actorName: "张三", text: "这个接口为什么慢", at: 100 });
	const b = receive({ channel: "lark", externalId: "m2", thread: "lark:c1", actorName: "张三", text: "补充一下", at: 110 });
	const rid = decide([a, b], { agent: "assistant", rule: "分诊 deep：查日志", info: { tier: "deep" }, actionKind: "draft" });
	settle({ actionKind: "draft", routeId: rid, outcome: "sent", effect: "outward" });
	const [r] = recentRoutes();
	assert.equal(r.id, rid);
	assert.equal(r.channel, "lark");
	assert.equal(r.actor, "张三");
	assert.equal(r.text, "这个接口为什么慢");
	assert.equal(r.received, 100);
	assert.equal(r.tier, "deep");
	assert.equal(r.outcome, "sent");
	assert.ok(r.settled && r.settled >= r.routed);
});

test("可疑：运行超过阈值的给出停止操作，没超过的不算", () => {
	const t = 10_000;
	running.set("dev-dev-1", { label: "查日志", started: t - SUSPECT_RUN - 1, agent: "assistant" });
	running.set("once-x", { label: "起草", started: t - 10 });
	const s = suspects(t).filter((x) => x.key.startsWith("run:"));
	assert.deepEqual(
		s.map((x) => [x.key, x.action?.kind, x.action?.ref]),
		[["run:dev-dev-1", "stop", "dev-dev-1"]],
	);
	running.clear();
});
