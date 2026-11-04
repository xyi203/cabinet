import { desc } from "drizzle-orm";
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

/** 最近的记录，按时间倒序 */
export function recentRecords(limit = 1000): RecordRow[] {
	return db().select().from(schema.records).orderBy(desc(schema.records.ts)).limit(limit).all();
}
