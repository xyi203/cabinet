// Watchdog：主流程之外的控制回路。定时按确定的规则查一遍，有新问题私聊 Yi 一张卡片（同一个问题只提醒一次，恢复后清掉），
// 当前的问题同时放进看板「待你处理」。新问题同时派助手去查原因（模型出问题的除外：模型挂了助手也跑不起来），
// 结果私聊 Yi。自检和助手都只查不修：修复（重试、重新授权、重启）由 Yi 决定。
import path from "node:path";
import { DATA_DIR, DRAFT_ENABLED, OWNER_OPEN_ID, POLL_INTERVAL, ROOT, WATCHDOG_INTERVAL } from "./config.ts";
import { routeRules } from "./rules.ts";
import { deleteKv, getKv, listKv, setKv } from "./db/index.ts";
import { running } from "./agent/driver.ts";
import { batchesSnapshot } from "./alerts.ts";
import { devActive, devTasksList, dispatch } from "./dev.ts";
import { inflight } from "./drafts/store.ts";
import { sendCardToUserAsBot, userAuthStatus } from "./lark/bot.ts";
import { memoryDown } from "./memory/health.ts";
import { lastPoll } from "./poller.ts";
import { recentRecords } from "./records.ts";
import { opsLink } from "./boardlink.ts";
import { footnote } from "./drafts/card.ts";
import { QUOTA_RE, log, now, span } from "./util.ts";

export interface Issue {
	/** 同一个问题同一个 key：用来去重和判断恢复 */
	key: string;
	title: string;
	detail: string;
	/** 模型出的问题：不派助手去查 */
	model?: boolean;
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
	failures: Array<{ ts: number; error?: string | null }>;
	alertBatches: Array<{ chatId: string; name: string; first: number }>;
	/** 记忆服务最近一次调用失败、到现在还没成功过的 */
	memoryDown: Array<{ service: string; since: number; error: string }>;
}

const MIN = 60;

const MODEL_RE = /model|模型|anthropic|openai|claude|codex|gpt|api.?key/i;
export const isModelError = (e?: string | null) => !!e && (QUOTA_RE.test(e) || MODEL_RE.test(e));

