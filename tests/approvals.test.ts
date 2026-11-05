import assert from "node:assert/strict";
import { test } from "node:test";
const { openDb, useDb, db, schema } = await import("../server/db/index.ts");
useDb(openDb(":memory:"));
const {
	createApproval,
	decideApproval,
	getApproval,
	pendingApprovals,
	expireApprovals,
	approvalCard,
	nextRuns,
	ApprovalError,
	APPROVAL_TTL,
} = await import("../server/approvals.ts");
const { listSchedules } = await import("../server/schedules.ts");
const { pickScope } = await import("../server/memory/remember.ts");
const { Guard } = await import("../server/agent/guard.ts");
const { eq } = await import("drizzle-orm");

const idOf = (msg: string) => /apv-\w+/.exec(msg)![0];
const req = (over: Record<string, unknown> = {}) => ({
	tool: "bash",
	args: { command: "glab mr note 1 -m ok" },
	reason: "glab mr note 是写操作",
	convId: 999,
	cwd: "/tmp",
	origin: { label: "张三在群「x」@你的消息" },
	...over,
});
const settled = async (id: string) => {
	for (let i = 0; i < 50 && getApproval(id)!.status === "running"; i++) await new Promise((r) => setTimeout(r, 10));
	return getApproval(id)!;
};

test("建审批：记一条待审批，拦截说明里带编号；同一条只能处理一次", async () => {
	const msg = createApproval(req());
	const id = idOf(msg);
	assert.match(msg, /已提交审批 apv-\w+.*不要换个写法重试/);
	const a = getApproval(id)!;
	assert.deepEqual([a.status, a.tool, a.origin], ["pending", "bash", "张三在群「x」@你的消息"]);
	assert.ok(pendingApprovals().some((x) => x.id === id));
	const r = await decideApproval(id, "reject", "先别发");
	assert.deepEqual([r.status, r.result], ["rejected", "先别发"]);
	await assert.rejects(decideApproval(id, "approve"), ApprovalError);
});

test("批准后执行前按会话策略复核：找不到会话权限就不执行，标成出错", async () => {
	const id = idOf(createApproval(req({ convId: 12345 })));
	await decideApproval(id, "approve");
	const a = await settled(id);
	assert.equal(a.status, "failed");
	assert.match(a.result ?? "", /找不到发起这次调用的会话权限/);
});

test("定时任务：参数不对直接拒绝不建审批；批准后建出来", async () => {
	const before = pendingApprovals().length;
	assert.match(createApproval(req({ tool: "schedule", args: { name: "x", cron: "bad", prompt: "y" } })), /cron 写得不对/);
	assert.match(createApproval(req({ tool: "schedule", args: { name: "", cron: "0 9 * * *", prompt: "" } })), /名字/);
	assert.equal(pendingApprovals().length, before);
	const id = idOf(
		createApproval(
			req({ tool: "schedule", args: { name: "告警回顾", cron: "0 9 * * 1-5", prompt: "看看昨晚的告警" }, reason: "新建定时任务" }),
		),
	);
	const card = JSON.stringify(approvalCard(getApproval(id)!));
	assert.match(card, /新建定时任务「告警回顾」/);
	assert.match(card, /接下来/);
	await decideApproval(id, "approve");
	const a = await settled(id);
	assert.equal(a.status, "done", a.result ?? "");
	const s = listSchedules().find((x) => x.name === "告警回顾")!;
	assert.deepEqual([s.cron, s.agent, s.prompt], ["0 9 * * 1-5", "assistant", "看看昨晚的告警"]);
});

