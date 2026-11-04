// Watchdog：主流程之外的控制回路。定时按确定的规则查一遍，有新问题私聊 Yi 一张卡片（同一个问题只提醒一次，恢复后清掉），
// 当前的问题同时放进看板「待你处理」。只查不修：修复（重试、重新授权、重启）由 Yi 决定。
import { ALERT_MAX_WAIT, DRAFT_ENABLED, OWNER_OPEN_ID, PORT, POLL_INTERVAL, WATCHDOG_INTERVAL } from "./config.ts";
import { deleteKv, getKv, listKv, setKv } from "./db/index.ts";
import { running } from "./agent/driver.ts";
import { batchesSnapshot } from "./alerts.ts";
import { devTasksList } from "./dev.ts";
import { inflight } from "./drafts/store.ts";
import { sendCardToUserAsBot, userAuthStatus } from "./lark/bot.ts";
import { lastPoll } from "./poller.ts";
import { recentRecords } from "./records.ts";
import { log, now } from "./util.ts";

export interface Issue {
	/** 同一个问题同一个 key：用来去重和判断恢复 */
	key: string;
	title: string;
	detail: string;
}

export interface Snapshot {
	now: number;
	pollEnabled: boolean;
	pollSince: number | null;
	auth: { authorized: boolean; refreshExpiresAt?: number };
	devTasks: Array<{ id: string; status: string; updated: number; title: string }>;
	/** 正在跑的 durable 会话 key */
	runningKeys: Set<string>;
	inflight: Array<{ id: string; since: number; label: string }>;
	failures: Array<{ ts: number }>;
	alertBatches: Array<{ chatId: string; name: string; first: number }>;
}

const MIN = 60;

/** 按快照判断有哪些问题；纯函数，阈值写在这里 */
export function checkHealth(s: Snapshot): Issue[] {
	const issues: Issue[] = [];
	if (s.pollEnabled) {
		if (!s.auth.authorized)
			issues.push({
				key: "auth",
				title: "飞书用户身份没有授权",
				detail: "读不到私聊和 @你 的消息，草稿也发不出去。在看板上点「授权飞书」。",
			});
		else {
			const lag = s.pollSince ? s.now - s.pollSince : Infinity;
			if (lag > Math.max(10 * MIN, POLL_INTERVAL * 10))
				issues.push({
					key: "poll",
					title: "轮询停了",
					detail: s.pollSince
						? `上次推进是 ${Math.round(lag / MIN)} 分钟前，私聊和 @你 的消息可能漏了。看一下 data/cabinet.log。`
						: "启动后还没完成过一次轮询。",
				});
			const left = s.auth.refreshExpiresAt ? s.auth.refreshExpiresAt - s.now : Infinity;
			if (left < 3 * 86400)
				issues.push({
					key: "auth-expiring",
					title: "飞书授权快过期了",
					detail: `还剩 ${Math.max(0, Math.round(left / 3600))} 小时，到期前在看板上重新授权。`,
				});
		}
	}
	for (const d of s.inflight)
		if (s.now - d.since > 30 * MIN)
			issues.push({
				key: `draft-stuck:${d.id}`,
				title: "起草卡住了",
				detail: `${d.label} 的消息起草了 ${Math.round((s.now - d.since) / MIN)} 分钟还没出草稿。`,
			});
	for (const t of s.devTasks)
		if (t.status === "running" && !s.runningKeys.has(`dev-${t.id}`) && s.now - t.updated > 5 * MIN)
			issues.push({
				key: `task-lost:${t.id}`,
				title: "agent 任务丢了",
				detail: `「${t.title.slice(0, 40)}」显示运行中，但没有在跑的运行。在卡片或看板上给它发一句话就会重新开始。`,
			});
	for (const b of s.alertBatches)
		if (s.now - b.first > ALERT_MAX_WAIT + 5 * MIN)
			issues.push({
				key: `alert-stuck:${b.chatId}`,
				title: "告警批没有收口",
				detail: `群「${b.name}」的一批告警攒了 ${Math.round((s.now - b.first) / MIN)} 分钟还没交给 agent。`,
			});
	const failed = s.failures.filter((f) => s.now - f.ts < 3600).length;
	if (failed >= 5)
		issues.push({
			key: "failures",
			title: "最近失败很多",
			detail: `最近一小时失败了 ${failed} 次，可能是模型网关、额度或飞书接口出了问题。看板「失败」里有原因。`,
		});
	return issues;
}

function snapshot(): Snapshot {
	return {
		now: now(),
		pollEnabled: DRAFT_ENABLED,
		pollSince: lastPoll(),
		auth: userAuthStatus(),
		devTasks: devTasksList(),
		runningKeys: new Set(running.keys()),
		inflight: [...inflight].map(([id, d]) => ({ id, since: d.since, label: d.label })),
		failures: recentRecords(200).filter((r) => r.status === "failed"),
		alertBatches: batchesSnapshot(),
	};
}

let current: Issue[] = [];
/** 当前的问题，看板「待你处理」用 */
export const watchdogIssues = () => current;

const seenKey = (key: string) => `watchdog:${key}`;

function card(issues: Issue[]) {
	return {
		schema: "2.0",
		config: { update_multi: true, summary: { content: `Watchdog：${issues.map((i) => i.title).join("、")}` } },
		header: {
			title: { tag: "plain_text", content: "Watchdog" },
			subtitle: { tag: "plain_text", content: `${issues.length} 个新问题` },
			template: "red",
		},
		body: {
			elements: [
				...issues.map((i) => ({ tag: "markdown", content: `**${i.title}**\n${i.detail}` })),
				{
					tag: "div",
					text: {
						tag: "plain_text",
						content: `同一个问题只提醒一次，恢复后自动清掉。看板 http://127.0.0.1:${PORT}/?view=todo`,
						text_color: "grey",
						text_size: "notation",
					},
				},
			],
		},
	};
}

/** 查一遍：新出现的问题私聊一次，恢复了的清掉 */
export async function tick(s = snapshot()) {
	const issues = checkHealth(s);
	const keys = new Set(issues.map((i) => i.key));
	for (const { key } of listKv<number>("watchdog:")) {
		const k = key.slice("watchdog:".length);
		if (!keys.has(k)) {
			deleteKv(key);
			log("Watchdog：已恢复", k);
		}
	}
	const fresh = issues.filter((i) => getKv(seenKey(i.key), null) === null);
	current = issues;
	if (!fresh.length) return;
	for (const i of fresh) setKv(seenKey(i.key), s.now);
	log("Watchdog：发现问题", fresh.map((i) => i.key).join(", "));
	try {
		await sendCardToUserAsBot(OWNER_OPEN_ID, card(fresh));
	} catch (e) {
		log("Watchdog 提醒发送失败", e);
	}
}

let timer: NodeJS.Timeout | undefined;

export function startWatchdog() {
	// 启动后先等一轮轮询和接回跑完，免得把正在恢复的东西当成问题
	timer = setTimeout(
		function loop() {
			void tick()
				.catch((e) => log("Watchdog 检查失败", e))
				.finally(() => {
					timer = setTimeout(loop, WATCHDOG_INTERVAL * 1000);
					timer.unref();
				});
		},
		3 * MIN * 1000,
	);
	timer.unref();
}

export function stopWatchdog() {
	clearTimeout(timer);
}
