// Turso（tursodatabase，Rust 重写的 SQLite）：业务库和 durable 对话库都跑在它上面。
// 文件格式与 SQLite 兼容，旧的 cabinet.db / agents.sqlite 直接打开，不用迁移。
// - 业务库用它兼容 better-sqlite3 的同步 API，drizzle 沿用 better-sqlite3 的 session（只差构造这一步）
// - durable 存储要的是异步的 SqliteDatabase，照 chord 的 node:sqlite 适配器写：一条连接、串行执行、事务独占
import type { SqliteDatabase, SqliteExecutor, SqliteValue } from "@earendil-works/chord/sqlite";
import { Database } from "@tursodatabase/database/compat";
import { createTableRelationsHelpers, extractTablesRelationalConfig } from "drizzle-orm";
import { BetterSQLiteSession } from "drizzle-orm/better-sqlite3/session";
import { BaseSQLiteDatabase, SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { mkdirSync } from "node:fs";
import path from "node:path";

export interface TursoRunResult {
	changes: number;
	lastInsertRowid: number | bigint;
}

export type TursoDrizzle<S extends Record<string, unknown>> = BaseSQLiteDatabase<"sync", TursoRunResult, S>;

export function openTurso(file: string): Database {
	if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
	const sqlite = new Database(file, { timeout: 5000 });
	sqlite.exec("PRAGMA journal_mode = WAL");
	sqlite.exec("PRAGMA synchronous = NORMAL");
	return sqlite;
}

/** 等同 drizzle-orm/better-sqlite3 的 drizzle(client, { schema })，只是不去 import better-sqlite3 */
export function drizzleTurso<S extends Record<string, unknown>>(client: Database, schema: S): TursoDrizzle<S> {
	const dialect = new SQLiteSyncDialect();
	const tables = extractTablesRelationalConfig(schema, createTableRelationsHelpers);
	const relational = { fullSchema: schema, schema: tables.tables, tableNamesMap: tables.tableNamesMap };
	const session = new BetterSQLiteSession(client as any, dialect, relational, {});
	return new BaseSQLiteDatabase("sync", dialect, session as any, relational) as TursoDrizzle<S>;
}

// ---------- durable 存储 ----------

type Statement = ReturnType<Database["prepare"]>;

/** 按调用顺序执行；异步操作（事务）占住队列直到结束 */
class SerialQueue {
	private tail: Promise<unknown> = Promise.resolve();
	private pending = 0;

	run<T>(op: () => T): Promise<T> {
		if (this.pending > 0) return this.enqueue(op);
		try {
			return Promise.resolve(op());
		} catch (e) {
			return Promise.reject(e);
		}
	}

	runAsync<T>(op: () => Promise<T>): Promise<T> {
		if (this.pending > 0) return this.enqueue(op);
		this.pending++;
		// 先挂上屏障再开始，op 里同步发起的调用会排在它后面
		const barrier = Promise.withResolvers<void>();
		this.tail = barrier.promise;
		let started: Promise<T>;
		try {
			started = op();
		} catch (e) {
			started = Promise.reject(e);
		}
		return started.finally(() => {
			this.pending--;
			barrier.resolve();
		});
	}

	private enqueue<T>(op: () => T | Promise<T>): Promise<T> {
		this.pending++;
		const settled = this.tail.then(op).finally(() => {
			this.pending--;
		});
		this.tail = settled.then(
			() => {},
			() => {},
		);
		return settled;
	}
}

const STATEMENT_CACHE_LIMIT = 256;

abstract class TursoExecutor implements SqliteExecutor {
	protected readonly db: Database;
	protected readonly statements: Map<string, Statement>;

	constructor(db: Database, statements: Map<string, Statement>) {
		this.db = db;
		this.statements = statements;
	}

	protected abstract op<T>(fn: () => T): Promise<T>;

	exec(sql: string) {
		return this.op(() => void this.db.exec(sql));
	}
	run(sql: string, ...params: SqliteValue[]) {
		return this.op(() => void this.statement(sql).run(...params));
	}
	runCounted(sql: string, ...params: SqliteValue[]) {
		return this.op(() => Number(this.statement(sql).run(...params).changes));
	}
	get<T extends object>(sql: string, ...params: SqliteValue[]) {
		return this.op(() => this.statement(sql).get(...params) as T | undefined);
	}
	all<T extends object>(sql: string, ...params: SqliteValue[]) {
		return this.op(() => this.statement(sql).all(...params) as T[]);
	}

	private statement(sql: string): Statement {
		let s = this.statements.get(sql);
		if (s) {
			this.statements.delete(sql);
			this.statements.set(sql, s);
			return s;
		}
		s = this.db.prepare(sql);
		this.statements.set(sql, s);
		if (this.statements.size > STATEMENT_CACHE_LIMIT) this.statements.delete(this.statements.keys().next().value!);
		return s;
	}
}

class TursoTransaction extends TursoExecutor {
	private readonly scope: { active: boolean };

	constructor(db: Database, statements: Map<string, Statement>, scope: { active: boolean }) {
		super(db, statements);
		this.scope = scope;
	}
	protected async op<T>(fn: () => T): Promise<T> {
		if (!this.scope.active) throw new Error("事务已结束，句柄不能再用");
		return fn();
	}
}

export class TursoDurableDatabase extends TursoExecutor implements SqliteDatabase {
	private readonly queue = new SerialQueue();
	private closed = false;

	constructor(db: Database) {
		super(db, new Map());
	}

	protected op<T>(fn: () => T): Promise<T> {
		return this.queue.run(fn);
	}

	transaction<T>(callback: (tx: SqliteExecutor) => Promise<T>): Promise<T> {
		return this.queue.runAsync(async () => {
			this.db.exec("BEGIN IMMEDIATE");
			const scope = { active: true };
			try {
				const result = await callback(new TursoTransaction(this.db, this.statements, scope));
				scope.active = false;
				this.db.exec("COMMIT");
				return result;
			} catch (e) {
				scope.active = false;
				try {
					this.db.exec("ROLLBACK");
				} catch (rollbackError) {
					throw new AggregateError([e, rollbackError], "事务失败，回滚也失败", { cause: rollbackError });
				}
				throw e;
			}
		});
	}

	close() {
		return this.queue.run(() => {
			if (this.closed) return;
			this.closed = true;
			this.statements.clear();
			try {
				this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
			} finally {
				this.db.close();
			}
		});
	}
}

export function openTursoDurable(file: string): TursoDurableDatabase {
	return new TursoDurableDatabase(openTurso(file));
}
