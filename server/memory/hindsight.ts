// Hindsight 客户端：cabinet 的经验、事实与约定都在一个独立 bank 里。
// - 写：retain 一批材料，Hindsight 自己抽事实、合并成 observation；document_id 用来源（draft:<id> / qa:<id>），重试时整篇替换不重复
// - 读：recall 按作用域 tag 过滤（any_strict：没打 tag 的不出现）；约定是 directive，cabinet 自己按 tag 挑出来每轮都带
// - 作用域 tag：personal / person:<open_id> / chat:<chat_id>；directive 另带一个 `name:<显示名>`，看板与渲染用
import { MEMORY } from "../config.ts";
import { markDown, markOk } from "./health.ts";

const base = () => `${MEMORY.hindsightUrl.replace(/\/$/, "")}/v1/default/banks/${encodeURIComponent(MEMORY.bank)}`;

async function call<T>(method: string, path: string, body?: unknown, timeout = 30_000): Promise<T> {
	let res: Response;
	let text: string;
	try {
		res = await fetch(base() + path, {
			method,
			headers: body === undefined ? undefined : { "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(timeout),
		});
		text = await res.text();
	} catch (e) {
		markDown("hindsight", String((e as Error).message));
		throw e;
	}
	// 4xx 是请求的问题，服务本身是好的；只有连不上和 5xx 算挂了
	if (res.status >= 500) markDown("hindsight", `${method} ${path} ${res.status}`);
	else markOk("hindsight");
	if (!res.ok) throw new Error(`Hindsight ${method} ${path} ${res.status}：${text.slice(0, 200)}`);
	return (text ? JSON.parse(text) : undefined) as T;
}

const RETAIN_MISSION = `材料来自 Yi（向懿，后端开发）的飞书助理 cabinet：一条需要 Yi 回复的消息、助理的草稿、Yi 的修改与处理结果，或者一次问答里的工具调用结果；也可能是 Yi 亲口让助理记住的一句话。
只抽以后翻不到的东西：Yi 的回复习惯与偏好、和某个人或某个群打交道的方式、排查或试错后才得出的结论、文档没写的坑。
对方消息里的说法只是对方的说法，没有被 Yi 或工具结果证实就不要当成事实；助理草稿里的推测也一样。
当次的具体安排（「这次先不发」）、寒暄客套、代码与文档里随时能重新读到的内容不抽。不记凭证、口令、token。
用中文写，每条写清主语和场景（如「回复张三时…」「查订单支付失败时…」）。`;

const REFLECT_MISSION = `你在为 Yi（向懿）的飞书助理回答问题，依据是助理过去处理消息、排查问题时积累的经验与事实。
易变的事实（配置、版本、谁负责）注明是什么时候的记录，提醒先核对现状；记忆之间冲突时以较新的为准，并指出旧说法。`;

/** 建 bank 或把 mission 更新成代码里这一版；启动时调一次 */
export async function ensureBank() {
	await call("PUT", "", { retain_mission: RETAIN_MISSION, reflect_mission: REFLECT_MISSION });
}

export interface RetainItem {
	content: string;
	context: string;
	documentId: string;
	/** 秒 */
	at: number;
	tags: string[];
	metadata?: Record<string, string>;
}

export async function retain(items: RetainItem[], async = true) {
	await call(
		"POST",
		"/memories",
		{
			async,
			items: items.map((x) => ({
				content: x.content,
				context: x.context,
				document_id: x.documentId,
				timestamp: new Date(x.at * 1000).toISOString(),
				tags: x.tags,
				metadata: x.metadata,
			})),
		},
		async ? 30_000 : 180_000,
	);
}

export interface Fact {
	id: string;
	text: string;
	type: string;
	tags: string[];
	/** ISO 时间：事情发生或被提到的时候 */
	at?: string;
}

/** tags 为空表示不限作用域（看板和 memory 工具） */
export async function recall(query: string, tags: string[], maxTokens: number): Promise<Fact[]> {
	const r = await call<{ results: Array<Record<string, any>> }>("POST", "/memories/recall", {
		query,
		types: ["world", "experience", "observation"],
		prefer_observations: true,
		max_tokens: maxTokens,
		...(tags.length ? { tags, tags_match: "any_strict" } : {}),
	});
	return (r.results ?? []).map((x) => ({
		id: String(x.id),
		text: String(x.text ?? ""),
		type: String(x.type ?? ""),
		tags: Array.isArray(x.tags) ? x.tags : [],
		at: x.occurred_start ?? x.mentioned_at ?? undefined,
	}));
}

export async function reflect(query: string, tags: string[]): Promise<string> {
	const r = await call<{ text: string }>(
		"POST",
		"/reflect",
		{ query, budget: "mid", ...(tags.length ? { tags, tags_match: "any_strict" } : {}) },
		180_000,
	);
	return r.text ?? "";
}

// ---------- 约定（directive） ----------

export interface Directive {
	id: string;
	name: string;
	content: string;
	priority: number;
	is_active: boolean;
	tags: string[];
	created_at?: string;
	updated_at?: string;
}

export async function listDirectives(): Promise<Directive[]> {
	const r = await call<{ items: Directive[] }>("GET", "/directives?limit=500");
	return r.items ?? [];
}

export const createDirective = (d: Pick<Directive, "name" | "content" | "tags">) =>
	call<Directive>("POST", "/directives", { ...d, priority: 0, is_active: true });

export const updateDirective = (id: string, patch: Partial<Pick<Directive, "name" | "content" | "tags" | "is_active">>) =>
	call<Directive>("PATCH", `/directives/${encodeURIComponent(id)}`, patch);

export const deleteDirective = (id: string) => call<void>("DELETE", `/directives/${encodeURIComponent(id)}`);

export interface ListedMemory extends Fact {
	documentId?: string;
}

/** 看板列表：按时间倒序分页，q 是正文子串过滤（Hindsight 那边不走索引，量小无妨） */
export async function listMemories(opts: {
	q?: string;
	offset?: number;
	limit?: number;
}): Promise<{ items: ListedMemory[]; total: number }> {
	const params = new URLSearchParams({ limit: String(opts.limit ?? 50), offset: String(opts.offset ?? 0) });
	if (opts.q) params.set("q", opts.q);
	const r = await call<{ items: Array<Record<string, any>>; total: number }>("GET", `/memories/list?${params}`);
	return {
		total: r.total ?? 0,
		items: (r.items ?? []).map((x) => ({
			id: String(x.id),
			text: String(x.text ?? ""),
			type: String(x.fact_type ?? ""),
			tags: Array.isArray(x.tags) ? x.tags : [],
			at: x.occurred_start ?? x.mentioned_at ?? x.date ?? undefined,
			documentId: x.document_id ?? undefined,
		})),
	};
}

export const bankStats = () => call<Record<string, unknown>>("GET", "/stats", undefined, 10_000);
