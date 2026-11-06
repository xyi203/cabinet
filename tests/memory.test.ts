// 长期记忆：切词、召回分组与门槛、向量（Turso vector32）、提取校验、关系处理、生命周期、草稿走完后的提取
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";

// 假的 embedding 服务：按词哈希到 64 维，词重叠越多余弦越高
const { lexicalTerms } = await import("../server/memory/terms.ts");
const vec = (t: string) => {
	const v = Array.from<number>({ length: 64 }).fill(0);
	for (const tok of lexicalTerms(t.replace(/^Q:/, ""))) v[[...tok].reduce((h, c) => (h * 31 + c.codePointAt(0)!) % 64, 7)] += 1;
	v[63] += 0.01;
	return v;
};
let embedCalls = 0;
const server = createServer((req, res) => {
	let body = "";
	req.on("data", (c) => (body += c));
	req.on("end", () => {
		embedCalls++;
		const { input } = JSON.parse(body);
		res.end(JSON.stringify({ embeddings: input.map(vec) }));
	});
}).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
server.unref();

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "cabinet-memory-"));
process.env.EMBED_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
process.env.EMBED_QUERY_PREFIX = "Q:";
process.env.MEMORY_MIN_SIMILARITY = "0.6";
process.env.MEMORY_MIN_KEYWORD = "1.0";
process.env.MEMORY_MIN_KEYWORD_COSINE = "0";
process.env.MEMORY_MODEL = "faux-1";
process.env.PI_FALLBACK_MODEL = "";

const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
const models = createModels();
models.setProvider(faux.provider);
(await import("../server/agent/models.ts")).useModels(models);
const { openDb, useDb, db, schema } = await import("../server/db/index.ts");
useDb(openDb(":memory:"));
const store = await import("../server/memory/store.ts");
const { recall, render, search } = await import("../server/memory/recall.ts");
const extract = await import("../server/memory/extract.ts");
const { classifyStatement } = await import("../server/memory/remember.ts");

const yi = (quote: string) => ({ kind: "yi" as const, ref: "om_x", quote, at: 1 });
const ref = (content: string, kind: import("../server/memory/store.ts").Kind = "experience") =>
	store.rememberFromYi(content, { kind, application: "reference", appliesWhen: "" }, yi(content), "test", false);

test("切词：中文 bigram、落单虚字不成词、ASCII 小写", () => {
	assert.deepEqual(lexicalTerms("发布工单 Platform"), ["发布", "布工", "工单", "platform"]);
	assert.deepEqual(lexicalTerms("issue 的 status"), ["issue", "status"]);
	assert.deepEqual(lexicalTerms("查 a 表"), ["查", "表"]);
});

test("约定每次都带，线索过门槛才带，候选不带", async () => {
	const conv = store.rememberFromYi(
		"回 PM 的排期问题不要直接承诺日期",
		{ kind: "preference", application: "convention", appliesWhen: "有人问上线或排期时间时" },
		yi("以后回排期别直接承诺日期"),
		"test",
		true,
	);
	const hit = ref("查订单支付失败先看 pikachu 的 authorize 日志");
	ref("glab 操作前要先登录");
	db().transaction((tx) =>
		store.insertMemory(tx, {
			content: "订单支付失败多半是风控拦截",
			kind: "fact",
			application: "reference",
			provenance: "model_inference",
			state: "candidate",
			evidence: [],
			source: "test",
		}),
	);
	await store.backfillVectors();
	const r = await recall("这个订单支付失败了，authorize 报错", {});
	assert.deepEqual(
		r.conventions.map((m) => m.id),
		[conv.id],
	);
	assert.deepEqual(
		r.references.map((m) => m.id),
		[hit.id],
	);
	const block = render(r);
	assert.match(block, /适用的长期约定[\s\S]*排期问题[\s\S]*适用：有人问上线或排期时间时/);
	assert.match(block, /历史线索[\s\S]*pikachu/);
	assert.doesNotMatch(block, /风控/);
	// 无关的消息只带约定
	const idle = await recall("中午吃什么", {});
	assert.equal(idle.references.length, 0);
	assert.equal(idle.conventions.length, 1);
});

test("向量存在 Turso 里，改了内容（升 revision）旧向量不再参与", async () => {
	const m = ref("CR 时重点看事务边界和错误处理");
	await store.backfillVectors();
	const before = (await search("帮我 CR 一下事务边界", { anyScope: true })).scores.find((s) => s.id === m.id);
	assert.ok(before?.vector !== undefined && before.vector > 0.5);
	db().transaction((tx) => store.updateMemory(tx, m.id, { content: "合并前确认 CI 通过" }));
	const stale = (await search("帮我 CR 一下事务边界", { anyScope: true })).scores.find((s) => s.id === m.id);
	assert.equal(stale?.vector, undefined);
	await store.backfillVectors();
	assert.equal(store.vectorStatus().pending, 0);
});

