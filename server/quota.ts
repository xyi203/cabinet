// Claude 订阅额度：magpie 会把上游的 anthropic-ratelimit-unified-* 响应头原样转发（5 小时、7 天窗口的用量和重置时间），
// 但 pi-ai 拿不到响应头。所以每隔 QUOTA_INTERVAL 分钟直接经 magpie 发一个 1 token 的请求读这几个头，反映的正是 cabinet 在用的账号。
// codex 那边 magpie 不转发额度头，查不到。看板显示额度条；5 小时窗口用到 PATROL_PAUSE_AT 时巡检暂停，把额度留给起草。
import { changed } from "./bus.ts";
import { QUOTA_INTERVAL, QUOTA_MODEL } from "./config.ts";
import { getKv, setKv } from "./db/index.ts";
import { providerEndpoint } from "./agent/models.ts";
import { log, now } from "./util.ts";

export interface QuotaWindow {
	/** 0~1 */
	utilization: number;
	/** 重置时间，unix 秒（没有为 0） */
	resetsAt: number;
}

export interface Quota {
	/** 查到的时间 */
	at: number;
	/** five_hour、seven_day，其他窗口（比如 7d_oi）按头里的名字原样保留 */
	windows: Record<string, QuotaWindow>;
	/** 最近一次查询失败的原因；成功后清掉 */
	error?: string;
}

const KEY = "quota";
const PREFIX = "anthropic-ratelimit-unified-";
const NAMES: Record<string, string> = { "5h": "five_hour", "7d": "seven_day" };

/** anthropic-ratelimit-unified-<窗口>-utilization / -reset → 各窗口用量；一个都没有返回 undefined */
export function parseRateLimitHeaders(headers: Iterable<[string, string]>, at = now()): Quota | undefined {
	const windows: Record<string, QuotaWindow> = {};
	for (const [k, v] of headers) {
		const m = new RegExp(`^${PREFIX}(.+)-(utilization|reset)$`).exec(k.toLowerCase());
		if (!m) continue;
		const name = NAMES[m[1]] ?? m[1];
		const w = (windows[name] ??= { utilization: 0, resetsAt: 0 });
		if (m[2] === "utilization") w.utilization = Number(v) || 0;
		else w.resetsAt = Number(v) || 0;
	}
	return Object.keys(windows).length ? { at, windows } : undefined;
}

export const quotaNow = () => getKv<Quota | null>(KEY, null);

/** 5 小时窗口的用量（0~1）；没查到过返回 undefined */
export const fiveHourUsed = () => quotaNow()?.windows.five_hour?.utilization;

export async function probeQuota(): Promise<Quota | null> {
	const prev = quotaNow();
	try {
		const ep = providerEndpoint("magpie");
		if (!ep) throw new Error("models.json 里没有 magpie");
		const res = await fetch(`${ep.baseUrl}/chat/completions`, {
			method: "POST",
			headers: { Authorization: `Bearer ${ep.apiKey}`, "Content-Type": "application/json" },
			body: JSON.stringify({ model: QUOTA_MODEL, max_tokens: 1, messages: [{ role: "user", content: "ok" }] }),
			signal: AbortSignal.timeout(60_000),
		});
		await res.body?.cancel();
		const q = parseRateLimitHeaders(res.headers.entries());
		if (!q) throw new Error(`HTTP ${res.status}，响应头里没有额度信息`);
		setKv(KEY, q);
		changed();
		return q;
	} catch (e) {
		const error = String((e as Error).message).slice(0, 200);
		log("查询 Claude 额度失败", error);
		// 保留上次查到的数，只记下失败原因，看板据此提示数据可能过时
		if (prev) setKv(KEY, { ...prev, error });
		changed();
		return prev;
	}
}

let timer: NodeJS.Timeout | undefined;

export function startQuota() {
	if (QUOTA_INTERVAL <= 0) return;
	const loop = () => {
		void probeQuota().finally(() => {
			timer = setTimeout(loop, QUOTA_INTERVAL * 60_000);
			timer.unref();
		});
	};
	timer = setTimeout(loop, 5_000);
	timer.unref();
}

export function stopQuota() {
	clearTimeout(timer);
}
