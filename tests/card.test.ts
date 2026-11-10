import assert from "node:assert/strict";
import { test } from "node:test";
process.env.OWNER_OPEN_ID = "ou_yi";
const { openDb, useDb, schema } = await import("../server/db/index.ts");
useDb(openDb(":memory:"));
const { db } = await import("../server/db/index.ts");
const { draftCard, editable, parseCardAction, sendText, CardInputError, INPUT_MAX } = await import("../server/drafts/card.ts");
const { onDraftCardAction } = await import("../server/drafts/actions.ts");
const { getDraft } = await import("../server/drafts/store.ts");

const base = {
	id: "om_card",
	chatId: "oc_1",
	chatMode: "group",
	chatName: "订单组",
	replyTo: "om_src",
	threadId: null,
	senderId: "ou_a",
	senderName: "张三",
	text: "这个接口为什么 500 了",
	context: "张三：刚上线的版本",
	meego: null,
	agent: "ask",
	session: null,
	route: null,
	kind: "text",
	draft: "我看一下日志",
	note: "",
	report: "",
	status: "pending",
	created: 1,
};

/** 卡片里所有的组件，按 tag 摊平 */
function walk(card: any): any[] {
	const out: any[] = [];
	const visit = (n: any) => {
		if (!n || typeof n !== "object") return;
		if (Array.isArray(n)) return n.forEach(visit);
		if (n.tag) out.push(n);
		for (const k of ["elements", "columns", "body"]) visit(n[k]);
	};
	visit(card.body);
	return out;
}

test("待确认的草稿是一张表单，草稿预填在输入框里", () => {
	const els = walk(draftCard(base as any));
	const form = els.find((e) => e.tag === "form");
	assert.ok(form);
	const input = els.find((e) => e.tag === "input" && e.name === "text");
	assert.equal(input.default_value, "我看一下日志");
	const buttons = els.filter((e) => e.tag === "button");
	assert.deepEqual(
		buttons.slice(0, 4).map((e) => e.behaviors[0].value.a),
		["send", "discard", "complete", "revise"],
	);
	assert.ok(buttons.every((e) => e.form_action_type === "submit"));
	// 对方的原话用 plain_text，不当 markdown 渲染
	const src = els.find((e) => e.tag === "div" && e.text.content === base.text);
	assert.equal(src.text.tag, "plain_text");
});

test("处理完的草稿没有按钮", () => {
	for (const status of ["sent", "discarded", "completed", "expired", "replaced", "sending", "revising"]) {
		const els = walk(draftCard({ ...base, status } as any));
		assert.equal(els.filter((e) => e.tag === "button" || e.tag === "form").length, 0, status);
	}
});

test("超过输入框上限的草稿不给编辑框，原样发", () => {
	const long = { ...base, draft: "长".repeat(INPUT_MAX + 1) };
	assert.equal(editable(long as any), false);
	assert.equal(
		walk(draftCard(long as any)).find((e) => e.tag === "input" && e.name === "text"),
		undefined,
	);
	assert.equal(sendText(long as any, undefined), "");
});

test("超长内容截断后卡片不超过 30KB", () => {
	const huge = "很".repeat(20000);
	const d = { ...base, text: huge, context: huge, report: huge, note: huge, draft: huge };
	assert.ok(Buffer.byteLength(JSON.stringify(draftCard(d as any))) < 28 * 1024);
});

test("发送时：没改原样发，改了发新的，清空了报错", () => {
	assert.equal(sendText(base as any, "我看一下日志"), "");
	assert.equal(sendText(base as any, " 我看一下日志 \n"), "");
	assert.equal(sendText(base as any, "我看一下"), "我看一下");
	assert.throws(() => sendText(base as any, ""), CardInputError);
	// 飞书不回传空输入框：可编辑的卡片缺这一项就是被清空了，不能当原样发
	assert.throws(() => sendText(base as any, undefined), CardInputError);
	// 表情草稿：留空发表情，写了字发文字
	const emoji = { ...base, kind: "reaction", draft: "THUMBSUP" };
	assert.equal(sendText(emoji as any, undefined), "");
	assert.equal(sendText(emoji as any, "好的"), "好的");
});

