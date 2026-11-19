// 把 cabinet.db 里的旧记忆迁到 Hindsight（一次性）。
// 用法：pnpm migrate-memory          预演，只打印要迁什么
//       pnpm migrate-memory --apply  真的写
// - 只迁生效的（active）：约定 → Hindsight directive；偏好、事实与经验 → Hindsight retain，
//   document_id = memory:<id>，重跑整篇替换不重复
// - 候选（模型推断，从没生效过）、已取代、已遗忘的不迁
// - 旧的三张表不动，回滚时代码切回去就能接着用
import { eq } from "drizzle-orm";
import { db, schema } from "../server/db/index.ts";
import { ensureBank, retain, type RetainItem } from "../server/memory/hindsight.ts";
import { addConvention, redact } from "../server/memory/store.ts";

const apply = process.argv.includes("--apply");
const rows = db().select().from(schema.memories).where(eq(schema.memories.state, "active")).all();
const skipped = db().select().from(schema.memories).all().length - rows.length;

const PROVENANCE: Record<string, string> = { user_statement: "Yi 原话", tool_observation: "工具结果证实", model_inference: "模型推断" };
const conventions = rows.filter((m) => m.application === "convention");
const facts = rows.filter((m) => !conventions.includes(m));

const items: RetainItem[] = facts.map((m) => ({
	content: redact(m.content),
	context: `cabinet 旧记忆 #${m.id}：${{ fact: "事实", experience: "经验", preference: "偏好" }[m.kind]}，来源 ${PROVENANCE[m.provenance]}${m.confirmed ? "，Yi 确认过" : ""}`,
	documentId: `memory:${m.id}`,
	at: m.updated,
	// 限定了人或会话的只打那一个 tag：召回时 personal 处处都在
	tags: [m.scope],
	metadata: { source: m.source, legacyId: String(m.id) },
}));

console.log(`生效 ${rows.length} 条（另有 ${skipped} 条候选 / 已取代 / 已遗忘不迁）`);
console.log(`- 约定 → Hindsight directive：${conventions.length}`);
console.log(
	`- 偏好、事实与经验 → Hindsight：${facts.length}（限定作用域的 ${facts.filter((m) => m.scope !== "personal").length} 条只打那一个 tag）`,
);
if (!apply) {
	console.log("\n预演结束，加 --apply 真的写。");
	process.exit(0);
}

await ensureBank();
for (const m of conventions) await addConvention(m.content, m.appliesWhen, m.scope, m.scopeName);
for (let i = 0; i < items.length; i += 20) {
	await retain(items.slice(i, i + 20));
	console.log(`Hindsight 已提交 ${Math.min(i + 20, items.length)}/${items.length}`);
}
console.log("完成。Hindsight 的抽取在后台跑，进度看它的 operations。");
