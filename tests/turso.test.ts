// Turso 适配：durable 存储跑 pi-durable 自带的一致性用例，业务库验 drizzle 的读写、事务和迁移
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { createStorageConformance } from "@earendil-works/pi-durable/testing";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { eq } from "drizzle-orm";
import { openDb, schema } from "../server/db/index.ts";
import { openTursoDurable } from "../server/db/turso.ts";

/** toEqual 不区分「没有这个键」和「值是 undefined」 */
const strip = (v: unknown): unknown => {
	if (Array.isArray(v)) return v.map(strip);
	if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype)
		return Object.fromEntries(
			Object.entries(v)
				.filter(([, x]) => x !== undefined)
				.map(([k, x]) => [k, strip(x)]),
		);
	return v;
};

const cases = createStorageConformance({
	assertions: {
		ok: (v, m) => assert.ok(v, m ?? "不成立"),
		strictEqual: (a, e) => assert.strictEqual(a, e),
		deepEqual: (a, e) => assert.deepStrictEqual(strip(a), strip(e)),
		partialDeepEqual: (a, e) => assert.partialDeepStrictEqual(a, e),
		greaterThan: (a, e) => assert.ok(a > e, `${a} > ${e}`),
		rejects: (op, includes) => assert.rejects(op, (e: Error) => String(e?.message).includes(includes)),
	},
	withStorage: async (use) => {
		const dir = mkdtempSync(path.join(tmpdir(), "cabinet-turso-"));
		const storage = await SqliteStorage.open(openTursoDurable(path.join(dir, "agents.sqlite")));
		try {
			await use(storage);
		} finally {
			await storage.close(BACKGROUND_CONTEXT);
			rmSync(dir, { recursive: true, force: true });
		}
	},
});

describe("durable 存储跑在 Turso 上", () => {
	for (const c of cases) test(c.name, () => c.run());
});

test("业务库：迁移、upsert、条件更新计数、事务回滚", () => {
	const db = openDb(":memory:");
	const kv = schema.kv;
	db.insert(kv)
		.values({ key: "a", value: { n: 1 } })
		.onConflictDoUpdate({ target: kv.key, set: { value: { n: 2 } } })
		.run();
	db.insert(kv)
		.values({ key: "a", value: { n: 1 } })
		.onConflictDoUpdate({ target: kv.key, set: { value: { n: 2 } } })
		.run();
	assert.deepEqual(db.select().from(kv).where(eq(kv.key, "a")).get(), { key: "a", value: { n: 2 } });
	assert.equal(db.update(kv).set({ value: 3 }).where(eq(kv.key, "nope")).run().changes, 0);
	assert.throws(() =>
		db.transaction((tx) => {
			tx.insert(kv).values({ key: "b", value: 1 }).run();
			throw new Error("回滚");
		}),
	);
	assert.equal(db.select().from(kv).all().length, 1);
});