test("解析摊平后的 card.action.trigger", () => {
	const ev = parseCardAction({
		operator: { open_id: "ou_yi" },
		context: { open_message_id: "om_card", open_chat_id: "oc_dm" },
		action: { tag: "button", name: "send", value: { a: "send" }, form_value: { text: "改过的", opinion: "", emoji: 1 } },
	});
	assert.deepEqual(ev, {
		operatorId: "ou_yi",
		messageId: "om_card",
		name: "send",
		form: { text: "改过的", opinion: "" },
		value: { a: "send" },
	});
	assert.equal(parseCardAction({ operator: {} }), undefined);
});

const click = (name: string, operator = "ou_yi", form: Record<string, string> = {}) =>
	onDraftCardAction({
		operator: { open_id: operator },
		context: { open_message_id: "om_card" },
		action: { name, value: { a: name }, form_value: form },
	}) as Promise<any>;

test("只有 Yi 能点草稿卡片", async () => {
	db().insert(schema.drafts).values(base).run();
	const r = await click("discard", "ou_other");
	assert.equal(r.toast.type, "error");
	assert.equal(getDraft("om_card")!.status, "pending");
});

test("点「不回复」：草稿结束，回调直接带回结果卡片", async () => {
	const r = await click("discard");
	assert.equal(r.toast.type, "success");
	assert.equal(getDraft("om_card")!.status, "discarded");
	assert.equal(walk(r.card.data).filter((e) => e.tag === "button").length, 0);
	// 已经处理过的草稿再点，报错并带回当前状态的卡片
	const again = await click("send", "ou_yi", { text: "x" });
	assert.equal(again.toast.type, "error");
	assert.equal(getDraft("om_card")!.status, "discarded");
});

test("没选表情就点「回表情」只提示，不动草稿", async () => {
	db()
		.insert(schema.drafts)
		.values({ ...base, id: "om_card2" })
		.run();
	const r = await onDraftCardAction({
		operator: { open_id: "ou_yi" },
		context: { open_message_id: "om_card2" },
		action: { name: "emoji", form_value: {} },
	});
	assert.equal((r as any).toast.type, "error");
	assert.equal(getDraft("om_card2")!.status, "pending");
});

const { devCard } = await import("../server/devcard.ts");
const { failureCard } = await import("../server/drafts/card.ts");
const { onCardAction } = await import("../server/cards.ts");

const task = {
	id: "dev-1",
	agent: "dev",
	repo: "/code/order",
	branch: "feature/x",
	title: "加筛选",
	status: "review",
	mrUrl: null,
} as any;
const buttonsOf = (card: object) =>
	walk(card)
		.filter((e) => e.tag === "button")
		.map((e) => e.behaviors?.[0]?.value?.a ?? e.name);

test("agent 任务卡片：按状态给操作，只有最新一张带按钮", () => {
	const round = { what: "第 1 轮完成", body: "改好了" };
	assert.deepEqual(buttonsOf(devCard(task, round)), ["say", "push", "discard"]);
	assert.deepEqual(buttonsOf(devCard({ ...task, status: "running" }, round)), ["say", "stop"]);
	assert.deepEqual(buttonsOf(devCard({ ...task, status: "pushing" }, round)), []);
	assert.deepEqual(buttonsOf(devCard({ ...task, status: "pushed", mrUrl: "https://x/merge_requests/1" }, round)), [
		"say",
		"push",
		"complete",
		"discard",
	]);
	assert.deepEqual(buttonsOf(devCard({ ...task, agent: "alert", title: "告警 · 订单群 · 3 条" }, round)), ["say", "complete"]);
	assert.deepEqual(buttonsOf(devCard(task, round, false)), []);
	for (const status of ["done", "discarded"]) assert.deepEqual(buttonsOf(devCard({ ...task, status }, round)), []);
});

