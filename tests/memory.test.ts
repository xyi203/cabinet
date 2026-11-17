// 长期记忆：召回三路（约定 / Hindsight / OpenViking）与降级、草稿走完后的沉淀、「记住」按分类的去处、凭证闸
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";

// 假的 Hindsight + OpenViking：按路径回固定结果，记下每次请求
interface Req {
	method: string;
	path: string;
	body: any;
}
const reqs: Req[] = [];
let directives: any[] = [];
let hindsightDown = false;
const server = createServer((req, res) => {
	let raw = "";
	req.on("data", (c) => (raw += c));
	req.on("end", () => {
		const p = req.url ?? "";
		const body = raw ? JSON.parse(raw) : undefined;
		reqs.push({ method: req.method ?? "", path: p, body });
		const json = (x: unknown, status = 200) => {
			res.writeHead(status, { "content-type": "application/json" });
			res.end(JSON.stringify(x));
		};
		if (p.startsWith("/v1/") && hindsightDown) return json({ detail: "down" }, 503);
		if (p.endsWith("/directives?limit=500")) return json({ items: directives });
		if (p.endsWith("/directives") && req.method === "POST") {
			const d = { id: `d${directives.length + 1}`, ...body };
			directives.push(d);
			return json(d);
		}
		if (p.endsWith("/memories/recall"))
			return json({
				results: [
					{
						id: "f1",
						text: "查 cart 内部接口用 GET /api/internal/cart",
						type: "world",
						tags: ["personal"],
						mentioned_at: "2026-11-01T00:00:00Z",
					},
				],
			});
		if (p.startsWith("/v1/")) return json({ success: true });
		if (p === "/api/v1/search/find")
			return json({
				status: "ok",
				result: {
					memories: body.target_uri.endsWith("/preferences/")
						? [
								{ uri: "viking://user/default/memories/preferences/yi/沟通.md", level: 2, score: 0.8, abstract: "先结论后依据" },
								{ uri: "viking://user/default/memories/preferences/yi/.overview.md", level: 1, score: 0.7, abstract: "目录" },
							]
						: [],
				},
			});
		if (p.startsWith("/api/v1/fs/tree"))
			return p.includes("preferences")
				? json({
						status: "ok",
						result: [
							{ uri: "viking://u/preferences/yi", isDir: true, rel_path: "yi" },
							{ uri: "viking://u/preferences/yi/沟通.md", isDir: false, rel_path: "yi/沟通.md", modTime: "2026-11-17T00:00:00Z" },
							{ uri: "viking://u/preferences/yi/.overview.md", isDir: false, rel_path: "yi/.overview.md" },
						],
					})
				: json({ status: "error", error: { code: "NOT_FOUND" } }, 404);
		if (p.startsWith("/api/v1/content/read")) return json({ status: "ok", result: "- 先结论后依据" });
		if (p.startsWith("/api/v1/sessions") && req.method === "DELETE") return json({ status: "error" }, 404);
		return json({ status: "ok", result: {} });
	});
}).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
server.unref();
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "cabinet-memory-"));
process.env.HINDSIGHT_URL = url;
process.env.OPENVIKING_URL = url;
process.env.MEMORY_MODEL = "faux-1";
process.env.PI_FALLBACK_MODEL = "";

const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
const models = createModels();
models.setProvider(faux.provider);
(await import("../server/agent/models.ts")).useModels(models);
const { openDb, useDb, db, schema } = await import("../server/db/index.ts");
useDb(openDb(":memory:"));
const store = await import("../server/memory/store.ts");
const { recall, render, recallBlock } = await import("../server/memory/recall.ts");
const extract = await import("../server/memory/extract.ts");
const { classifyStatement, rememberFromYi } = await import("../server/memory/remember.ts");
const { memoryDown } = await import("../server/memory/health.ts");
const { listNotes } = await import("../server/memory/viking.ts");

const take = () => reqs.splice(0);
const pref = { kind: "preference" as const, application: "reference" as const, appliesWhen: "" };

