// 记忆的存取与生命周期（komo docs/memory.md §9.2 / §9.5 / §9.6 的精简版）：
// - 状态 candidate → active → contested / superseded / forgotten；遗忘保留原行当排除标记，同一句话不会被重新提取回来
// - 改正文、用法、条件或作用域升 revision，关键词与向量索引跟着重建；向量在事务外算，入库前核对 revision 没变
// - Yi 亲口说的（「记住」、看板手写）记成 active + user_statement；Yi 在看板上确认过才算 confirmed
import { and, eq, inArray, sql } from "drizzle-orm";
import { MEMORY } from "../config.ts";
import { db, schema } from "../db/index.ts";
import type { Evidence, MemoryRow } from "../db/schema.ts";
import { changed } from "../bus.ts";
import { log, now } from "../util.ts";
import { termsField } from "./terms.ts";

export type Memory = MemoryRow;
export type Kind = "preference" | "fact" | "experience";
export type Application = "convention" | "reference";
export type Provenance = "user_statement" | "tool_observation" | "model_inference";
export type State = "candidate" | "active" | "contested" | "superseded" | "forgotten";

export const KINDS: Kind[] = ["preference", "fact", "experience"];
export const MAX_CONTENT = 300;

export class MemoryError extends Error {}

export const normalize = (s: string) => s.replace(/\s+/g, " ").trim();