test("向量服务挂了：退成只用关键词，并标记降级", async () => {
	const url = process.env.EMBED_URL;
	const { MEMORY } = await import("../server/config.ts");
	MEMORY.embedUrl = "http://127.0.0.1:1";
	try {
		const r = await search("pikachu authorize 日志", { anyScope: true });
		assert.ok(r.degraded);
		assert.ok(r.items.some((m) => m.content.includes("pikachu")));
	} finally {
		MEMORY.embedUrl = url!;
	}
});

test("作用域：限某个人的约定只在和他有关时带", async () => {
	store.rememberFromYi(
		"回张三不用寒暄，直接说结论",
		{ kind: "preference", application: "convention", appliesWhen: "回复张三时", scope: "person:ou_zhang", scopeName: "张三" },
		yi("以后回张三直接说结论"),
		"test",
		true,
	);
	const other = await recall("在吗", { personId: "ou_li" });
	assert.ok(!other.conventions.some((m) => m.scope === "person:ou_zhang"));
	const his = await recall("在吗", { personId: "ou_zhang" });
	assert.ok(his.conventions.some((m) => m.scope === "person:ou_zhang"));
});

test("遗忘立即停用，同一句话不会被重新记回来；恢复要显式操作", async () => {
	const m = ref("staging 环境的数据库每晚 2 点重置");
	store.forgetMemory(m.id, m.revision);
	assert.equal((await recall("staging 数据库 重置", {})).references.length, 0);
	assert.throws(() => ref("staging 环境的数据库每晚 2 点重置"), /被遗忘过/);
	const restored = store.restoreMemory(m.id, store.getMemory(m.id)!.revision);
	assert.equal(restored.state, "active");
	assert.throws(() => store.forgetMemory(m.id, m.revision - 1), /已经改过/);
});

test("内容闸：不记凭证、不记超长", () => {
	assert.throws(() => ref("测试库密码 password=abc123456"), /凭证/);
	assert.throws(() => ref("x".repeat(301)), /超过/);
	assert.throws(
		() => store.rememberFromYi("回复要短", { kind: "fact", application: "convention", appliesWhen: "总是" }, yi(""), "test", true),
		/只有偏好/,
	);
});

// ---------- 提取 ----------

const batch: import("../server/memory/extract.ts").Batch = {
	source: "draft:om_src",
	query: "下周三能上线吗",
	person: { id: "ou_wang", name: "王五" },
	chat: { id: "oc_1", name: "群「研发」" },
	materials: [
		{ n: 1, role: "other", label: "王五的消息", text: "这个需求下周三能上线吗", ref: "om_src", at: 1 },
		{ n: 2, role: "draft", label: "助理的草稿", text: "可以，周三上线", ref: "om_d1", at: 2 },
		{ n: 3, role: "yi", label: "Yi 的改稿意见", text: "以后别替我直接承诺上线时间，说评估一下", ref: "revise:om_d1", at: 3 },
		{ n: 4, role: "tool", label: "工具 bash(git log)", text: "commit abc 修复 authorize 超时", ref: "s@4", at: 4 },
	],
};

test("校验：约定要有 Yi 原话里的 basis，否则降为线索；没引 Yi 的话不算 Yi 原话", () => {
	const ok = extract.validate(
		{
			content: "被问上线时间时不直接承诺，说评估一下",
			kind: "preference",
			said_by: "user_statement",
			application: "convention",
			applies_when: "有人问上线时间时",
			basis: "以后别替我直接承诺上线时间",
			scope: "personal",
			evidence: [3],
		},
		batch,
		[],
	);
	assert.ok(typeof ok !== "string" && ok.application === "convention" && ok.provenance === "user_statement");
	const forged = extract.validate(
		{
			content: "被问上线时间时不直接承诺",
			kind: "preference",
			said_by: "user_statement",
			application: "convention",
			applies_when: "有人问上线时间时",
			basis: "永远不要承诺",
			evidence: [3],
		},
		batch,
		[],
	);
	assert.ok(typeof forged !== "string" && forged.application === "reference");
	const noYi = extract.validate(
		{ content: "王五经常问上线时间", kind: "fact", said_by: "user_statement", evidence: [1], scope: "person" },
		batch,
		[],
	);
	assert.ok(typeof noYi !== "string" && noYi.provenance === "model_inference" && noYi.scope === "person:ou_wang");
	assert.equal(extract.validate({ content: "x", kind: "fact", evidence: [99] }, batch, []), "没有引用存在的材料");
});

