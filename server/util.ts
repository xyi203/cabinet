import { spawn } from "node:child_process";

export function log(...args: unknown[]) {
	const ts = new Date().toLocaleString("sv-SE", { hour12: false }).slice(5);
	console.error(ts, ...args.map((a) => (a instanceof Error ? a.message : a)));
}

export const now = () => Date.now() / 1000;

// 进程正在退出：这时被打断的运行不算失败，留着待接回标记，下次启动用同一 requestId 接着跑
let stopping = false;
export const isStopping = () => stopping;
export const markStopping = () => void (stopping = true);

// 换个模型就能继续的错误：额度用完、限流、过载
export const QUOTA_RE =
	/out of (extra )?usage|usage limit|quota|rate.?limit|too many requests|\b429\b|overloaded|insufficient.?(balance|credit)/i;

/** 计数信号量：限制同时运行的 pi 会话数 */
export class Semaphore {
	#free: number;
	#queue: Array<() => void> = [];
	constructor(n: number) {
		this.#free = n;
	}
	/** 空闲名额 */
	get free() {
		return this.#free;
	}
	/** 排队等名额的 */
	get waiting() {
		return this.#queue.length;
	}
	async run<T>(fn: () => Promise<T>): Promise<T> {
		if (this.#free > 0) this.#free--;
		else await new Promise<void>((r) => this.#queue.push(r));
		try {
			return await fn();
		} finally {
			const next = this.#queue.shift();
			if (next) next();
			else this.#free++;
		}
	}
}

/** 按 key 串行：同一会话 / 同一聊天同时只跑一个任务 */
export class KeyedLock {
	#tails = new Map<string, Promise<unknown>>();
	run<T>(key: string, fn: () => Promise<T>): Promise<T> {
		const prev = this.#tails.get(key) ?? Promise.resolve();
		const p = prev.then(fn, fn);
		const tail = p.catch(() => {});
		this.#tails.set(key, tail);
		tail.then(() => {
			if (this.#tails.get(key) === tail) this.#tails.delete(key);
		});
		return p;
	}
}

export interface ExecOptions {
	stdin?: string;
	cwd?: string;
	timeout?: number;
}

/** 跑外部命令拿 stdout；非 0 退出码抛错，错误里带 stderr 前 300 字 */
export function exec(cmd: string, args: string[], opts: ExecOptions = {}): Promise<string> {
	return new Promise((resolve, reject) => {
		const p = spawn(cmd, args, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] });
		let out = "";
		let err = "";
		const timer = setTimeout(() => p.kill("SIGKILL"), (opts.timeout ?? 60) * 1000);
		p.stdout.on("data", (d) => (out += d));
		p.stderr.on("data", (d) => (err += d));
		p.on("error", (e) => {
			clearTimeout(timer);
			reject(e);
		});
		p.on("close", (code, signal) => {
			clearTimeout(timer);
			if (code === 0) resolve(out);
			else
				reject(
					new Error(
						`${cmd.split("/").pop()} ${args.slice(0, 2).join(" ")} 失败(${signal ?? code}): ${(err.trim() || out.trim()).slice(0, 300)}`,
					),
				);
		});
		// 子进程不读 stdin 就退出时写入会 EPIPE；没处理的话整个进程会崩
		p.stdin.on("error", () => {});
		p.stdin.end(opts.stdin ?? "");
	});
}
