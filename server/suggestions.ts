// 只出建议的巡查（docs/bot-borrow.md §1，参照 Orca 的 Look around）：定时任务打开「只出建议」后，
// agent 不写结论、不私聊，只在回复里交【建议】（一次最多 MAX_PER_RUN 条）；cabinet 按链接（没有链接按标题）去重，
// 放进工作台的建议列表。Yi 采纳了才开成一件事交给助手，忽略了的记下来：同一个链接 QUIET_DAYS 天内不再提。
// 每轮的提示里带上还挂着的、最近采纳的、最近忽略的，agent 照着学 Yi 想看什么、不想看什么。
// 这里只管解析和存取；采纳后派活在 api.ts（避免和 dev.ts 循环引用）。
import { getKv, listKv, setKv } from "./db/index.ts";
import { now } from "./util.ts";

export const SUGGEST_MARK = "【建议】";
const OTHER_MARKS = ["【提问】", "【复查】", "【备注】"];
export const MAX_PER_RUN = 5;
const QUIET_DAYS = 30;
/** 挂着没人理的建议过了这么久就不再显示（不算忽略，以后还能再提） */
const STALE_DAYS = 14;
const DAY = 86400;

export interface SuggestionSpec {
	title: string;
	why: string;
	/** 采纳后交给助手做什么 */
	ask: string;
	link?: string;
}

export interface Suggestion extends SuggestionSpec {
	id: string;
	/** 去重用：规范化后的链接，没有链接用标题 */
	key: string;
	/** 哪个定时任务提的 */
	source: string;
	/** 提出它的那次 agent 任务 */
	devId: string;
	created: number;
	status: "open" | "accepted" | "dismissed";
	decided?: number;
	/** 采纳后开出的 agent 任务 */
	taskId?: string;
}

const itemKey = (id: string) => `sg:${id}`;

/** 链接去掉查询串、锚点和结尾的 /，小写；不是链接就按标题（去空白、小写） */
export function suggestionKey(s: Pick<SuggestionSpec, "title" | "link">): string {
	if (s.link) {
		try {
			const u = new URL(s.link);
			return `${u.host}${u.pathname}`.replace(/\/+$/, "").toLowerCase();
		} catch {}
	}
	return `t:${s.title.replace(/\s+/g, "").toLowerCase()}`;
}

/**
 * 从 agent 的回复里取出【建议】段（JSON 数组）：只认最后一个，到文本末尾或下一个已知段标记为止；返回去掉它之后的文本。
 * 带凭证的链接（user:pass@ 或 token / key 之类的查询参数）整条不收
 */
