export const STATUS: Record<string, string> = {
	pending: "待发送",
	noreply: "建议不回复",
	sent: "已发送",
	discarded: "不回复",
	replaced: "已改写",
	merged: "已合并",
	expired: "你已亲自回复",
	completed: "已完成",
	replied: "已回复",
	failed: "失败",
	remembered: "已记住",
	drafted: "已起草",
	revised: "已改写",
	sending: "发送中",
	revising: "改写中",
	skipped: "你已亲自回复",
};
export const AGENT_NAME: Record<string, string> = {
	assistant: "助手",
	dev: "开发助手",
	alert: "告警分析",
	// 改版前的，历史记录还要显示
	cr: "CR",
	ask: "咨询",
	chat: "简单回应",
	general: "通用",
};
export const GLYPH: Record<string, string> = {
	THUMBSUP: "👍",
	OK: "👌",
	Get: "Get",
	DONE: "✅",
	THANKS: "🙏",
	MUSCLE: "💪",
	APPLAUSE: "👏",
	JIAYI: "+1",
	HEART: "❤️",
	ROSE: "🌹",
	CRY: "🥹",
	HUSKY: "🐺",
	YouAreTheBest: "💐",
	BLACKFACE: "🌚",
	Yes: "YES",
	No: "NO",
	LOL: "😂",
	FISTBUMP: "🤜",
	LGTM: "LGTM",
	OnIt: "OnIt",
	OneSecond: "稍等",
	FINGERHEART: "🫰",
	SMILE: "🙂",
	LAUGH: "😄",
};
/** 花费（美元）：两位小数；不到一分钱写 <$0.01，不显示成 $0.00 让人以为没花钱 */
export const money = (c?: number | null) => {
	const v = c ?? 0;
	if (v === 0) return "$0";
	if (v < 0.01) return "<$0.01";
	return `$${v.toFixed(2)}`;
};
const pad = (n: number) => String(n).padStart(2, "0");
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

/** 时刻：14:05 */
export const hm = (ts: number) => {
	const d = new Date(ts * 1000);
	return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/**
 * 一个时间点，相对今天说：今天 14:05、明天 09:30、昨天 18:00、11月12日 09:33、2025年3月2日 10:00。
 * 不用 toLocaleString 再截字符串：月、日是一位数还是两位数时长度会变，截出来会多冒号或少位数
 */
export function when(ts: number, now = Date.now() / 1000) {
	const d = new Date(ts * 1000);
	const n = new Date(now * 1000);
	const rel = (days: number) => dayKey(new Date(n.getFullYear(), n.getMonth(), n.getDate() + days)) === dayKey(d);
	const day = rel(0)
		? "今天"
		: rel(1)
			? "明天"
			: rel(-1)
				? "昨天"
				: d.getFullYear() === n.getFullYear()
					? `${d.getMonth() + 1}月${d.getDate()}日`
					: `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
	return `${day} ${hm(ts)}`;
}

/** 完整时间（详情、悬停提示）：2026年11月9日 14:05 */
export const time = (ts: number) => {
	const d = new Date(ts * 1000);
	return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${hm(ts)}`;
};

/** 日期：11月12日；跨年带年份 */
export function date(ts: number, now = Date.now() / 1000) {
	const d = new Date(ts * 1000);
	const md = `${d.getMonth() + 1}月${d.getDate()}日`;
	return d.getFullYear() === new Date(now * 1000).getFullYear() ? md : `${d.getFullYear()}年${md}`;
}
/** 多久以前：刚刚、5 分钟前、3 小时前；超过一天直接说哪天 */
export function ago(now: number, ts: number) {
	const s = Math.max(0, now - ts);
	if (s < 60) return "刚刚";
	if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
	if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
	return when(ts, now);
}

export const isLive = (d: { status: string }) => d.status === "pending" || d.status === "noreply";
export const describeDraft = (d: { kind: string; draft: string }) =>
	d.kind === "reaction"
		? `表情 ${GLYPH[d.draft] ?? d.draft}`
		: d.kind === "sticker"
			? `表情包「${d.draft.replace(/\.[^.]+$/, "")}」`
			: d.draft;
/** 这条消息从哪来：和张三的私聊、「发布群」里张三 @你 */
export const where = (d: { chatMode: string; chatName: string; senderName: string }) =>
	d.chatMode === "p2p"
		? `和 ${d.senderName} 的私聊`
		: d.chatMode === "meego"
			? `飞书项目「${d.chatName}」里 ${d.senderName} @你`
			: `「${d.chatName}」里 ${d.senderName} @你`;

/** 发布工单（GD-*）在发布系统里的详情页 */
export const ticketUrl = (key: string) => `https://publish.shoplazza.site/issue-view?issueKey=${encodeURIComponent(key)}`;

/** 一件事等 Yi 做什么（TaskView.need）：标签文字和样式 */
export const NEED: Record<string, [string, string]> = {
	send: ["待发送", "p-zhu"],
	approve: ["待批准", "p-zhu"],
	decide: ["待你决定", "p-zhu"],
	read: ["待查看", "p-read"],
	retry: ["失败", "p-fail"],
};
/** 来源（TaskView.source） */
export const SOURCE: Record<string, string> = {
	lark: "飞书",
	meego: "飞书项目",
	bot: "机器人",
	board: "你派的",
	alert: "告警",
	cron: "定时",
	memory: "记忆",
};
/** 工作台筛选：来源分组 */
export const SOURCE_FILTER: Array<[string, string[]]> = [
	["全部", []],
	["飞书", ["lark", "bot"]],
	["飞书项目", ["meego"]],
	["告警", ["alert"]],
	["定时", ["cron"]],
	["你派的", ["board"]],
	["记忆", ["memory"]],
];
/**
 * 列表里的标题：去掉和来源重复的「定时 · 」前缀（来源一栏已经写了定时），
 * 飞书图片消息的内部 key（[图片 img_v3_…]）换成「[图片]」，空的给一句占位
 */
export const titleOf = (t: { title: string }) =>
	t.title
		.replace(/^定时 · /, "")
		.replace(/\[图片 [^\]]*\]/g, "[图片]")
		.trim() || "（没有文字内容）";
export const waitingOn = (t: { status: string }) => t.status === "in_review" || t.status === "blocked";
/** 这件事的状态标签：等 Yi 的按 need，其余按生命周期 */
export function pillOf(t: { status: string; need: string | null; hold?: number; result?: string }): [string, string] {
	if (waitingOn(t) && t.need) return NEED[t.need] ?? ["待处理", "p-zhu"];
	if (t.status === "in_progress") return ["进行中", "p-run"];
	if (t.status === "todo") return t.hold ? ["等你聊完", "p-hold"] : ["排队中", "p-q"];
	if (t.status === "cancelled") return [t.result ?? "已取消", "p-off"];
	return ["已完成", "p-done"];
}