test("agent 任务卡片：标题不带内部名词和 ·，「放弃」要二次确认，不用红色按钮", async () => {
	const { devTitle } = await import("../server/devcard.ts");
	assert.equal(devTitle(task), "开发任务：order（feature/x）");
	assert.equal(devTitle({ ...task, agent: "alert", title: "告警 · 订单群 · 3 条" }), "告警：订单群（3 条）");
	assert.equal(devTitle({ ...task, agent: "assistant", title: "定时 · 早报" }), "定时任务：早报");
	assert.equal(devTitle({ ...task, agent: "assistant", title: "查一下订单" }), "查一下订单");
	const els = walk(devCard(task, { what: "第 1 轮完成", body: "改好了" }));
	const discard = els.find((e) => e.tag === "button" && e.behaviors?.[0]?.value?.a === "discard");
	assert.ok(discard.confirm?.title?.content);
	assert.ok(els.every((e) => e.type !== "danger"));
});

test("agent 任务卡片：元素 name 不重复（飞书会拒发整张卡）", () => {
	const round = { what: "第 1 轮完成", body: "改好了" };
	for (const status of ["review", "running", "pushed"]) {
		const names = walk(devCard({ ...task, status }, round))
			.map((e) => e.name)
			.filter(Boolean);
		assert.equal(new Set(names).size, names.length, `${status}: ${names}`);
	}
});

test("起草失败卡片：重试 / 忽略，处理过后没有按钮", () => {
	const f = { taskId: "fail-om_x", where: "私聊 · 张三", text: "在吗", error: "pi 超时" };
	assert.deepEqual(buttonsOf(failureCard(f)), ["retry", "ignore"]);
	assert.deepEqual(buttonsOf(failureCard(f, "retrying")), []);
	assert.deepEqual(buttonsOf(failureCard(f, "dismissed")), []);
});

test("卡片回调只认 Yi，按 value.k 分给任务和失败提醒", async () => {
	const other = await onCardAction({
		operator: { open_id: "ou_x" },
		context: { open_message_id: "om_any" },
		action: { value: { k: "dev", a: "push", t: "dev-1" } },
	});
	assert.equal((other as any).toast.type, "error");
	const missing = await onCardAction({
		operator: { open_id: "ou_yi" },
		context: { open_message_id: "om_any" },
		action: { value: { k: "fail", a: "ignore", t: "fail-none" } },
	});
	assert.match((missing as any).toast.content, /找不到/);
	const noTask = await onCardAction({
		operator: { open_id: "ou_yi" },
		context: { open_message_id: "om_any" },
		action: { value: { k: "dev", a: "complete", t: "dev-none" } },
	});
	assert.match((noTask as any).toast.content, /任务不存在/);
});

test("草稿卡片：元素 name 不重复（表情下拉框和回表情按钮撞名时飞书拒发整张卡）", () => {
	for (const d of [base, { ...base, kind: "reaction", draft: "OK" }, { ...base, status: "noreply", draft: "" }]) {
		const names = walk(draftCard(d as any))
			.map((e) => e.name)
			.filter(Boolean);
		assert.equal(new Set(names).size, names.length, names.join(","));
	}
});

test("MR 预审草稿卡片：有 approve / 发评论按钮，name 不重复，做过的不再出按钮；发出后也还在", () => {
	const mr = { project: "shoplaza/x", iid: "7", url: "https://g/x/-/merge_requests/7", done: [] as Array<"approve" | "note"> };
	const d = { ...base, report: "✅ 可以通过" };
	const callbacks = (card: object) =>
		walk(card)
			.flatMap((e) => (e.behaviors ?? []).map((b: any) => b.value?.a))
			.filter((a: string) => a?.startsWith("mr_"));
	for (const st of ["pending", "sent"]) {
		const card = draftCard({ ...d, status: st } as any, "", mr);
		const names = walk(card)
			.map((e) => e.name)
			.filter(Boolean);
		assert.equal(new Set(names).size, names.length, names.join(","));
		assert.deepEqual(callbacks(card), ["mr_approve", "mr_note"]);
	}
	assert.deepEqual(callbacks(draftCard(d as any, "", { ...mr, done: ["approve"] })), ["mr_note"]);
	assert.deepEqual(callbacks(draftCard({ ...d, report: "" } as any, "", mr)), ["mr_approve"]);
	assert.deepEqual(callbacks(draftCard(d as any)), []);
});

