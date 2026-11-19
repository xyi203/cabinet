// 没带链接的「已更新，继续CR一下」：认出是在催前面哪个 MR 的复审，挂回那次 CR（drafts/mr.ts mrFollowup）
import assert from "node:assert/strict";
import { test } from "node:test";
import { eq } from "drizzle-orm";
const { openDb, useDb, schema, db, setKv } = await import("../server/db/index.ts");
useDb(openDb(":memory:"));
const { decide, linkAction, receive, settle } = await import("../server/pipeline.ts");
const { refreshTask } = await import("../server/taskstore.ts");
const { lastMrDraft, mrFollowup, reReviewAsk, saveLedger, draftMrs } = await import("../server/drafts/mr.ts");
const { route } = await import("../server/agent/router.ts");
const { now } = await import("../server/util.ts");

const T0 = now() - 86400;
const MR71 = "https://gitlab.shoplazza.site/shoplaza/backend/checkout/cart/-/merge_requests/71#d80af7eeb1337f78c670c1cf5e9c69e9a380ef13";
const REF71 = "gitlab:shoplaza/backend/checkout/cart!71";
const msg = (id: string, text: string, at: number, extra: { thread?: string; actorId?: string; refs?: string[] } = {}) => ({
	channel: "lark" as const,
	externalId: id,
	thread: extra.thread ?? "lark:oc_cart",
	actorId: extra.actorId ?? "ou_zsj",
	actorName: "张森俊",
	text,
	at,
	refs: extra.refs,
});

/** 第一次 CR：贴 MR 链接 -> mr 档分派 -> 预审草稿，评论已发到 MR、草稿完成 */
const first = receive(msg("om_cr1", `@向懿 帮忙 CR 一下，满赠新加的购物车合并锁，count 请求改不加锁，减少锁竞争情况：${MR71}`, T0));
const firstRoute = decide([first], {
	agent: "assistant",
	rule: "MR 链接",
	session: "assistant-shoplaza_backend_checkout_cart-71",
	info: { tier: "mr", mrProject: "shoplaza/backend/checkout/cart", mrIid: "71" },
	actionKind: "draft",
});
db()
	.insert(schema.drafts)
	.values({
		id: "om_draft1",
		chatId: "oc_cart",
		chatMode: "group",
		replyTo: "om_cr1",
		report: "## 第一轮报告",
		status: "completed",
		created: T0 + 60,
		routeId: firstRoute,
	})
	.run();
linkAction(firstRoute, "om_draft1");
saveLedger("om_draft1", { base_sha: "b0", start_sha: "s0", head_sha: "b8ef18e7aaaa", inline: [], summary: "总结" });
setKv("draftmr:om_draft1", ["note"]);
settle({ actionKind: "draft", actionId: "om_draft1", routeId: firstRoute, outcome: "completed", effect: "internal" });
const taskOf = (routeId: number) =>
	db()
		.select()
		.from(schema.routes)
		.all()
		.find((r) => r.id === routeId)!.taskId;

