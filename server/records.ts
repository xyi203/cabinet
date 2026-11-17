import { and, desc, eq, inArray } from "drizzle-orm";
import { changed } from "./bus.ts";
import { db, schema } from "./db/index.ts";
import type { RecordRow } from "./db/schema.ts";
import { now } from "./util.ts";

type NewRecord = Omit<typeof schema.records.$inferInsert, "ts" | "id">;

/** 处理流水：长文本截断后入库 */
export function record(r: NewRecord) {
	db()
		.insert(schema.records)
		.values({
			...r,
			ts: now(),
			question: r.question?.slice(0, 500),
			answer: r.answer?.slice(0, 2000),
			error: r.error?.slice(0, 500),
			seconds: r.seconds == null ? null : Math.round(r.seconds * 10) / 10,
		})
		.run();
	changed();
}

/**
 * 这几条消息（source）最新的一条记录，可按类型、状态筛。直接按 source 查库：recentRecords 只取最近 1000 条，
 * 几天前失败的那条早被挤出去了，工作台上就既没有失败原因也没有重试
 */
export function latestRecord(sources: string[], where: { kind?: string; status?: string } = {}): RecordRow | undefined {
	if (!sources.length) return undefined;
	const conds = [inArray(schema.records.source, sources)];
	if (where.kind) conds.push(eq(schema.records.kind, where.kind));
	if (where.status) conds.push(eq(schema.records.status, where.status));
	return db()
		.select()
		.from(schema.records)
		.where(and(...conds))
		.orderBy(desc(schema.records.ts))
		.limit(1)
		.get();
}

/** 最近的记录，按时间倒序 */
export function recentRecords(limit = 1000): RecordRow[] {
	return db().select().from(schema.records).orderBy(desc(schema.records.ts)).limit(limit).all();
}
