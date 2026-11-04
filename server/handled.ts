// 轮询去重：已经处理过的消息 id（起草完、跳过、告警收口），重启后不重复处理；保留 3 天
import { inArray, lt } from "drizzle-orm";
import { db, schema } from "./db/index.ts";
import { now } from "./util.ts";

export function isHandled(ids: string[]): Set<string> {
	if (!ids.length) return new Set();
	return new Set(
		db()
			.select({ id: schema.handled.messageId })
			.from(schema.handled)
			.where(inArray(schema.handled.messageId, ids))
			.all()
			.map((r) => r.id),
	);
}

export function markHandled(ids: string[]) {
	const at = now();
	for (const messageId of ids) db().insert(schema.handled).values({ messageId, at }).onConflictDoNothing().run();
}

export function pruneHandled() {
	db()
		.delete(schema.handled)
		.where(lt(schema.handled.at, now() - 3 * 86400))
		.run();
}