test("召回：约定按作用域与预算挑、线索按作用域 tag 过滤、OpenViking 只查偏好与人物的叶子文件", async () => {
	directives = [
		{ id: "d1", name: "有人问上线时间时", content: "先说评估，不直接承诺", tags: ["personal"], is_active: true },
		{ id: "d2", name: "回王五时", content: "用英文", tags: ["person:ou_wang", "name:王五"], is_active: true },
		{ id: "d3", name: "停用的", content: "x", tags: ["personal"], is_active: false },
	];
	take();
	const r = await recall("周三能上线吗", { personId: "ou_zhang", chatId: "oc_1" });
	assert.deepEqual(
		r.conventions.map((c) => c.id),
		["d1"],
	);
	const hs = take().find((x) => x.path.endsWith("/memories/recall"))!;
	assert.deepEqual(hs.body.tags, ["personal", "person:ou_zhang", "chat:oc_1"]);
	assert.equal(hs.body.tags_match, "any_strict");
	assert.deepEqual(
		r.notes.map((n) => n.text),
		["先结论后依据"],
	);
	const block = render(r);
	assert.match(block, /先说评估，不直接承诺〔适用：有人问上线时间时〕/);
	assert.match(block, /先结论后依据〔偏好〕/);
	assert.match(block, /GET \/api\/internal\/cart〔事实 · 2026-11-01〕/);
	// 和王五说话时带上只对他的约定，显示名来自 name: tag
	const w = await recall("x", { personId: "ou_wang" });
	assert.match(render(w), /用英文〔适用：回王五时 · 限 王五〕/);
});

test("召回：Hindsight 挂了只跳过它那两路，OpenViking 照带；Watchdog 能看到", async () => {
	hindsightDown = true;
	try {
		const r = await recall("x", {});
		assert.equal(r.conventions.length, 0);
		assert.equal(r.facts.length, 0);
		assert.equal(r.notes.length, 1);
		assert.equal(r.degraded.length, 2);
		assert.match(await recallBlock("x", {}), /先结论后依据/);
		assert.ok(memoryDown().some((d) => d.service === "hindsight"));
	} finally {
		hindsightDown = false;
	}
	await recall("x", {});
	assert.ok(!memoryDown().some((d) => d.service === "hindsight"));
});

test("草稿走完：整批进 Hindsight（来源当 document_id），只有 Yi 的话进 OpenViking，凭证打码", async () => {
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
			{
				ts: t + 0.5,
				kind: "draft",
				status: "revised",
				dm: "om_d1",
				source: "om_q",
				question: "以后别替我直接承诺上线时间 token=sk-abcdefghijklmnopqrstuvwxyz",
			},
			{ ts: t + 2, kind: "draft", status: "sent", dm: "om_d2", source: "om_q", answer: "我评估一下再回你" },
		])
		.run();
	take();
	extract.enqueueMemory({ type: "draft", replyTo: "om_q", outcome: "sent" });
	await extract.memoryIdle();
	const sent = take();
	const retain = sent.find((x) => x.path.endsWith("/memories"))!;
	const item = retain.body.items[0];
	assert.equal(item.document_id, "draft:om_q");
	assert.deepEqual(item.tags, ["personal", "person:ou_wang", "chat:oc_9"]);
	assert.match(item.content, /Yi 的改稿意见/);
	assert.match(item.content, /Yi 原样发出了最后一版草稿/);
	assert.doesNotMatch(item.content, /sk-/);
	const batch = sent.find((x) => x.path.endsWith("/messages/batch"))!;
	assert.match(batch.path, /cabinet-draft-om_q/);
	const texts = batch.body.messages.map((m: any) => m.content).join("\n");
	assert.match(texts, /以后别替我直接承诺上线时间/);
	assert.doesNotMatch(texts, /周三能上线吗/);
	assert.ok(sent.some((x) => x.path.endsWith("/commit")));
	assert.deepEqual(
		db()
			.select()
			.from(schema.kv)
			.all()
			.filter((r) => r.key.startsWith("pending:memory:") || r.key.startsWith("memory-attempt:")),
		[],
	);
});