test("MR 预审有评论台账：卡片列出将发的评论，按钮是确认发送；发过之后不再列", () => {
	const ledger = {
		base_sha: "b",
		start_sha: "s",
		head_sha: "h",
		inline: [
			{
				old_path: "a.go",
				new_path: "a.go",
				new_line: 12,
				body: "🔴 **Important**：空指针\n\n<details>\n<summary>为什么</summary>\n\n- 证据\n\n</details>\n\n<!-- gitlab-mr-review -->",
			},
		],
		summary: "**gitlab-mr-review**（standard）：改了下单",
	};
	const mr = { project: "shoplaza/x", iid: "7", url: "u", done: [] as Array<"approve" | "note">, ledger };
	const d = { ...base, status: "noreply", draft: "【无需回复】已回 Get", report: "⚠️ 小问题" };
	const els = walk(draftCard(d as any, "", mr));
	const text = JSON.stringify(els);
	assert.ok(text.includes("a.go:12"));
	assert.ok(text.includes("要发到 MR 的评论"));
	assert.ok(!text.includes("gitlab-mr-review -->"), "隐藏标记不出现在卡片上");
	assert.ok(els.some((e) => e.tag === "button" && e.text?.content === "发送评论"));
	assert.ok(!JSON.stringify(walk(draftCard(d as any, "", { ...mr, done: ["note"] }))).includes("要发到 MR 的评论"));
});

test("MR 评论台账：校验 SHA、总结、行号", async () => {
	const { parseLedger } = await import("../server/drafts/mr.ts");
	const ok = parseLedger(
		'```json\n{"base_sha":"b","start_sha":"s","head_sha":"h","inline":[{"new_path":"a.go","new_line":3,"body":"x"}],"summary":"y"}\n```',
	);
	assert.ok(typeof ok === "object");
	assert.equal(ok.inline[0].old_path, "a.go");
	assert.equal(typeof parseLedger("{"), "string");
	assert.match(
		parseLedger('{"base_sha":"b","start_sha":"s","head_sha":"h","summary":"y","inline":[{"new_path":"a.go","body":"x"}]}') as string,
		/第 1 条/,
	);
	assert.match(parseLedger('{"base_sha":"b","start_sha":"s","head_sha":"h"}') as string, /summary/);
});

test("复审台账：线程动作 resolve / reply，回复必须有正文", async () => {
	const { parseLedger } = await import("../server/drafts/mr.ts");
	const base = '"base_sha":"b","start_sha":"s","head_sha":"h","inline":[],"summary":"y"';
	const ok = parseLedger(
		`{${base},"threads":[{"discussion_id":"d1","action":"resolve"},{"discussion_id":"d2","action":"reply","body":"还在"}]}`,
	);
	assert.ok(typeof ok === "object");
	assert.deepEqual(ok.threads, [
		{ discussion_id: "d1", action: "resolve" },
		{ discussion_id: "d2", action: "reply", body: "还在" },
	]);
	assert.equal((parseLedger(`{${base}}`) as { threads?: unknown }).threads, undefined, "首轮没有 threads");
	assert.match(parseLedger(`{${base},"threads":[{"discussion_id":"d2","action":"reply"}]}`) as string, /正文/);
	assert.match(parseLedger(`{${base},"threads":[{"discussion_id":"d2","action":"close"}]}`) as string, /action/);
});
