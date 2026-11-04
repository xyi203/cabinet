import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq, like } from "drizzle-orm";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { PATHS } from "../config.ts";
import * as schema from "./schema.ts";

export { schema };
export type DB = ReturnType<typeof openDb>;

export function openDb(file = PATHS.db) {
	if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
	const sqlite = new Database(file);
	sqlite.pragma("journal_mode = WAL");
	sqlite.pragma("busy_timeout = 5000");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: PATHS.migrations });
	return db;
}

let _db: DB | undefined;
export const db = (): DB => (_db ??= openDb());
/** 测试用：换成内存库 */
export const useDb = (d: DB) => void (_db = d);

export function getKv<T>(key: string, fallback: T): T {
	const row = db().select().from(schema.kv).where(eq(schema.kv.key, key)).get();
	return (row?.value as T) ?? fallback;
}

export function setKv(key: string, value: unknown) {
	db().insert(schema.kv).values({ key, value }).onConflictDoUpdate({ target: schema.kv.key, set: { value } }).run();
}

export function listKv<T>(prefix: string): Array<{ key: string; value: T }> {
	return db()
		.select()
		.from(schema.kv)
		.where(like(schema.kv.key, `${prefix}%`))
		.all() as Array<{ key: string; value: T }>;
}

export function deleteKv(key: string) {
	db().delete(schema.kv).where(eq(schema.kv.key, key)).run();
}