test("原样发出、没有工具结果的草稿学不到东西，不往外写", async () => {
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
			created: Date.now() / 1000,
		})
		.run();
	take();
	extract.enqueueMemory({ type: "draft", replyTo: "om_e", outcome: "sent" });
	await extract.memoryIdle();
	assert.deepEqual(take(), []);
});

test("沉淀失败：任务留在 kv 里记一次失败，等重试", async () => {
	hindsightDown = true;
	try {
		extract.enqueueMemory({ type: "draft", replyTo: "om_q", outcome: "sent" });
		await extract.memoryIdle();
		const kv = db().select().from(schema.kv).all();
		assert.ok(kv.some((r) => r.key === "pending:memory:draft:om_q"));
		assert.ok(kv.some((r) => r.key === "memory-attempt:pending:memory:draft:om_q"));
	} finally {
		hindsightDown = false;
	}
});

test("「记住」：模型只分类；basis 不在原话里就记成线索", async () => {
	faux.setResponses([
		fauxAssistantMessage('{"kind":"preference","application":"convention","applies_when":"写周报时","basis":"以后周报"}'),
		fauxAssistantMessage('{"kind":"preference","application":"convention","applies_when":"写周报时","basis":"每次都要"}'),
	]);
	assert.equal((await classifyStatement("以后周报发给我之前先过一遍")).application, "convention");
	assert.equal((await classifyStatement("周报发给我之前先过一遍")).application, "reference");
});

test("「记住」按分类写去不同地方", async () => {
	directives = [];
	take();
	const c = await rememberFromYi(
		"周报发给我之前先过一遍",
		{ kind: "preference", application: "convention", appliesWhen: "写周报时" },
		"remember:om_1",
	);
	assert.equal(c.where, "convention");
	assert.deepEqual(take().find((x) => x.method === "POST" && x.path.endsWith("/directives"))?.body.tags, ["personal"]);
	// 同一句话、同一条件不重复建
	await rememberFromYi(
		"周报发给我之前先过一遍",
		{ kind: "preference", application: "convention", appliesWhen: "写周报时" },
		"remember:om_1b",
	);
	assert.equal(directives.length, 1);

	const p = await rememberFromYi("回消息先结论后依据", pref, "remember:om_2");
	assert.equal(p.where, "openviking");
	assert.ok(take().some((x) => x.path === "/api/v1/sessions/cabinet-remember-om_2/commit"));

	const f = await rememberFromYi(
		"王五负责 cart 发版",
		{ kind: "fact", application: "reference", appliesWhen: "", scope: "person:ou_wang", scopeName: "王五" },
		"remember:om_3",
	);
	assert.equal(f.where, "hindsight");
	const r = take().find((x) => x.path.endsWith("/memories"))!;
	assert.equal(r.body.async, false);
	assert.deepEqual(r.body.items[0].tags, ["person:ou_wang"]);
});

test("凭证、空话、约定没写条件都拦在外面，不往外写", async () => {
	take();
	await assert.rejects(() => rememberFromYi("token=sk-abcdefghijklmnopqrstuvwxyz", pref, "x"), store.MemoryError);
	await assert.rejects(() => rememberFromYi("   ", pref, "x"), store.MemoryError);
	await assert.rejects(
		() => rememberFromYi("回复要短", { kind: "fact", application: "convention", appliesWhen: "总是" }, "x"),
		store.MemoryError,
	);
	await assert.rejects(() => store.editConvention("d1", { appliesWhen: " " }), store.MemoryError);
	assert.deepEqual(take(), []);
	assert.equal(store.redact("key: glpat-abcdefghijklmnopqrst 完"), "key: 〔已打码〕 完");
});

test("看板列偏好文件：目录不存在（404）当成空的，也不算 OpenViking 挂了", async () => {
	const notes = await listNotes();
	assert.deepEqual(
		notes.map((n) => [n.type, n.path, n.text]),
		[["preferences", "yi/沟通.md", "- 先结论后依据"]],
	);
	assert.ok(!memoryDown().some((d) => d.service === "openviking"));
});
