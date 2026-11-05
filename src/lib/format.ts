export const STATUS: Record<string, string> = {
	pending: "待确认",
	noreply: "建议不回",
	sent: "已发出",
	discarded: "不发",
	replaced: "已改写",
	merged: "已合并",
	expired: "已亲自回复",
	completed: "已标记完成",
	replied: "已回复",
	failed: "失败",
	remembered: "已记住",
	drafted: "已起草",
	revised: "已改写",
	sending: "发送中",
	revising: "改写中",
	skipped: "已亲自回复",
};
export const AGENT_NAME: Record<string, string> = {
	assistant: "助手",
	dev: "开发",
	alert: "告警",
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
export const money = (c?: number | null) => `$${(c ?? 0).toFixed((c ?? 0) >= 1 ? 2 : 4)}`;
export const time = (ts: number) => new Date(ts * 1000).toLocaleString("zh-CN", { hour12: false });
export function ago(now: number, ts: number) {
	const s = Math.max(0, now - ts);
	return s < 60
		? "刚刚"
		: s < 3600
			? `${Math.floor(s / 60)} 分钟前`
			: s < 86400
				? `${Math.floor(s / 3600)} 小时前`
				: `${Math.floor(s / 86400)} 天前`;
}
export const isLive = (d: { status: string }) => d.status === "pending" || d.status === "noreply";
export const describeDraft = (d: { kind: string; draft: string }) =>
	d.kind === "reaction" ? `表情回复 ${GLYPH[d.draft] ?? ""} ${d.draft}` : d.kind === "sticker" ? `表情包 ${d.draft}` : d.draft;
export const where = (d: { chatMode: string; chatName: string; senderName: string }) =>
	d.chatMode === "p2p"
		? `私聊 · ${d.senderName}`
		: d.chatMode === "meego"
			? `飞书项目「${d.chatName}」· ${d.senderName} @你`
			: `群「${d.chatName}」· ${d.senderName} @你`;