test("同一个群里同一个人先贴 MR、后说「已更新，继续CR一下」：认定是这个 MR，分派挂到第一次 CR 那件事上", async () => {
	// 评论发出去那件事就完成了：关闭时间挪回一天前，过了「接着聊」的间隔，群主线只靠 MR 才挂得回去
	const firstTask = taskOf(firstRoute)!;
	assert.equal(refreshTask(firstTask)?.status, "done");
	db()
		.update(schema.tasks)
		.set({ closed: T0 + 300, updated: T0 + 300 })
		.where(eq(schema.tasks.id, firstTask))
		.run();
	const at = T0 + 7200;
	const follow = mrFollowup({ thread: "lark:oc_cart", senderId: "ou_zsj", text: "已更新，继续CR一下", at, rootRefs: [] });
	assert.deepEqual(follow, { ref: REF71, candidates: [REF71], via: "同一会话" });

	// make.ts 把认定的 MR 记进 trigger 的 refs，按 MR 归属
	const t2 = receive(msg("om_cr2", "已更新，继续CR一下", at, { refs: [follow!.ref!] }));
	const [name, info] = await route({
		chatMode: "group",
		senderName: "张森俊",
		text: "已更新，继续CR一下",
		followMr: { project: "shoplaza/backend/checkout/cart", iid: "71", rule: "催复审（同一会话）" },
	});
	assert.equal(info.tier, "mr", "不经分诊，直接进 mr 档");
	assert.equal(info.mrIid, "71");
	const r2 = decide([t2], {
		agent: name,
		rule: info.rule,
		info: { tier: "mr", mrProject: info.mrProject!, mrIid: info.mrIid! },
		actionKind: "draft",
	});
	assert.equal(taskOf(r2), taskOf(firstRoute), "看板上和第一次 CR 是同一件事");

	// 复审接着上一版的报告和台账：对比上次审到的提交，核对已发的评论
	const prev = lastMrDraft("shoplaza/backend/checkout/cart", "71")!;
	assert.equal(prev.id, "om_draft1");
	const ask = reReviewAsk(prev.report, draftMrs([prev]).get(prev.id), "对方没带链接说「已更新，继续CR一下」");
	assert.match(ask, /## 第一轮报告/);
	assert.match(ask, /已经发到 MR 上了/);
	assert.match(ask, /上次审到的 head 是 b8ef18e7aaaa/);
	assert.match(ask, /mr-re-review\.md/);
});

test("回复原消息说「好了，帮忙再看下」：按原消息提到的 MR 认定", () => {
	const follow = mrFollowup({
		thread: "lark:oc_other",
		senderId: "ou_x",
		text: "@向懿 好了，帮忙再看下",
		at: T0 + 1200,
		rootRefs: [REF71],
	});
	assert.deepEqual(follow, { ref: REF71, candidates: [REF71], via: "回复原消息" });
});

test("不像催复审、带了链接、别人说的、过了重开时间：都不挂", () => {
	const base = { thread: "lark:oc_cart", senderId: "ou_zsj", at: T0 + 1300, rootRefs: [] };
	assert.equal(mrFollowup({ ...base, text: "帮忙看下这个报错" }), undefined);
	assert.equal(mrFollowup({ ...base, text: `已更新 ${MR71}` }), undefined, "带链接的走 MR 链接那条路");
	assert.equal(mrFollowup({ ...base, senderId: "ou_other", text: "已更新，继续CR一下" }), undefined, "群主线里别人的 CR 不认");
	assert.equal(mrFollowup({ ...base, at: T0 + 30 * 86400, text: "已更新，继续CR一下" }), undefined);
});

test("最近贴过不止一个 MR：不挑，留候选给 Yi 定", () => {
	receive(msg("om_cr3", "这个也帮忙 CR 下 https://gitlab.shoplazza.site/shoplaza/backend/checkout/loong/-/merge_requests/9", T0 + 1400));
	const follow = mrFollowup({ thread: "lark:oc_cart", senderId: "ou_zsj", text: "改好了，再看下", at: T0 + 1500, rootRefs: [] });
	assert.equal(follow?.ref, undefined);
	assert.deepEqual(new Set(follow?.candidates), new Set([REF71, "gitlab:shoplaza/backend/checkout/loong!9"]));
	// 回复的是哪条就按哪条，不受会话里别的 MR 干扰
	assert.equal(
		mrFollowup({ thread: "lark:oc_cart", senderId: "ou_zsj", text: "改好了，再看下", at: T0 + 1500, rootRefs: [REF71] })?.ref,
		REF71,
	);
});

test("批准、发评论之后以 Yi 的身份在原消息下回一句：群里回到话题里，私聊引用回复，发出的那条不当成 Yi 亲自回复", async () => {
	const { announceMr } = await import("../server/drafts/mr.ts");
	const { isHandled } = await import("../server/handled.ts");
	const sent: Array<{ target: unknown; text: string; uuid: string }> = [];
	const send = async (target: unknown, text: string, uuid: string) => (sent.push({ target, text, uuid }), `om_sent${sent.length}`);
	await announceMr({ id: "om_draft1", chatMode: "group", replyTo: "om_cr1" }, "approve", send);
	await announceMr({ id: "om_draft1", chatMode: "group", replyTo: "om_cr1" }, "note", send);
	await announceMr({ id: "om_draft9", chatMode: "p2p", replyTo: "om_p2p" }, "note", send);
	await announceMr({ id: "d-meego", chatMode: "meego", replyTo: "meego:1" }, "approve", send);
	assert.deepEqual(sent, [
		{ target: { replyTo: "om_cr1", inThread: true }, text: "approved", uuid: "mr-approve-om_draft1" },
		{ target: { replyTo: "om_cr1", inThread: true }, text: "已评论", uuid: "mr-note-om_draft1" },
		{ target: { replyTo: "om_p2p", inThread: false }, text: "已评论", uuid: "mr-note-om_draft9" },
	]);
	assert.deepEqual([...isHandled(["om_sent1", "om_sent2", "om_sent3"])].sort(), ["om_sent1", "om_sent2", "om_sent3"]);
});

test("评审没问题才自动批准：agent 标了可以通过，且没有行内评论、没有要回复作者的旧线程", async () => {
	const { cleanReview, parseLedger } = await import("../server/drafts/mr.ts");
	const base = { base_sha: "b", start_sha: "s", head_sha: "h", summary: "总结" };
	const parsed = parseLedger(JSON.stringify({ ...base, inline: [], approve: true }));
	assert.ok(typeof parsed !== "string" && parsed.approve === true);
	assert.equal(cleanReview(parsed as Exclude<typeof parsed, string>), true);
	const ledger = (x: object) => ({ ...base, inline: [], ...x });
	assert.equal(cleanReview(ledger({})), false, "agent 没标就不批：台账为空也可能是没审成");
	assert.equal(cleanReview(ledger({ approve: true, threads: [{ discussion_id: "d1", action: "resolve" }] })), true, "旧线程都已修复");
	assert.equal(cleanReview(ledger({ approve: true, threads: [{ discussion_id: "d1", action: "reply", body: "还没改" }] })), false);
	assert.equal(
		cleanReview(ledger({ approve: true, inline: [{ old_path: "a", new_path: "a", new_line: 1, body: "问题" }] })),
		false,
		"标了可以通过却还有评论：不批，留给 Yi",
	);
	assert.equal((parseLedger(JSON.stringify({ ...base, inline: [], approve: "yes" })) as { approve?: boolean }).approve, undefined);
});