test("关系：same 补证据并让候选晋升；推断不能改动已有条目；约定取代未确认的约定", async () => {
	const cand = db().transaction((tx) =>
		store.insertMemory(tx, {
			content: "authorize 超时和网关配置有关",
			kind: "experience",
			application: "reference",
			provenance: "model_inference",
			state: "candidate",
			evidence: [],
			source: "test",
		}),
	);
	const v = (raw: object) => {
		const o = extract.validate(raw as any, batch, [cand]);
		assert.ok(typeof o !== "string");
		return o;
	};
	extract.applyObservations(
		[
			v({
				content: "authorize 超时修过一次",
				kind: "experience",
				said_by: "tool_observation",
				evidence: [4],
				relation: { type: "same", target: "M1" },
			}),
		],
		"t",
	);
	const promoted = store.getMemory(cand.id)!;
	assert.equal(promoted.state, "active");
	assert.equal(promoted.evidence.length, 1);

	const yiConv = store.rememberFromYi(
		"排期问题先说评估",
		{ kind: "preference", application: "convention", appliesWhen: "被问排期时" },
		yi("以后排期先说评估"),
		"test",
		false,
	);
	const inferred = extract.validate(
		{
			content: "Yi 其实愿意承诺排期",
			kind: "preference",
			said_by: "model_inference",
			evidence: [2],
			relation: { type: "contradicts", target: "M1" },
		},
		batch,
		[yiConv],
	);
	assert.ok(typeof inferred !== "string");
	extract.applyObservations([inferred], "t");
	assert.equal(store.getMemory(yiConv.id)!.state, "active");

	const newer = extract.validate(
		{
			content: "被问排期时直接给评估后的日期",
			kind: "preference",
			said_by: "user_statement",
			application: "convention",
			applies_when: "被问排期时",
			basis: "说评估一下",
			evidence: [3],
			relation: { type: "supersedes", target: "M1" },
		},
		batch,
		[yiConv],
	);
	assert.ok(typeof newer !== "string" && newer.application === "convention");
	extract.applyObservations([newer], "t");
	assert.equal(store.getMemory(yiConv.id)!.state, "superseded");
});

test("挑战已确认的约定：双方转为有争议，Yi 确认一条后另一条被取代", () => {
	const old = store.rememberFromYi(
		"周报用中文写",
		{ kind: "preference", application: "convention", appliesWhen: "写周报时" },
		yi("以后周报用中文"),
		"test",
		true,
	);
	const o = extract.validate(
		{
			content: "周报用英文写",
			kind: "preference",
			said_by: "user_statement",
			application: "convention",
			applies_when: "写周报时",
			basis: "以后别替我直接承诺上线时间",
			evidence: [3],
			relation: { type: "supersedes", target: "M1" },
		},
		batch,
		[old],
	);
	assert.ok(typeof o !== "string");
	extract.applyObservations([o], "t");
	assert.equal(store.getMemory(old.id)!.state, "contested");
	const challenger = store.listMemories(["contested"]).find((m) => m.id !== old.id)!;
	store.confirmMemory(challenger.id, challenger.revision);
	assert.equal(store.getMemory(old.id)!.state, "superseded");
	assert.equal(store.getMemory(challenger.id)!.state, "active");
});

test("「记住」：模型只分类；basis 不在原话里就记成线索", async () => {
	faux.setResponses([
		fauxAssistantMessage('{"kind":"preference","application":"convention","applies_when":"写周报时","basis":"以后周报"}'),
		fauxAssistantMessage('{"kind":"preference","application":"convention","applies_when":"写周报时","basis":"每次都要"}'),
	]);
	assert.equal((await classifyStatement("以后周报发给我之前先过一遍")).application, "convention");
	assert.equal((await classifyStatement("周报发给我之前先过一遍")).application, "reference");
});

