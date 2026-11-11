import assert from "node:assert/strict";
import { test } from "node:test";
const { openDb, useDb } = await import("../server/db/index.ts");
useDb(openDb(":memory:"));
const { buildSurface, clearPendingUi, takePendingUi } = await import("../server/a2ui/surface.ts");
const { showUiTool } = await import("../server/agent/tools.ts");
const { Guard } = await import("../server/agent/guard.ts");
const { formatZodIssue } = await import("@a2ui/web_core");

const report = [
	{ id: "root", component: "Stack", children: ["v", "d", "m", "basis"] },
	{ id: "v", component: "Verdict", level: "watch", title: "AB 没覆盖到改动", detail: "154 家店都没配 **cart_transform** 点位" },
	{
		id: "d",
		component: "Decision",
		title: "要不要把 2452654 拉进 AB？",
		options: [{ label: "拉进去", action: { event: { name: "reply", context: { text: "把 2452654 拉进 AB" } } } }],
	},
	{ id: "m", component: "Metrics", items: [{ label: "b 组 5xx", value: "0", base: "a 组 0" }] },
	{ id: "basis", component: "Section", title: "依据", collapsed: true, children: ["t"] },
	{ id: "t", component: "Table", columns: ["集群", "P95"], rows: [["saas", "980 ms"]] },
];

test("show_ui：合法报告包成 v1.0 的 createSurface + updateComponents", () => {
	const r = buildSurface(report);
	assert.ok("messages" in r, "error" in r ? r.error : "");
	assert.equal(r.messages.length, 2);
	assert.deepEqual(Object.keys(r.messages[0] as object).toSorted(), ["createSurface", "version"]);
	assert.equal((r.messages[1] as any).updateComponents.components, report);
});

const bad = (components: unknown) => {
	const r = buildSurface(components);
	assert.ok("error" in r, "应该校验失败");
	return r.error;
};

test("show_ui：结构不对、属性不对都给出模型能看懂的原因（zod 4 下不抛 TypeError）", () => {
	assert.match(bad([]), /非空数组/);
	assert.match(bad([{ id: "v", component: "Verdict", level: "ok", title: "x" }]), /root 的 Stack/);
	assert.match(bad([{ id: "root", component: "Stack", children: ["nope"] }]), /不存在的组件：nope/);
	assert.match(
		bad([
			{ id: "root", component: "Stack", children: [] },
			{ id: "root", component: "Stack", children: [] },
		]),
		/id 重复/,
	);
	// 枚举值和类型错：web_core 的校验在 zod 4 下要能格式化（上游 a2ui#3825 的补丁）
	const e = bad([
		{ id: "root", component: "Stack", children: ["v"] },
		{ id: "v", component: "Verdict", level: "nope", title: "x" },
	]);
	assert.match(e, /Verdict/);
	assert.match(e, /level/);
	// v1.0 的组件 id 要是合法标识符，连字符不行（工具说明里写了）
	assert.match(
		bad([
			{ id: "root", component: "Stack", children: ["a-b"] },
			{ id: "a-b", component: "Markdown", text: "x" },
		]),
		/UAX #31/,
	);
	assert.match(
		bad([
			{ id: "root", component: "Stack", children: ["x"] },
			{ id: "x", component: "Chart" },
		]),
		/Chart/,
	);
});

test("zod 4 的 invalid_union（errors 是二维数组）能展开格式化", () => {
	const msg = formatZodIssue({
		code: "invalid_union",
		path: ["action"],
		message: "Invalid input",
		errors: [
			[{ code: "invalid_type", expected: "string", path: ["action", "name"], message: "Invalid input: expected string, received number" }],
		],
	} as any);
	assert.match(msg, /action\.name: Invalid input: expected string, received number/);
});

// 工具只用到 conversationId；第三个参数是 durable 的执行上下文，这里用不上
const run = (components: unknown[]) => showUiTool.execute({ components }, { conversationId: 42 } as any, undefined as any);
const ok = await run(report);

test("show_ui 工具：通过的报告暂存到这次运行结束，新提交开始时清掉；不通过返回错误给模型", async () => {
	assert.ok(!(ok as any).isError);
	const ui = takePendingUi("42", 100);
	assert.equal(ui?.at, 100);
	assert.equal(ui?.messages.length, 2);
	assert.equal(takePendingUi("42", 101), null, "取走后就没了");

	await run(report);
	clearPendingUi("42");
	assert.equal(takePendingUi("42", 102), null);

	const failed = await run([{ id: "root", component: "Nope" }]);
	assert.equal((failed as any).isError, true);
	assert.equal(takePendingUi("42", 103), null, "校验失败不暂存");
});

test("守卫放行 show_ui：只在看板上显示，不碰外部", () => {
	const g = new Guard({ roots: ["/tmp"], bash: [], skillsDir: "/tmp" });
	assert.equal(g.verdict("show_ui", { components: [] }, "/tmp").kind, "allow");
});
