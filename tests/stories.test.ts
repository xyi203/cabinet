import assert from "node:assert/strict";
import { test } from "node:test";
const { mergeTickets, parseStoryRef, parseTicketInfo, parseTicketKeys, patrolPrompt, observePrompt, ticketContext } =
	await import("../server/stories.ts");

test("交给助手时带上挂着的发布工单、观察文档链接和首次观察，解绑的不带", () => {
	const summaries: Record<string, string> = {
		"dev-1": "文档已更新。\n\nhttps://shoplazza.feishu.cn/docx/old\nhttps://shoplazza.feishu.cn/wiki/LV5Gwrfw9iTxYHksvbIcYsBKnjc",
	};
	const ctx = ticketContext(
		{
			tickets: [
				{
					key: "GD-1",
					title: "functions-api AB",
					status: "M1审核",
					doc: { taskId: "dev-1" },
					patrol: { observeTaskId: "dev-2", scheduleId: "s1", started: 0 },
				},
				{ key: "GD-2", title: "", status: "已完成", ended: true, doc: { taskId: "dev-9" } },
				{ key: "GD-3", title: "解绑了", status: "M1审核", removed: true },
			],
		},
		(id) => summaries[id],
	);
	assert.match(
		ctx,
		/GD-1「functions-api AB」：M1审核；发布观察文档 https:\/\/shoplazza\.feishu\.cn\/wiki\/LV5Gwrfw9iTxYHksvbIcYsBKnjc，任务 dev-1；首次观察任务 dev-2，巡检中/,
	);
	assert.match(ctx, /GD-2：已完成（已结束）；发布观察文档（链接见任务结论），任务 dev-9/);
	assert.doesNotMatch(ctx, /GD-3/);
	assert.equal(ticketContext({ tickets: [] }), "");
});
const { PATROL_OK } = await import("../server/dev.ts");

test("认出文字和链接里的发布工单号，去重转大写", () => {
	assert.deepEqual(parseTicketKeys("GD-45119 gd-45200，https://publish.shoplazza.site/x/GD-45119"), ["GD-45119", "GD-45200"]);
	assert.deepEqual(parseTicketKeys("没有工单号 MGD-1"), []);
});

test("认出飞书工单链接或纯数字 ID", () => {
	assert.deepEqual(parseStoryRef("https://project.feishu.cn/research__development/issue/detail/7159107851?x=1"), {
		id: "7159107851",
		space: "research__development",
	});
	assert.deepEqual(parseStoryRef(" 7159107851 "), { id: "7159107851" });
	assert.equal(parseStoryRef("GD-45119"), undefined);
});

const info = (o: { stage: number; status: string; ids: string }) =>
	JSON.stringify({
		issue: {
			issueInfo: { issueKey: "GD-1", summary: "functions api 优化", statusName: o.status, stage: o.stage },
			issueParams: [{ paramKey: "feishuStoryIds", paramValue: o.ids }],
			steps: [{ stage: 0 }, { stage: 1 }, { stage: 3 }, { stage: 5 }],
		},
	});

test("工单详情取标题、状态、飞书工单 ID，走到最后一步或终止算结束", () => {
	const t = parseTicketInfo("GD-1", info({ stage: 3, status: "M1审核", ids: "7159107851,7154379825" }));
	assert.deepEqual(t, { key: "GD-1", title: "functions api 优化", status: "M1审核", ended: false, storyIds: ["7159107851", "7154379825"] });
	assert.equal(parseTicketInfo("GD-1", info({ stage: 5, status: "已完成", ids: "" })).ended, true);
	assert.equal(parseTicketInfo("GD-1", info({ stage: 1, status: "已终止", ids: "" })).ended, true);
	assert.throws(() => parseTicketInfo("GD-2", "{}"));
});

test("合并发布工单：自动按飞书工单 ID 挂，解绑过的不再自动挂，手动绑会重新挂上", () => {
	const infos = new Map([
		["GD-1", { key: "GD-1", title: "a", status: "M1审核", ended: false, storyIds: ["s1"] }],
		["GD-2", { key: "GD-2", title: "b", status: "完成", ended: true, storyIds: ["s2"] }],
	]);
	assert.deepEqual(mergeTickets("s1", [], infos), [{ key: "GD-1", title: "a", status: "M1审核", ended: false, source: "auto" }]);
	// 别的需求的单不挂
	assert.deepEqual(mergeTickets("s3", [], infos), []);
	// 解绑过的：只更新状态，不去掉 removed
	const removed = [{ key: "GD-1", title: "a", status: "stg", removed: true, source: "auto" as const }];
	assert.equal(mergeTickets("s1", removed, infos)[0].removed, true);
	assert.equal(mergeTickets("s1", removed, infos).length, 1);
	// 手动绑：解绑过的重新挂上，来源改成手动；没填这条需求的单也能绑，可多张
	const bound = mergeTickets("s1", removed, infos, { keys: ["GD-1", "GD-2"], source: "manual" });
	assert.deepEqual(
		bound.map((t) => [t.key, t.source, t.removed, t.status]),
		[
			["GD-1", "manual", undefined, "M1审核"],
			["GD-2", "manual", undefined, "完成"],
		],
	);
	// 提单后挂的：详情还查不到也先挂工单号
	assert.deepEqual(mergeTickets("s1", [], new Map(), { keys: ["GD-9"], source: "created" }), [
		{ key: "GD-9", title: "", status: "", ended: undefined, source: "created" },
	]);
});

test("巡检提示：每轮先读首次观察的范围和基线，正常时第一行固定，首次观察要写出基线段", () => {
	const story = { id: "7159107851", typeKey: "issue", title: "functions-api OOM", url: "" } as any;
	const p = patrolPrompt(story, "GD-45119", "dev-1");
	assert.match(p, /lookup dev-1/);
	assert.match(p, /references\/patrol\.md/);
	assert.ok(p.includes(`「${PATROL_OK}」`));
	assert.match(observePrompt(story, "GD-45119", "dev-0"), /【巡检范围与基线】[\s\S]*/);
	assert.match(observePrompt(story, "GD-45119", "dev-0"), /lookup dev-0/);
});