test("草稿走完：拼出改稿过程交给模型，结果按校验落库", async () => {
	const t = Date.now() / 1000;
	const base = {
		chatId: "oc_9",
		chatMode: "group",
		chatName: "研发",
		replyTo: "om_q",
		senderId: "ou_wang",
		senderName: "王五",
		text: "周三能上线吗",
	};
	db()
		.insert(schema.drafts)
		.values([
			{ ...base, id: "om_d1", draft: "可以，周三上", status: "replaced", created: t },
			{ ...base, id: "om_d2", draft: "我评估一下再回你", status: "sent", created: t + 1 },
		])
		.run();
	db()
		.insert(schema.records)
		.values([
			{ ts: t + 0.5, kind: "draft", status: "revised", dm: "om_d1", source: "om_q", question: "以后别替我直接承诺上线时间" },
			{ ts: t + 2, kind: "draft", status: "sent", dm: "om_d2", source: "om_q", answer: "我评估一下再回你" },
		])
		.run();
	let prompt = "";
	faux.setResponses([
		(ctx) => {
			prompt = JSON.stringify(ctx.messages);
			return fauxAssistantMessage(
				JSON.stringify({
					observations: [
						{
							content: "被问上线时间时不直接承诺，先说评估",
							kind: "preference",
							said_by: "user_statement",
							application: "convention",
							applies_when: "有人问上线时间时",
							basis: "以后别替我直接承诺上线时间",
							scope: "personal",
							evidence: [3],
							relation: { type: "new" },
						},
						{ content: "token=sk-abcdefghijklmnopqrstuvwxyz", kind: "fact", said_by: "user_statement", evidence: [3] },
					],
				}),
			);
		},
	]);
	extract.enqueueMemory({ type: "draft", replyTo: "om_q", outcome: "sent" });
	await extract.memoryIdle();
	assert.match(prompt, /Yi 的改稿意见/);
	assert.match(prompt, /Yi 原样发出了最后一版草稿/);
	const got = store.listMemories(["active"]).find((m) => m.content.startsWith("被问上线时间时不直接承诺"));
	assert.ok(got);
	assert.equal(got.application, "convention");
	assert.equal(got.source, "draft:om_q");
	assert.ok(!store.listMemories().some((m) => m.content.includes("sk-")));
	assert.deepEqual(
		db()
			.select()
			.from(schema.kv)
			.all()
			.filter((r) => r.key.startsWith("pending:memory:")),
		[],
	);
});

test("原样发出、没有工具结果的草稿学不到东西，不调模型", async () => {
	const t = Date.now() / 1000;
	db()
		.insert(schema.drafts)
		.values({
			id: "om_e1",
			chatId: "oc_9",
			chatMode: "p2p",
			replyTo: "om_e",
			senderId: "ou_a",
			text: "收到",
			draft: "👍",
			status: "sent",
			created: t,
		})
		.run();
	const calls = faux.state.callCount;
	extract.enqueueMemory({ type: "draft", replyTo: "om_e", outcome: "sent" });
	await extract.memoryIdle();
	assert.equal(faux.state.callCount, calls);
	assert.ok(embedCalls > 0);
});

test("裁定冲突：合并成 Yi 写定的文字，依据合并，另一条转为已取代", () => {
	const a = store.rememberFromYi("站会纪要发群里", { kind: "preference", application: "reference", appliesWhen: "" }, yi("站会纪要发群里"), "test", true);
	const b = store.rememberFromYi("站会纪要私发给我", { kind: "preference", application: "reference", appliesWhen: "" }, yi("站会纪要私发给我"), "test", true);
	// 造一对互相冲突的
	const set = (id: number, other: number) => {
		const m = store.getMemory(id)!;
		db().transaction((tx) => store.updateMemory(tx, id, { state: "contested", conflicts: [other] }));
		return m;
	};
	set(a.id, b.id);
	set(b.id, a.id);
	const ra = store.getMemory(a.id)!;
	const rb = store.getMemory(b.id)!;
	assert.throws(() => store.resolveMemories(a.id, [{ id: a.id, revision: ra.revision - 1 }, { id: b.id, revision: rb.revision }], "x"));
	const r = store.resolveMemories(a.id, [ra, rb], "站会纪要发群里，同时私发给我一份");
	assert.equal(r.state, "active");
	assert.equal(r.content, "站会纪要发群里，同时私发给我一份");
	assert.equal(r.confirmed, true);
	assert.deepEqual(r.conflicts, []);
	assert.ok(r.evidence.some((e) => e.quote === "站会纪要私发给我"));
	const after = store.getMemory(b.id)!;
	assert.equal(after.state, "superseded");
	assert.equal(after.supersededBy, a.id);
	// 改文字：算 Yi 的原话
	const e = store.editMemory(r.id, r.revision, "站会纪要发群里，并私发给我");
	assert.equal(e.content, "站会纪要发群里，并私发给我");
	assert.equal(e.revision, r.revision + 1);
});
