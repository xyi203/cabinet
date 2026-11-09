import assert from "node:assert/strict";
import { test } from "node:test";
const { openDb, useDb, db, schema } = await import("../server/db/index.ts");
useDb(openDb(":memory:"));
const { decide, receive, settle } = await import("../server/pipeline.ts");
const { refreshTask, deriveStatus } = await import("../server/taskstore.ts");
const { taskViews } = await import("../server/tasks.ts");

const t0 = Math.floor(Date.now() / 1000);
const msg = (id: string, thread: string, text = id, channel: "lark" | "cron" | "board" | "alert" = "lark") =>
	receive({ channel, externalId: id, thread, actorName: "张三", text, at: t0 });
const taskOf = (routeId: number) =>
	db()
		.select()
		.from(schema.routes)
		.all()
		.find((r) => r.id === routeId)!.taskId;

function draftFor(routeId: number, id: string, status: string, created = t0) {
	db()
		.insert(schema.drafts)
		.values({
			id,
			chatId: "oc_1",
			chatMode: "group",
			chatName: "交易群",
			replyTo: id,
			senderName: "张三",
			text: id,
			status,
			created,
			routeId,
		})
		.run();
}

function devFor(routeId: number, id: string, status: string, agent = "assistant", updated = t0) {
	db()
		.insert(schema.devTasks)
		.values({ id, agent, title: `任务 ${id}`, repo: "", base: "", branch: "", worktree: "", status, created: t0, updated, routeId })
		.run();
}

test("同一话题的追问挂到同一件事上；私聊主线关闭后再来是新的一件", () => {
	const r1 = decide([msg("m1", "lark:oc_1#t1")], { agent: "assistant", rule: "分诊", actionKind: "draft" });
	draftFor(r1, "d1", "pending");
	const r2 = decide([msg("m2", "lark:oc_1#t1")], { agent: "assistant", rule: "分诊", actionKind: "draft" });
	assert.equal(taskOf(r2), taskOf(r1));

	const p1 = decide([msg("m3", "lark:ou_p2p")], { agent: "assistant", rule: "分诊", actionKind: "draft" });
	draftFor(p1, "d3", "sent");
	assert.equal(refreshTask(taskOf(p1)!)?.status, "done");
	const p2 = decide([msg("m4", "lark:ou_p2p")], { agent: "assistant", rule: "分诊", actionKind: "draft" });
	assert.notEqual(taskOf(p2), taskOf(p1), "私聊主线已经发完了，新消息是新的一件");
});

test("话题关闭后几天内再来消息会重开；提到同一个 MR 的也接上", () => {
	const r1 = decide([msg("m5", "lark:oc_2#t9", "看下 https://gitlab.shoplazza.site/a/b/-/merge_requests/12")], {
		agent: "assistant",
		rule: "MR",
		actionKind: "draft",
	});
	draftFor(r1, "d5", "sent");
	assert.equal(refreshTask(taskOf(r1)!)?.status, "done");
	const r2 = decide([msg("m6", "lark:oc_2#t9")], { agent: "assistant", rule: "分诊", actionKind: "draft" });
	assert.equal(taskOf(r2), taskOf(r1));
	const r3 = decide([msg("m7", "lark:oc_other", "!12 改好了 https://gitlab.shoplazza.site/a/b/-/merge_requests/12")], {
		agent: "assistant",
		rule: "MR",
		actionKind: "draft",
	});
	assert.equal(taskOf(r3), taskOf(r1), "提到同一个 MR");
});

test("定时任务每次一件；指令挂到它操作的那件事上；不处理的不建任务", () => {
	const c1 = decide([msg("s1:1", "cron:s1", "巡检", "cron")], { agent: "assistant", rule: "定时", actionKind: "dev", actionId: "dv1" });
	devFor(c1, "dv1", "review");
	const c2 = decide([msg("s1:2", "cron:s1", "巡检", "cron")], { agent: "assistant", rule: "定时", actionKind: "dev", actionId: "dv2" });
	assert.notEqual(taskOf(c2), taskOf(c1));
	const cmd = decide([msg("m8", "bot:ou_yi#x")], { rule: "回复 agent 任务", actionKind: "command", actionId: "dv1" });
	assert.equal(taskOf(cmd), taskOf(c1));
	const none = decide([msg("m9", "lark:oc_3")], { rule: "跳过", actionKind: "none" });
	assert.equal(taskOf(none), null);
});