test("超过 24 小时没处理的过期，过期后不能执行", async () => {
	const id = idOf(createApproval(req()));
	db()
		.update(schema.approvals)
		.set({ created: Date.now() / 1000 - APPROVAL_TTL - 10 })
		.where(eq(schema.approvals.id, id))
		.run();
	await assert.rejects(decideApproval(id, "approve"), /过期/);
	assert.equal(getApproval(id)!.status, "expired");
	const id2 = idOf(createApproval(req()));
	db()
		.update(schema.approvals)
		.set({ created: Date.now() / 1000 - APPROVAL_TTL - 10 })
		.where(eq(schema.approvals.id, id2))
		.run();
	assert.equal(expireApprovals(), 1);
	assert.equal(getApproval(id2)!.status, "expired");
});

test("审批卡片：元素 name 不重复，处理后不再有按钮", () => {
	const id = idOf(createApproval(req()));
	const names: string[] = [];
	const walk = (x: any): void => {
		if (Array.isArray(x)) return x.forEach(walk);
		if (x && typeof x === "object") {
			if (typeof x.name === "string") names.push(x.name);
			Object.values(x).forEach(walk);
		}
	};
	walk(approvalCard(getApproval(id)!));
	assert.equal(new Set(names).size, names.length, names.join(","));
	assert.ok(names.includes("apv_ok") && names.includes("apv_no"));
	assert.doesNotMatch(JSON.stringify(approvalCard({ ...getApproval(id)!, status: "done", result: "ok" })), /apv_ok/);
});

test("接下来几次运行时间按 cron 往后排", () => {
	const from = new Date("2026-11-06T10:00:00").getTime() / 1000; // 周五
	const runs = nextRuns("0 9 * * 1-5", 3, from).map((t) => new Date(t * 1000).toLocaleString("sv-SE").slice(0, 16));
	assert.deepEqual(runs, ["2026-11-09 09:00", "2026-11-10 09:00", "2026-11-11 09:00"]);
});

test("定时任务工具一律要审批", () => {
	const g = new Guard({ roots: [], bash: [], skillsDir: "/x" });
	assert.equal(g.verdict("schedule", { name: "a", cron: "0 9 * * *", prompt: "b" }, "/").kind, "approve");
});

test("记住的作用域：只能落在给的候选上，拿不准就 personal", () => {
	const c = { person: { id: "ou_a", name: "张三" }, chat: { id: "oc_1", name: "订单群" } };
	assert.deepEqual(pickScope("person", c), { scope: "person:ou_a", scopeName: "张三" });
	assert.deepEqual(pickScope("chat", c), { scope: "chat:oc_1", scopeName: "订单群" });
	assert.deepEqual(pickScope("person", {}), { scope: "personal", scopeName: "" });
	assert.deepEqual(pickScope("chat:oc_evil", c), { scope: "personal", scopeName: "" });
	assert.deepEqual(pickScope(undefined, c), { scope: "personal", scopeName: "" });
});

test("执行出错时带上完整输出，不截在前 300 字", async () => {
	const { run } = await import("../server/approvals.ts");
	const long = "x".repeat(500);
	await assert.rejects(run("sh", ["-c", `echo ${long}; echo 真正的报错 >&2; exit 3`], "/tmp"), (e: Error) => {
		assert.match(e.message, /退出码 3/);
		assert.match(e.message, /真正的报错/);
		return true;
	});
	assert.equal(await run("sh", ["-c", "echo ok"], "/tmp"), "ok");
});

test("devops 两段式工具：预览放行，真正提交才审批", async () => {
	const { mcpPreview } = await import("../server/agent/guard.ts");
	const name = "mcp__devops-mcp-prod__issue_create";
	mcpPreview.add(name);
	const g = new Guard({ roots: [], bash: [], skillsDir: "/x", mcp: ["devops-mcp-prod"] });
	assert.equal(g.verdict(name, { confirmed: false }, "/").kind, "allow");
	assert.equal(g.verdict(name, {}, "/").kind, "allow");
	assert.equal(g.verdict(name, { confirmed: true }, "/").kind, "approve");
	assert.equal(g.verdict("mcp__devops-mcp-prod__apollo_restart_service", { confirmed: false }, "/").kind, "approve");
});