// 不记凭证：常见 key 前缀、私钥头、key=value 形式的口令，以及不带分隔的长随机串
const SECRET =
	/(sk-[\w-]{16,}|gh[pousr]_\w{20,}|glpat-[\w-]{16,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*KEY|(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S{6,}|\b[A-Za-z0-9+_-]{40,}\b)/i;

/** 内容闸：不空、不超长、不像凭证。返回拒绝原因 */
export function rejectContent(content: string): string | undefined {
	if (!content) return "内容为空";
	if (content.length > MAX_CONTENT) return `超过 ${MAX_CONTENT} 字`;
	if (SECRET.test(content)) return "看起来含有凭证";
}

/** 关键词与向量都对它建：有条件时连同条件，「什么时候适用」也参与检索 */
export const indexText = (m: Pick<Memory, "content" | "appliesWhen">) => (m.appliesWhen ? `${m.content}\n${m.appliesWhen}` : m.content);

export function getMemory(id: number): Memory | undefined {
	return db().select().from(schema.memories).where(eq(schema.memories.id, id)).get();
}

export function listMemories(states?: State[]): Memory[] {
	const q = db().select().from(schema.memories);
	return (states ? q.where(inArray(schema.memories.state, states)) : q).all().toSorted((a, b) => b.updated - a.updated);
}

/** 正文、用法与条件都相同才算同一条（komo §9.3：条件不同的是两条） */
export function findSame(m: Pick<Memory, "content" | "application" | "appliesWhen" | "scope">): Memory | undefined {
	const content = normalize(m.content);
	return db()
		.select()
		.from(schema.memories)
		.where(and(eq(schema.memories.scope, m.scope), eq(schema.memories.application, m.application)))
		.all()
		.find((x) => normalize(x.content) === content && normalize(x.appliesWhen) === normalize(m.appliesWhen));
}

export interface NewMemory {
	content: string;
	kind: Kind;
	application: Application;
	appliesWhen?: string;
	scope?: string;
	scopeName?: string;
	provenance: Provenance;
	confirmed?: boolean;
	state: State;
	evidence: Evidence[];
	source: string;
	conflicts?: number[];
}

type Tx = Parameters<Parameters<ReturnType<typeof db>["transaction"]>[0]>[0];

/** 在调用方的事务里写一条新记忆和它的关键词索引；向量之后由后台补 */
export function insertMemory(tx: Tx, m: NewMemory): Memory {
	const t = now();
	const row = tx
		.insert(schema.memories)
		.values({
			content: normalize(m.content),
			kind: m.kind,
			application: m.application,
			appliesWhen: normalize(m.appliesWhen ?? ""),
			scope: m.scope ?? "personal",
			scopeName: m.scopeName ?? "",
			provenance: m.provenance,
			confirmed: m.confirmed ?? false,
			state: m.state,
			evidence: m.evidence,
			conflicts: m.conflicts ?? [],
			source: m.source,
			created: t,
			updated: t,
		})
		.returning()
		.get();
	writeTerms(tx, row);
	return row;
}

function writeTerms(tx: Tx, m: Memory) {
	const terms = termsField(indexText(m));
	tx.insert(schema.memoryTerms)
		.values({ memoryId: m.id, revision: m.revision, terms })
		.onConflictDoUpdate({ target: schema.memoryTerms.memoryId, set: { revision: m.revision, terms } })
		.run();
}

/** 改记忆；动到正文、用法、条件或作用域时升 revision 并重建关键词索引 */
export function updateMemory(tx: Tx, id: number, patch: Partial<Omit<Memory, "id" | "revision" | "created">>): Memory {
	const old = tx.select().from(schema.memories).where(eq(schema.memories.id, id)).get();
	if (!old) throw new MemoryError(`记忆 #${id} 不存在`);
	const semantic = (["content", "application", "appliesWhen", "scope"] as const).some((k) => k in patch && patch[k] !== old[k]);
	const row = tx
		.update(schema.memories)
		.set({ ...patch, revision: semantic ? old.revision + 1 : old.revision, updated: now() })
		.where(eq(schema.memories.id, id))
		.returning()
		.get();
	if (semantic) writeTerms(tx, row);
	return row;
}

export function addEvidence(tx: Tx, m: Memory, evidence: Evidence[]) {
	const seen = new Set(m.evidence.map((e) => `${e.kind}:${e.ref}`));
	const fresh = evidence.filter((e) => !seen.has(`${e.kind}:${e.ref}`));
	return fresh.length ? updateMemory(tx, m.id, { evidence: [...m.evidence, ...fresh] }) : m;
}

// ---------- Yi 的操作：记住、确认、遗忘、恢复、改分类 ----------

export interface Classification {
	kind: Kind;
	application: Application;
	appliesWhen: string;
	scope?: string;
	scopeName?: string;
}

/** 约定只给偏好，而且必须写明什么时候适用 */
export function checkClassification(c: Classification): string | undefined {
	if (!KINDS.includes(c.kind)) return `未知种类 ${c.kind}`;
	if (c.application !== "convention" && c.application !== "reference") return `未知用法 ${c.application}`;
	if (c.application === "convention" && c.kind !== "preference") return "只有偏好能设为约定";
	if (c.application === "convention" && !normalize(c.appliesWhen)) return "约定要写明什么时候适用";
}

/**
 * Yi 亲口记一条（飞书里「记住 xxx」、看板手写）。已有同一句话就补证据、候选抬成生效；
 * 遗忘过的不悄悄复活，要在看板上恢复。
 */
export function rememberFromYi(content: string, c: Classification, evidence: Evidence, source: string, confirmed: boolean): Memory {
	content = normalize(content);
	const bad = rejectContent(content) ?? checkClassification(c);
	if (bad) throw new MemoryError(bad);
	const result = db().transaction((tx) => {
		const same = findSame({ content, application: c.application, appliesWhen: c.appliesWhen, scope: c.scope ?? "personal" });
		if (same?.state === "forgotten") throw new MemoryError(`这条记忆 #${same.id} 被遗忘过，要用请在看板上恢复`);
		if (same) {
			const m = addEvidence(tx, same, [evidence]);
			return updateMemory(tx, m.id, {
				state: m.state === "candidate" ? "active" : m.state,
				provenance: "user_statement",
				confirmed: m.confirmed || confirmed,
			});
		}
		return insertMemory(tx, {
			content,
			...c,
			provenance: "user_statement",
			confirmed,
			state: "active",
			evidence: [evidence],
			source,
		});
	});
	afterWrite();
	return result;
}

/** 确认：Yi 复核过这一版文字。和它冲突的条目（有争议的、被推断挑战过的）转为已取代 */
export function confirmMemory(id: number, revision: number): Memory {
	const result = db().transaction((tx) => {
		const m = expect(tx, id, revision);
		if (m.state === "forgotten" || m.state === "superseded") throw new MemoryError("已遗忘或已取代的记忆不能确认，先恢复");
		for (const other of m.conflicts) {
			const o = tx.select().from(schema.memories).where(eq(schema.memories.id, other)).get();
			if (o?.state === "contested" || o?.state === "active" || o?.state === "candidate")
				updateMemory(tx, o.id, { state: "superseded", supersededBy: m.id, conflicts: [] });
		}
		return updateMemory(tx, id, { confirmed: true, state: "active", conflicts: [] });
	});
	afterWrite();
	return result;
}

/** 遗忘：立即停用。原行留着当排除标记；和它冲突的条目没有别的争议时恢复生效 */
export function forgetMemory(id: number, revision: number): Memory {
	const result = db().transaction((tx) => {
		const m = expect(tx, id, revision);
		for (const other of m.conflicts) {
			const o = tx.select().from(schema.memories).where(eq(schema.memories.id, other)).get();
			if (!o) continue;
			const rest = o.conflicts.filter((x) => x !== id);
			updateMemory(tx, o.id, { conflicts: rest, state: o.state === "contested" && !rest.length ? "active" : o.state });
		}
		return updateMemory(tx, id, { state: "forgotten", conflicts: [] });
	});
	afterWrite();
	return result;
}

export function restoreMemory(id: number, revision: number): Memory {
	const result = db().transaction((tx) => {
		const m = expect(tx, id, revision);
		if (m.state !== "forgotten" && m.state !== "superseded") throw new MemoryError("只有已遗忘或已取代的记忆需要恢复");
		return updateMemory(tx, id, { state: "active", supersededBy: null });
	});
	afterWrite();
	return result;
}

/** 改分类：用法、条件、种类、作用域。确认与来源原样保留；候选被 Yi 分类过就算生效 */
export function classifyMemory(id: number, revision: number, c: Classification): Memory {
	const bad = checkClassification(c);
	if (bad) throw new MemoryError(bad);
	const result = db().transaction((tx) => {
		const m = expect(tx, id, revision);
		return updateMemory(tx, id, {
			kind: c.kind,
			application: c.application,
			appliesWhen: normalize(c.appliesWhen),
			scope: c.scope ?? m.scope,
			scopeName: c.scopeName ?? m.scopeName,
			state: m.state === "candidate" ? "active" : m.state,
		});
	});
	afterWrite();
	return result;
}

function expect(tx: Tx, id: number, revision: number): Memory {
	const m = tx.select().from(schema.memories).where(eq(schema.memories.id, id)).get();
	if (!m) throw new MemoryError(`记忆 #${id} 不存在`);
	if (m.revision !== revision) throw new MemoryError(`记忆 #${id} 已经改过（现在是第 ${m.revision} 版），刷新后再操作`);
	return m;
}

export function recordInjected(ids: number[]) {
	if (!ids.length) return;
	db()
		.update(schema.memories)
		.set({ injected: sql`${schema.memories.injected} + 1`, lastInjected: now() })
		.where(inArray(schema.memories.id, ids))
		.run();
}

export function afterWrite() {
	changed();
	scheduleVectors();
}

// ---------- 向量：Ollama /api/embed，后台补齐 ----------

const valid = (v: unknown, dim?: number): v is number[] =>
	Array.isArray(v) && v.length > 0 && (!dim || v.length === dim) && v.every((x) => Number.isFinite(x)) && v.some((x) => x !== 0);

/** 逐条校验：算不出合法向量的那一条给 null，不连累整批 */
export async function embed(texts: string[], kind: "doc" | "query"): Promise<Array<number[] | null>> {
	if (!MEMORY.embedUrl) throw new Error("没有配置 EMBED_URL");
	const input = kind === "query" ? texts.map((t) => MEMORY.queryPrefix + t) : texts;
	const res = await fetch(`${MEMORY.embedUrl.replace(/\/$/, "")}/api/embed`, {
		method: "POST",
		body: JSON.stringify({ model: MEMORY.embedModel, input }),
		signal: AbortSignal.timeout(30_000),
	});
	if (!res.ok) throw new Error(`embedding 接口 ${res.status}：${(await res.text()).slice(0, 200)}`);
	const { embeddings } = (await res.json()) as { embeddings?: unknown[] };
	if (!Array.isArray(embeddings) || embeddings.length !== texts.length) throw new Error("embedding 返回数量不对");
	const dim = (embeddings.find((v) => valid(v)) as number[] | undefined)?.length;
	return embeddings.map((v) => (valid(v, dim) ? v : null));
}

/** 还缺当前模型向量的条目（遗忘的不补） */
function pendingVectors(limit: number): Memory[] {
	return db().all<Memory>(sql`
		select m.id, m.revision, m.content, m.applies_when as appliesWhen from ${schema.memories} m
		left join ${schema.memoryVectors} v on v.memory_id = m.id and v.revision = m.revision and v.model = ${MEMORY.embedModel}
		where v.memory_id is null and m.state != 'forgotten'
		order by m.id limit ${limit}`);
}

/** 一轮补齐；返回这一轮之后还缺几条 */
export async function backfillVectors(): Promise<number> {
	for (;;) {
		const batch = pendingVectors(32);
		if (!batch.length) return 0;
		const vectors = await embed(batch.map(indexText), "doc");
		let wrote = 0;
		db().transaction((tx) => {
			batch.forEach((m, i) => {
				const v = vectors[i];
				if (!v) return log("记忆向量被拒（维度或数值不合法），这条先只走关键词", m.id);
				// 算的这段时间被改过就丢掉，下一轮按新内容再算
				const cur = tx.select({ revision: schema.memories.revision }).from(schema.memories).where(eq(schema.memories.id, m.id)).get();
				if (cur?.revision !== m.revision) return;
				tx.run(sql`insert into ${schema.memoryVectors} (memory_id, revision, model, vec)
					values (${m.id}, ${m.revision}, ${MEMORY.embedModel}, vector32(${JSON.stringify(v)}))
					on conflict(memory_id) do update set revision = excluded.revision, model = excluded.model, vec = excluded.vec`);
				wrote++;
			});
		});
		if (!wrote) return pendingVectors(1).length;
	}
}

let vectorJob: Promise<void> | undefined;
let again = false;
let backoff = 0;
let retryTimer: NodeJS.Timeout | undefined;

/** 同一时刻只跑一个补齐任务；运行中收到的信号合并成结束后再跑一轮。失败退避：30 秒起翻倍，最长 30 分钟 */
export function scheduleVectors() {
	if (!MEMORY.enabled || !MEMORY.embedUrl) return;
	if (vectorJob) return void (again = true);
	clearTimeout(retryTimer);
	vectorJob = backfillVectors()
		.then(() => {
			backoff = 0;
		})
		.catch((e) => {
			backoff = Math.min(backoff ? backoff * 2 : 30, 1800);
			log(`记忆向量补齐失败，${backoff} 秒后重试`, String((e as Error).message).slice(0, 200));
			retryTimer = setTimeout(scheduleVectors, backoff * 1000);
			retryTimer.unref();
		})
		.finally(() => {
			vectorJob = undefined;
			if (again) {
				again = false;
				if (!backoff) scheduleVectors();
			}
		});
}

export function vectorStatus() {
	const total = db().all<{ n: number }>(sql`select count(*) n from ${schema.memories} where state != 'forgotten'`)[0]?.n ?? 0;
	const pending = pendingVectors(100_000).length;
	return { model: MEMORY.embedModel, total, pending, backoff, retryIn: backoff || undefined };
}
