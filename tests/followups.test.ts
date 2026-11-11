import assert from "node:assert/strict";
import { test } from "node:test";
const { openDb, useDb } = await import("../server/db/index.ts");
useDb(openDb(":memory:"));
const { takeFollowups, saveFollowups, pendingFollowups, cancelFollowups, runDueFollowups, MAX_RUNS } =
	await import("../server/followups.ts");
const { splitNote } = await import("../server/drafts/format.ts");

const at = Date.parse("2026-11-11T10:00:00+08:00") / 1000;
const iso = (sec: number) => new Date((at + sec) * 1000).toISOString();

test("解析【复查】：对象或数组、取消、拿掉这一段，后面跟着的备注照样留着", () => {
	const raw = `好，CI 跑完我再看\n【复查】\n\`\`\`json\n{"key":"ci","at":"${iso(3600)}","about":"看 CI"}\n\`\`\`\n【备注】对方说十分钟`;
	const r = takeFollowups(raw, at);
	assert.equal(r.error, undefined);
	assert.deepEqual(r.specs, [{ key: "ci", at: at + 3600, about: "看 CI" }]);
	assert.ok(!r.text.includes("【复查】"));
	assert.equal(splitNote(r.text).note, "对方说十分钟");
	const many = takeFollowups(`x\n【复查】[{"key":"a","cancel":true},{"key":"b","at":"${iso(600)}","about":"y"}]`, at);
	assert.deepEqual(
		many.specs.map((s) => s.key),
		["a", "b"],
	);
	assert.equal(takeFollowups("没有复查", at).specs.length, 0);
});

test("解析【复查】：不带时区、太早太晚、没写 about、JSON 坏了都报错，但这一段照样拿掉", () => {
	const bad = (body: string) => takeFollowups(`回复\n【复查】${body}`, at);
	assert.match(bad(`{"key":"a","at":"2026-11-11T15:00:00","about":"x"}`).error!, /时区/);
	assert.match(bad(`{"key":"a","at":"${iso(60)}","about":"x"}`).error!, /5 分钟/);
	assert.match(bad(`{"key":"a","at":"${iso(8 * 86400)}","about":"x"}`).error!, /7 天/);
	assert.match(bad(`{"key":"a","at":"${iso(3600)}"}`).error!, /about/);
	const broken = bad("{不是 json");
	assert.match(broken.error!, /JSON/);
	assert.equal(broken.text, "回复");
});

test("记下、改期、取消，每件事最多 5 个", () => {
	const spec = (key: string, sec = 3600) => ({ key, at: at + sec, about: key });
	saveFollowups("tsk-a", "draft", "om_1", [spec("ci")], at);
	saveFollowups("tsk-a", "draft", "om_2", [spec("ci", 7200)], at);
	assert.deepEqual(
		pendingFollowups("tsk-a").map((f) => [f.key, f.at, f.actionId]),
		[["ci", at + 7200, "om_2"]],
		"同 key 是改期",
	);
	saveFollowups("tsk-a", "draft", "om_2", [{ key: "ci", cancel: true }], at);
	assert.equal(pendingFollowups("tsk-a").length, 0);
	const warn = saveFollowups(
		"tsk-a",
		"draft",
		"om_3",
		["1", "2", "3", "4", "5", "6"].map((k) => spec(k)),
		at,
	);
	assert.equal(pendingFollowups("tsk-a").length, 5);
	assert.match(warn, /6 没有记上/);
	cancelFollowups("tsk-a");
	assert.equal(pendingFollowups("tsk-a").length, 0);
});

test("到期执行：没到的不跑，取消了的不跑，同一件事超过次数上限就停并提醒", async () => {
	const ran: string[] = [];
	const told: string[] = [];
	const runner = {
		cancelled: (id: string) => id === "tsk-gone",
		draft: async (f: { key: string }) => void ran.push(`draft:${f.key}`),
		dev: async (f: { key: string }) => void ran.push(`dev:${f.key}`),
		exhausted: (f: { key: string }) => void told.push(f.key),
	};
	saveFollowups(
		"tsk-b",
		"draft",
		"om_1",
		[
			{ key: "soon", at: at + 600, about: "x" },
			{ key: "later", at: at + 7200, about: "y" },
		],
		at,
	);
	saveFollowups("tsk-gone", "draft", "om_9", [{ key: "x", at: at + 600, about: "x" }], at);
	saveFollowups("tsk-c", "dev", "dev-1", [{ key: "ci", at: at + 600, about: "x" }], at);
	await runDueFollowups(runner, at + 900);
	assert.deepEqual(ran.toSorted(), ["dev:ci", "draft:soon"]);
	assert.deepEqual(
		pendingFollowups("tsk-b").map((f) => f.key),
		["later"],
	);
	assert.equal(pendingFollowups("tsk-gone").length, 0, "取消了的到期也删掉");
	for (let i = 1; i < MAX_RUNS; i++) {
		saveFollowups("tsk-c", "dev", "dev-1", [{ key: "ci", at: at + 600, about: "x" }], at);
		await runDueFollowups(runner, at + 900);
	}
	saveFollowups("tsk-c", "dev", "dev-1", [{ key: "ci", at: at + 600, about: "x" }], at);
	await runDueFollowups(runner, at + 900);
	assert.equal(ran.filter((r) => r === "dev:ci").length, MAX_RUNS);
	assert.deepEqual(told, ["ci"]);
});

test("对方在这件事上来了新消息：自动复查次数清零", async () => {
	const { decide, receive } = await import("../server/pipeline.ts");
	const { db, schema, getKv, setKv } = await import("../server/db/index.ts");
	const t1 = receive({ channel: "lark", externalId: "om_f1", thread: "lark:oc_f#t", actorId: "ou_a", text: "晚点发你" });
	const r1 = decide([t1], { agent: "assistant", rule: "分诊", actionKind: "draft" });
	const taskId = db()
		.select()
		.from(schema.routes)
		.all()
		.find((r) => r.id === r1)!.taskId!;
	setKv(`fucount:${taskId}`, MAX_RUNS);
	const t2 = receive({ channel: "lark", externalId: "om_f2", thread: "lark:oc_f#t", actorId: "ou_a", text: "发你了" });
	decide([t2], { agent: "assistant", rule: "分诊", actionKind: "draft" });
	assert.equal(getKv(`fucount:${taskId}`, 0), 0);
});