test("状态按产出推：待确认草稿等发送，建议不回直接完成，查询任务待看，dev 待推送，失败要重试，审批优先", () => {
	const route = (id: number, kind = "draft") => ({ id, actionKind: kind, at: id, triggers: [] }) as any;
	const base = { routes: [route(1)], drafts: [], devs: [], approvals: [], results: [] } as any;
	const d = (status: string) => ({ id: status, routeId: 1, status, created: 1 }) as any;
	assert.deepEqual(deriveStatus({ ...base, drafts: [d("pending")] }), { status: "in_review", need: "send" });
	assert.deepEqual(deriveStatus({ ...base, drafts: [d("noreply")] }), { status: "done", need: null });
	assert.deepEqual(deriveStatus({ ...base }), { status: "in_progress", need: null }, "分派了、还没产出：在起草");
	assert.deepEqual(deriveStatus({ ...base, results: [{ routeId: 1, outcome: "failed", at: 2 }] }), { status: "blocked", need: "retry" });
	const dev = { ...base, routes: [route(2, "dev")] };
	assert.deepEqual(deriveStatus({ ...dev, devs: [{ agent: "alert", status: "review", updated: 1 }] }), {
		status: "in_review",
		need: "read",
	});
	assert.deepEqual(deriveStatus({ ...dev, devs: [{ agent: "dev", status: "review", updated: 1 }] }), { status: "in_review", need: "send" });
	assert.deepEqual(deriveStatus({ ...base, drafts: [d("pending")], approvals: [{ status: "pending" }] }), {
		status: "blocked",
		need: "approve",
	});
});

test("看板：每件事带时间线和产出；草稿转任务后同一件事显示 agent 任务的状态", () => {
	const r1 = decide([msg("m20", "lark:oc_9#t1", "结算页 500")], { agent: "assistant", rule: "分诊：要查日志", actionKind: "draft" });
	draftFor(r1, "d20", "pending");
	const id = taskOf(r1)!;
	let v = taskViews([]).find((x) => x.id === id)!;
	assert.equal(v.status, "in_review");
	assert.equal(v.need, "send");
	assert.deepEqual(v.drafts, ["d20"]);
	assert.deepEqual(
		v.events.map((e) => e.k),
		["msg", "route"],
	);
	assert.equal(v.label, "交易群 · 张三");
	const r2 = decide([msg("b1", "board:dv20", "按这个改代码", "board")], {
		agent: "dev",
		rule: "草稿转任务",
		actionKind: "dev",
		actionId: "dv20",
		taskId: id,
	});
	devFor(r2, "dv20", "running", "dev");
	v = taskViews([]).find((x) => x.id === id)!;
	assert.equal(v.status, "in_progress");
	assert.deepEqual(v.devTasks, ["dv20"]);
	settle({ actionKind: "dev", actionId: "dv20", routeId: r2, outcome: "pushed", effect: "outward" });
	db().update(schema.devTasks).set({ status: "pushed" }).run();
	v = taskViews([]).find((x) => x.id === id)!;
	assert.equal(v.status, "done");
	assert.equal(v.result, "已提 MR");
});

test("推送规则：建议不回和表情不私聊，MR 预审和改写总要私聊；定时没变化、巡检正常直接归档", async () => {
	const { quietDraft } = await import("../server/drafts/store.ts");
	const { quietRound } = await import("../server/dev.ts");
	assert.equal(quietDraft({ report: "", kind: "text", noReply: true }), true, "建议不回");
	assert.equal(quietDraft({ report: "", kind: "reaction", noReply: false }), true, "表情");
	assert.equal(quietDraft({ report: "", kind: "text", noReply: false }), false, "要回的草稿照常私聊");
	assert.equal(quietDraft({ report: "✅ 可以通过", kind: "text", noReply: true }), false, "MR 预审带评审报告");
	assert.equal(quietDraft({ replaces: "d1", report: "", kind: "text", noReply: true }), false, "Yi 要求改写的结果");
	assert.equal(quietRound({ patrol: true }, "本轮巡查正常\n内存平稳"), true);
	assert.equal(quietRound({ patrol: false }, "  本轮无变化，还是那 3 个 MR"), true);
	assert.equal(quietRound({ patrol: false }, "新增 1 个 MR 等你看"), false);
	assert.equal(quietRound({ patrol: false }, "本轮巡查正常"), false, "不是巡检的不认巡检那句");
});

test("路由规则：没有 config/routes.json 时用默认值；保存时校验范围", async () => {
	const { RULE_DEFAULTS, routeRules, saveRouteRules } = await import("../server/rules.ts");
	assert.deepEqual(routeRules(), RULE_DEFAULTS);
	assert.throws(() => saveRouteRules({ alert: { quiet: 900, maxWait: 600 } }), /最长攒批不能比静默收口短/);
	assert.throws(() => saveRouteRules({ cron: { patrolPauseAt: 2 } }), /巡检额度上限/);
});
