// 记忆服务最近一次调用的结果。不另起探活：召回和写入每次都会调到，失败持续多久由 Watchdog 判断
import { now } from "../util.ts";

export type Service = "hindsight";

const down = new Map<Service, { since: number; error: string }>();

export function markOk(s: Service) {
	down.delete(s);
}

export function markDown(s: Service, error: string) {
	down.set(s, { since: down.get(s)?.since ?? now(), error: error.slice(0, 200) });
}

export const memoryDown = () => [...down].map(([service, d]) => ({ service, ...d }));