/** 按快照判断有哪些问题；纯函数，阈值写在这里 */
export function checkHealth(s: Snapshot): Issue[] {
	const issues: Issue[] = [];
	if (s.pollEnabled) {
		if (!s.auth.authorized)
			issues.push({
				key: "auth",
				title: "飞书还没授权",
				detail: "收不到私聊和 @你 的消息，草稿也发不出去。到看板上点「授权飞书」。",
			});
		else {
			const lag = s.pollSince ? s.now - s.pollSince : Infinity;
			if (lag > Math.max(10 * MIN, POLL_INTERVAL * 10))
				issues.push({
					key: "poll",
					title: "收取消息停了",
					detail: s.pollSince
						? `已经 ${span(lag)} 没有收取新消息，私聊和 @你 的消息可能漏了。原因在 data/cabinet.log 里。`
						: "启动后还没成功收取过一次消息。",
				});
			const left = s.auth.refreshExpiresAt ? s.auth.refreshExpiresAt - s.now : Infinity;
			if (left < 3 * 86400)
				issues.push({
					key: "auth-expiring",
					title: "飞书授权快过期了",
					detail: `还剩 ${span(left)}，到期前到看板上重新授权。`,
				});
		}
	}
	for (const d of s.inflight)
		if (s.now - d.since > 30 * MIN)
			issues.push({
				key: `draft-stuck:${d.id}`,
				title: "起草卡住了",
				detail: `${d.label} 的消息已经起草了 ${span(s.now - d.since)}，还没出草稿。`,
			});
	for (const t of s.devTasks)
		if (t.status === "running" && !s.runningKeys.has(`dev-${t.id}`) && s.now - t.updated > 5 * MIN)
			issues.push({
				key: `task-lost:${t.id}`,
				title: "任务中断了",
				detail: `「${t.title.slice(0, 40)}」显示进行中，实际已经没在运行。在卡片或看板上给它发一句话，就会接着做。`,
			});
	for (const b of s.alertBatches)
		if (s.now - b.first > routeRules().alert.maxWait + 5 * MIN)
			issues.push({
				key: `alert-stuck:${b.chatId}`,
				title: "告警迟迟没有分析",
				detail: `「${b.name}」的告警已经攒了 ${span(s.now - b.first)}，还没交给助手分析。`,
			});
	for (const m of s.memoryDown)
		if (s.now - m.since > 15 * MIN)
			issues.push({
				key: `memory-down:${m.service}`,
				title: "Hindsight 连不上",
				detail: `已经 ${span(s.now - m.since)} 调不通，这段时间起草不带约定、偏好与经验，沉淀在重试。最近的错误：${m.error}`,
			});
	const failed = s.failures.filter((f) => s.now - f.ts < 3600);
	if (failed.length >= 5)
		issues.push({
			key: "failures",
			title: "最近失败比较多",
			detail: `最近一小时失败了 ${failed.length} 次，可能是模型服务、额度或飞书接口出了问题。原因在看板的「运行」页。`,
			// 一半以上是模型的错（额度、限流、过载、模型接口报错）就不派助手：它也要调模型
			model: failed.filter((f) => isModelError(f.error)).length * 2 >= failed.length,
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
		// 在排队（等会话锁、等并发名额）的 agent 任务也算在跑，不报「中断了」
		runningKeys: new Set([...running.keys(), ...[...devActive.keys()].map((id) => `dev-${id}`)]),
		// 等 Yi 批准的不算卡住
		inflight: [...inflight].filter(([, d]) => !d.approval).map(([id, d]) => ({ id, since: d.since, label: d.label })),
		failures: recentRecords(200)
			.filter((r) => r.status === "failed")
			.map((r) => ({ ts: r.ts, error: r.error })),
		alertBatches: batchesSnapshot(),
		memoryDown: memoryDown(),
	};
}

let current: Issue[] = [];
/** 当前的问题，看板「待你处理」用 */
export const watchdogIssues = () => current;

const seenKey = (key: string) => `watchdog:${key}`;

function card(issues: Issue[]) {
	return {
		schema: "2.0",
		config: { update_multi: true, summary: { content: `自检：${issues.map((i) => i.title).join("、")}` } },
		header: {
			title: { tag: "plain_text", content: "自检" },
			subtitle: { tag: "plain_text", content: `发现 ${issues.length} 个新问题` },
			template: "red",
		},
		body: {
			elements: [
				...issues.map((i) => ({
					tag: "markdown",
					content: `**${i.title}**\n${i.detail}${agentOf(i.key) ? "\n已派助手去查原因，查完私聊你。" : ""}`,
				})),
				footnote("同一个问题只提醒一次", opsLink()),
			],
		},
	};
}

/** 派去查这个问题的助手任务；和「提醒过」分开记：提醒没发出去下一轮重发时，不能再派一个 */
const agentKey = (key: string) => `watchdog-agent:${key}`;
const agentOf = (key: string) => getKv<string | null>(agentKey(key), null);

/** 派助手查一个问题，返回任务 id */
export function investigate(i: Issue) {
	return dispatch({
		agent: "assistant",
		title: `自检排查：${i.title}`,
		request: `cabinet 的自检发现一个问题，查清楚原因：卡在哪一层、为什么、现在还在不在、怎么恢复。

问题：${i.title}
现象：${i.detail}

线索：cabinet 代码在 ${ROOT}，运行日志在 ${path.join(DATA_DIR, "cabinet.log")}，自检规则在 server/watchdog.ts。
依赖的本机服务（比如 Hindsight 容器、OrbStack）先看它们自己的状态和日志，再看 cabinet 这边。
只查不修：要重启、拉起服务、改配置的，把命令和理由写清楚交给 Yi 决定。`,
		notify: true,
	}).then((t) => t.id);
}

/** 查一遍：新出现的问题私聊一次、派助手去查，恢复了的清掉。notify、investigate 可替换，测试用 */
export async function tick(
	s = snapshot(),
	notify: (fresh: Issue[]) => Promise<unknown> = (fresh) => sendCardToUserAsBot(OWNER_OPEN_ID, card(fresh)),
	start: (i: Issue) => Promise<string> = investigate,
) {
	const issues = checkHealth(s);
	const keys = new Set(issues.map((i) => i.key));
	for (const { key } of listKv<number>("watchdog:")) {
		const k = key.slice("watchdog:".length);
		if (!keys.has(k)) {
			deleteKv(key);
			log("Watchdog：已恢复", k);
		}
	}
	for (const { key } of listKv<string>("watchdog-agent:")) if (!keys.has(key.slice("watchdog-agent:".length))) deleteKv(key);
	const fresh = issues.filter((i) => getKv(seenKey(i.key), null) === null);
	current = issues;
	// 所有还没派过的都派，不只新的：派失败了而提醒已经发出去的，下一轮也要补上
	for (const i of issues) {
		if (i.model || agentOf(i.key)) continue;
		try {
			const id = await start(i);
			setKv(agentKey(i.key), id);
			log("Watchdog：派助手排查", i.key, id);
		} catch (e) {
			log("Watchdog 派助手排查失败，下一轮再试", i.key, e);
		}
	}
	if (!fresh.length) return;
	log("Watchdog：发现问题", fresh.map((i) => i.key).join(", "));
	try {
		await notify(fresh);
		// 发出去了才算提醒过：最需要提醒的时候（网络、飞书出问题）恰恰最容易发不出去，下一轮要再试
		for (const i of fresh) setKv(seenKey(i.key), s.now);
	} catch (e) {
		log("Watchdog 提醒发送失败，下一轮再试", e);
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
