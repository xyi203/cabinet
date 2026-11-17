// OpenViking 客户端：Yi 本人的偏好、画像、打过交道的人，和 Claude Code 共用 viking://user/default/memories/。
// - 写：只送 Yi 自己的话（改稿意见、改后发出的、亲自回复的、「记住」的偏好），对方消息和草稿只作为一段背景，
//   commit 后由 OpenViking 自己判断写进哪个偏好或人物文件。这里的东西会注入到每个 Claude Code 会话，同事的原话不进来
// - 读：find 偏好与人物两棵子树的叶子文件
import { MEMORY } from "../config.ts";
import { markDown, markOk } from "./health.ts";

async function call<T>(method: string, path: string, body?: unknown, timeout = 30_000): Promise<T> {
	try {
		const res = await fetch(`${MEMORY.vikingUrl.replace(/\/$/, "")}/api/v1${path}`, {
			method,
			headers: body === undefined ? undefined : { "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(timeout),
		});
		const text = await res.text();
		if (!res.ok) throw new Error(`OpenViking ${method} ${path} ${res.status}：${text.slice(0, 200)}`);
		markOk("openviking");
		const json = text ? JSON.parse(text) : {};
		if (json.status && json.status !== "ok") throw new Error(`OpenViking ${method} ${path}：${text.slice(0, 200)}`);
		return json.result as T;
	} catch (e) {
		markDown("openviking", String((e as Error).message));
		throw e;
	}
}

export interface Note {
	uri: string;
	type: string;
	text: string;
	score: number;
}

// 只查偏好与人物两棵子树：events 是各个助手的会话流水、profile 是一整段画像，相关度分数挤在一起（实测 0.69–0.83），
// 混在一起查会把真正的偏好挤出去
const SUBTREES = ["preferences", "entities"];
const MAX_NOTE = 300;

export async function find(query: string, limit: number): Promise<Note[]> {
	const root = MEMORY.vikingRoot.replace(/\/?$/, "/");
	const found = await Promise.all(
		SUBTREES.map((type) =>
			call<{ memories?: Array<Record<string, any>> }>("POST", "/search/find", { query, target_uri: `${root}${type}/`, limit }).then((r) =>
				(r.memories ?? [])
					// level 1 是目录概览，只要叶子文件
					.filter((m) => m.level === 2 && m.abstract)
					.map((m) => ({ uri: String(m.uri), type, text: clip(String(m.abstract)), score: Number(m.score ?? 0) })),
			),
		),
	);
	return found
		.flat()
		.toSorted((a, b) => b.score - a.score)
		.slice(0, limit);
}

export interface NoteFile {
	uri: string;
	type: string;
	/** 子树里的相对路径，如 yi/沟通风格偏好.md */
	path: string;
	text: string;
	updated: string;
}

/** 看板列表：两棵子树下的全部叶子文件和正文。文件少（偏好按主题归并），逐个读 */
export async function listNotes(): Promise<NoteFile[]> {
	const root = MEMORY.vikingRoot.replace(/\/?$/, "/");
	const out: NoteFile[] = [];
	for (const type of SUBTREES) {
		const tree = await call<Array<Record<string, any>> | null>("GET", `/fs/tree?uri=${encodeURIComponent(`${root}${type}/`)}`);
		const files = (tree ?? []).filter(
			(f) => !f.isDir && String(f.rel_path).endsWith(".md") && !String(f.rel_path).split("/").at(-1)!.startsWith("."),
		);
		for (const f of files.slice(0, 50)) {
			const text = await call<string>("GET", `/content/read?uri=${encodeURIComponent(f.uri)}`);
			out.push({ uri: String(f.uri), type, path: String(f.rel_path), text: String(text ?? ""), updated: String(f.modTime ?? "") });
		}
	}
	return out;
}

const clip = (s: string) => (s.length > MAX_NOTE ? `${s.slice(0, MAX_NOTE)}…` : s);

export interface VikingMessage {
	role: "user" | "assistant";
	content: string;
	/** 秒 */
	at?: number;
}

/** 一批话送进一个新会话并提交；提取在 OpenViking 后台跑。同一个 id 重试时先删掉旧会话，消息不重复 */
export async function commit(id: string, messages: VikingMessage[]) {
	const sessionId = `cabinet-${id.replace(/[^\w-]/g, "-")}`;
	await call("DELETE", `/sessions/${sessionId}`).catch(() => undefined);
	await call("POST", "/sessions", { session_id: sessionId });
	await call("POST", `/sessions/${sessionId}/messages/batch`, {
		messages: messages.map((m) => ({
			role: m.role,
			content: m.content,
			...(m.at ? { created_at: new Date(m.at * 1000).toISOString() } : {}),
		})),
	});
	await call("POST", `/sessions/${sessionId}/commit`, {});
}
