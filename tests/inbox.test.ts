import assert from "node:assert/strict";
import { test } from "node:test";
const { openDb, useDb } = await import("../server/db/index.ts");
useDb(openDb(":memory:"));
const { buildInbox } = await import("../server/tasks.ts");

const draft = (id: string, status: string, created: number) =>
	({ id, status, created, text: id, chatMode: "p2p", chatName: "", senderName: "张三" }) as any;

test("待你处理：有人在等的排最前，建议不回和有冲突的记忆放最后", () => {
	const items = buildInbox(
		[draft("d1", "pending", 10), draft("d2", "noreply", 20), draft("d3", "sent", 30)],
		[{ id: "fail-x", type: "draft", status: "blocked", title: "x", label: "张三", created: 5, error: "超时" } as any],
		[
			{ id: "dev-1", agent: "alert", status: "review", title: "告警 · 订单群 · 3 条", updated: 1 } as any,
			{ id: "dev-2", agent: "dev", status: "review", title: "加筛选", updated: 40 } as any,
			{ id: "dev-3", agent: "dev", status: "done", title: "旧的", updated: 50 } as any,
		],
		[{ id: 7, content: "回张三用英文", kind: "preference", updated: 3 } as any],
	);
	assert.deepEqual(
		items.map((i) => [i.level, i.kind, i.ref]),
		[
			["now", "draft", "d1"],
			["now", "failure", "fail-x"],
			["now", "dev", "dev-1"],
			["soon", "dev", "dev-2"],
			["later", "draft", "d2"],
			["later", "memory", "7"],
		],
	);
	assert.equal(items.find((i) => i.ref === "dev-1")!.why, "告警结论待看");
});
