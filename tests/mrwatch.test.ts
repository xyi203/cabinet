import assert from "node:assert/strict";
import { test } from "node:test";
const { openDb, useDb } = await import("../server/db/index.ts");
useDb(openDb(":memory:"));
const { decide } = await import("../server/mrwatch.ts");
const { listWatches, saveWatch } = await import("../server/drafts/mr.ts");

const MARK = "<!-- gitlab-mr-review -->";
const w0 = { project: "a/b", iid: "7", url: "u", draftId: "om_d", head: "h1", since: 0 };
const latest = () => listWatches().find((w) => w.iid === "7")!;
const ours = (id: string, ...notes: Array<{ id: number; author?: number; body?: string; system?: boolean }>) => ({
	id,
	notes: [{ id: 1, body: `问题 ${MARK}`, author: { id: 100 } }, ...notes.map((n) => ({ ...n, author: { id: n.author ?? 200 } }))],
});

test("盯 MR：第一次只记下已有的回复；别人在本工具的线程里回复就复审，自己和系统的不算", () => {
	saveWatch(w0);
	assert.equal(decide(latest(), "h1", [ours("d1", { id: 5 })], 100, 0), undefined, "已有回复不算新的");
	assert.equal(latest().seenNote, 5);
	assert.equal(decide(latest(), "h1", [ours("d1", { id: 5 }, { id: 6, author: 100 }, { id: 7, system: true })], 100, 10), undefined);
	assert.equal(
		decide(latest(), "h1", [ours("d1", { id: 5 }, { id: 8, body: `不同意 ${MARK.replace("-->", "reply -->")}` })], 100, 20),
		undefined,
		"带标记的是复审自己回的",
	);
	// 别人开的线程里的回复不触发
	assert.equal(
		decide(
			latest(),
			"h1",
			[
				{
					id: "x",
					notes: [
						{ id: 2, body: "别人的评论" },
						{ id: 9, author: { id: 200 } },
					],
				},
			],
			100,
			30,
		),
		undefined,
	);
	assert.match(decide(latest(), "h1", [ours("d1", { id: 10 })], 100, 40)!, /1 条评论线程里回复/);
});

test("盯 MR：新提交要稳定一阵才复审，期间的回复等它一起", () => {
	saveWatch({ ...w0, seenNote: 1 });
	assert.equal(decide(latest(), "h2", [ours("d1", { id: 11 })], 100, 1000), undefined, "刚推上来，先等");
	assert.equal(decide(latest(), "h3", [], 100, 1300), undefined, "又推了一次，重新计时");
	assert.equal(decide(latest(), "h3", [], 100, 1600), undefined);
	const r = decide(latest(), "h3", [ours("d1", { id: 11 })], 100, 1900);
	assert.match(r!, /新提交.*h1.*h3.*线程里也有新回复/);
});
