// 路由规则（docs/router-worker.md §3）：散在各流程里的阈值收进 config/routes.json，看板「设置 → 路由规则」能改，改完不用重启。
// 文件里没写的项沿用 .env 和默认值，所以没有这个文件时行为和以前一样。
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import {
	ALERT_CHATS,
	ALERT_FOLLOW,
	ALERT_MAX_WAIT,
	ALERT_QUIET,
	ALERT_SENDERS,
	PATHS,
	PATROL_PAUSE_AT,
	SUBSCRIBE_TTL,
	DEEP_WAIT,
	P2P_WAIT,
	YI_ACTIVE_CHECK,
	YI_ACTIVE_DELAY,
	YI_ACTIVE_WINDOW,
} from "./config.ts";

/** 保存时校验不过：看板把原因原样显示 */
export class RuleError extends Error {}

export interface RouteRules {
	/** 归属：话题 / 工作项 / MR 关闭后这么多秒内再来消息就重开同一件事；订阅接续也按它失效（秒） */
	reopen: number;
	/**
	 * 你正在聊：触发消息前 window 秒内你说过话，先等最多 delay 秒再处理，每 check 秒看一次你回了没；delay 为 0 不等。
	 * 私聊另外总要等到消息来了 p2p 秒再起草，分诊成 deep 的等到 deep 秒（0 = 不等）
	 */
	yiActive: { window: number; delay: number; check: number; p2p: number; deep: number };
	/** 告警攒批：quiet 秒没有新的就收口，最长 maxWait 秒；同群 follow 秒内再来、上一批没归档就并进去。senders / chats 为空时不限 */
	alert: { quiet: number; maxWait: number; follow: number; senders: string[]; chats: string[] };
	/** 定时：巡检时 Claude 5 小时额度用到这个比例就跳过（手动运行不拦） */
	cron: { patrolPauseAt: number };
}

export const RULE_DEFAULTS: RouteRules = {
	reopen: SUBSCRIBE_TTL,
	yiActive: { window: YI_ACTIVE_WINDOW, delay: YI_ACTIVE_DELAY, check: YI_ACTIVE_CHECK, p2p: P2P_WAIT, deep: DEEP_WAIT },
	alert: { quiet: ALERT_QUIET, maxWait: ALERT_MAX_WAIT, follow: ALERT_FOLLOW, senders: [...ALERT_SENDERS], chats: [...ALERT_CHATS] },
	cron: { patrolPauseAt: PATROL_PAUSE_AT },
};

let cache: { mtime: number; rules: RouteRules } | undefined;

/** 当前生效的规则：按文件修改时间缓存，文件改了下一次调用就生效；文件坏了退回默认值 */
export function routeRules(): RouteRules {
	if (!existsSync(PATHS.routes)) return RULE_DEFAULTS;
	const mtime = statSync(PATHS.routes).mtimeMs;
	if (cache?.mtime === mtime) return cache.rules;
	let raw: Partial<RouteRules> = {};
	try {
		raw = JSON.parse(readFileSync(PATHS.routes, "utf8"));
	} catch {
		// 手改坏了：先按默认跑，保存时会校验
	}
	const rules = merge(raw);
	cache = { mtime, rules };
	return rules;
}

function merge(raw: Partial<RouteRules>): RouteRules {
	const d = RULE_DEFAULTS;
	return {
		reopen: raw.reopen ?? d.reopen,
		yiActive: { ...d.yiActive, ...raw.yiActive },
		alert: { ...d.alert, ...raw.alert },
		cron: { ...d.cron, ...raw.cron },
	};
}

/** 看板保存：校验后整份写回 config/routes.json */
export function saveRouteRules(input: unknown): RouteRules {
	const r = merge((input ?? {}) as Partial<RouteRules>);
	const nums: Array<[string, number, number, number]> = [
		["重开时间", r.reopen, 0, 30 * 86400],
		["你在聊的判断窗口", r.yiActive.window, 0, 3600],
		["你在聊时最多等", r.yiActive.delay, 0, 600],
		["你在聊时检查间隔", r.yiActive.check, 1, 60],
		["私聊起草前先等", r.yiActive.p2p, 0, 1800],
		["私聊 deep 档等到", r.yiActive.deep, 0, 3600],
		["告警静默收口", r.alert.quiet, 10, 3600],
		["告警最长攒批", r.alert.maxWait, 10, 7200],
		["告警续批窗口", r.alert.follow, 0, 86400],
		["巡检额度上限", r.cron.patrolPauseAt, 0, 1],
	];
	for (const [name, v, lo, hi] of nums)
		if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi) throw new RuleError(`${name}要在 ${lo} 到 ${hi} 之间`);
	if (r.alert.maxWait < r.alert.quiet) throw new RuleError("告警最长攒批不能比静默收口短");
	for (const k of ["senders", "chats"] as const)
		if (!Array.isArray(r.alert[k]) || r.alert[k].some((x) => typeof x !== "string")) throw new RuleError(`告警的 ${k} 要是字符串列表`);
	writeFileSync(PATHS.routes, `${JSON.stringify(r, null, "\t")}\n`);
	return r;
}