export function takeSuggestions(text: string): { text: string; items: SuggestionSpec[]; error?: string } {
	const i = text.lastIndexOf(SUGGEST_MARK);
	if (i < 0) return { text, items: [] };
	const tail = text.slice(i + SUGGEST_MARK.length);
	const end = Math.min(...OTHER_MARKS.map((m) => tail.indexOf(m)).filter((x) => x >= 0), tail.length);
	const rest = (text.slice(0, i) + tail.slice(end)).trim();
	const raw = tail
		.slice(0, end)
		.trim()
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/```\s*$/, "")
		.trim();
	let v: unknown;
	try {
		v = JSON.parse(raw);
	} catch (e) {
		return { text: rest, items: [], error: `【建议】不是合法的 JSON：${(e as Error).message}` };
	}
	const items: SuggestionSpec[] = [];
	for (const x of (Array.isArray(v) ? v : [v]) as any[]) {
		const title = typeof x?.title === "string" ? x.title.trim() : "";
		const why = typeof x?.why === "string" ? x.why.trim() : "";
		const ask = typeof x?.ask === "string" ? x.ask.trim() : "";
		if (!title || !why || !ask) continue;
		const link = typeof x.link === "string" && /^https?:\/\//.test(x.link.trim()) ? x.link.trim() : undefined;
		if (link && /\/\/[^/@\s]+@|[?&](?:token|access_token|key|secret|password|sig|signature)=/i.test(link)) continue;
		items.push({ title: title.slice(0, 80), why: why.slice(0, 400), ask: ask.slice(0, 1000), link });
		if (items.length >= MAX_PER_RUN) break;
	}
	return { text: rest, items };
}

export const allSuggestions = () => listKv<Suggestion>("sg:").map((x) => x.value);

/** 记下这一轮的建议：已经挂着的同一条只更新内容；最近采纳或忽略过的不再收。返回新收的条数 */
export function saveSuggestions(items: SuggestionSpec[], source: string, devId: string, at = now()): number {
	const all = allSuggestions();
	let added = 0;
	for (const it of items) {
		const key = suggestionKey(it);
		const same = all.filter((s) => s.key === key);
		if (same.some((s) => s.status !== "open" && at - (s.decided ?? s.created) < QUIET_DAYS * DAY)) continue;
		const open = same.find((s) => s.status === "open" && at - s.created < STALE_DAYS * DAY);
		if (open) {
			setKv(itemKey(open.id), { ...open, ...it, source, devId });
			continue;
		}
		const id = `sg-${Date.now().toString(36)}-${added}`;
		setKv(itemKey(id), { ...it, id, key, source, devId, created: at, status: "open" } satisfies Suggestion);
		added++;
	}
	return added;
}

/** 工作台上要显示的：还挂着、没过期的，新的在前 */
export const openSuggestions = (at = now()) =>
	allSuggestions()
		.filter((s) => s.status === "open" && at - s.created < STALE_DAYS * DAY)
		.toSorted((a, b) => b.created - a.created);

export const getSuggestion = (id: string) => getKv<Suggestion | null>(itemKey(id), null) ?? undefined;

export function decideSuggestion(id: string, status: "accepted" | "dismissed", taskId?: string, at = now()): Suggestion | undefined {
	const s = getSuggestion(id);
	if (!s || s.status !== "open") return;
	const next = { ...s, status, decided: at, taskId };
	setKv(itemKey(id), next);
	return next;
}

const line = (s: Suggestion) => `- ${s.title}${s.link ? `（${s.link}）` : ""}`;

const group = (name: string, xs: Suggestion[]) => (xs.length ? `${name}：\n${xs.slice(0, 10).map(line).join("\n")}` : "");

/** 提示里带的历史：还挂着的、最近采纳的、最近忽略的（各取最近几条），让 agent 只提新的、学 Yi 的口味 */
export function suggestionHistory(at = now()): string {
	const recent = allSuggestions().filter((s) => at - (s.decided ?? s.created) < QUIET_DAYS * DAY);
	const by = (st: Suggestion["status"]) =>
		recent.filter((s) => s.status === st).toSorted((a, b) => (b.decided ?? b.created) - (a.decided ?? a.created));
	return [
		group("还挂着、Yi 没处理的（不要重复提）", by("open")),
		group("Yi 最近采纳的（他想看这类）", by("accepted")),
		group("Yi 最近忽略的（这类少提，同一个链接不要再提）", by("dismissed")),
	]
		.filter(Boolean)
		.join("\n\n");
}

/** 定时任务打开「只出建议」时追加的要求 */
export function suggestPrompt(noChange: string, at = now()): string {
	const history = suggestionHistory(at);
	return [
		`这一轮只出建议，不写结论：查完之后，把值得 Yi 看一眼或动手的事写成 ${SUGGEST_MARK}，紧跟一个 JSON 数组，最多 ${MAX_PER_RUN} 条，宁缺毋滥：`,
		'```json\n[{"title": "一句话说是什么", "why": "为什么值得看：看到了什么、依据在哪", "ask": "Yi 采纳后交给助手做什么，写成能直接执行的一段要求", "link": "可选：对应的 MR、工单、告警、文档链接"}]\n```',
		`只用读的命令和工具，不要改任何东西。没有值得提的就只写「${noChange}」。建议之外不用写别的，cabinet 不会私聊这一轮的正文。`,
		history ? `最近的建议记录：\n${history}` : "",
	]
		.filter(Boolean)
		.join("\n\n");
}
