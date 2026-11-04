// 看板接口。写操作要带后端下发的 token（同源才能读到），见 server/api.ts
export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cost: number;
}

export interface Draft {
	id: string;
	chatId: string;
	chatMode: string;
	chatName: string;
	replyTo: string;
	senderName: string;
	text: string;
	/** 起草时补齐的相关前文 */
	context: string;
	meego: { url: string } | null;
	agent: string | null;
	route: string | null;
	kind: "text" | "reaction" | "sticker";
	draft: string;
	note: string;
	report: string;
	status: string;
	created: number;
}

export interface RecordRow {
	id: number;
	ts: number;
	kind: string;
	status: string;
	label: string | null;
	seconds: number | null;
	usage: Usage | null;
	question: string | null;
	answer: string | null;
	error: string | null;
}

export interface AgentStat {
	name: string;
	desc: string;
	model: string;
	thinking: string;
	manual: boolean;
	readOnly: boolean;
	running: Array<{ label: string; started: number }>;
	runs: number;
	failed: number;
	cost: number;
}

export interface DevTask {
	id: string;
	agent: string;
	model: string | null;
	thinking: string | null;
	draftId: string | null;
	title: string;
	request: string;
	context: string;
	instructions: string;
	repo: string;
	base: string;
	branch: string;
	worktree: string;
	status: string;
	summary: string;
	error: string | null;
	mrUrl: string | null;
	session: string | null;
	runs: number;
	usage: Usage | null;
	created: number;
	updated: number;
}

export interface DevDiff {
	commits: string;
	stat: string;
	diff: string;
	uncommitted: string;
}

export interface Task {
	id: string;
	type: "draft" | "qa" | "dev";
	status: string;
	sub: string;
	title: string;
	label: string;
	chatMode?: string | null;
	created: number;
	session?: string | null;
	start?: number;
	end?: number;
	seconds?: number | null;
	usage?: Usage | null;
	draft?: string;
	agent?: string | null;
	route?: string | null;
	error?: string | null;
	answer?: string | null;
	retryable?: boolean;
	runId?: string;
	dev?: string;
}

export interface State {
	now: number;
	stats: {
		requests: number;
		replied: number;
		drafted: number;
		sent: number;
		discarded: number;
		failed: number;
		pending: number;
		usage: Usage;
	};
	running: number;
	inflight: number;
	drafts: Draft[];
	devTasks: DevTask[];
	agents: AgentStat[];
	records: RecordRow[];
	tasks: Task[];
	auth: { authorized: boolean; refreshExpiresAt?: number };
	pollSince: number | null;
}

export interface Step {
	t: number;
	kind: "call" | "text";
	tool?: string;
	args?: any;
	text?: string;
	result?: string;
	error?: boolean;
	done?: number;
	callId?: string;
}

async function getJson<T>(url: string): Promise<T> {
	const res = await fetch(url, { cache: "no-store" });
	if (!res.ok) throw new Error(`${res.status}`);
	return res.json();
}

let token: Promise<string> | undefined;
const getToken = () => (token ??= getJson<{ token: string }>("/api/session").then((d) => d.token));

export async function post<T = any>(url: string, body: unknown = {}): Promise<T> {
	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json", "X-Cabinet-Token": await getToken() },
		body: JSON.stringify(body),
	});
	const data = await res.json().catch(() => ({}));
	if (res.status === 403) token = undefined; // 后端重启后 token 会变
	if (!res.ok) throw new Error(data.error ?? `失败（${res.status}）`);
	return data;
}

export const fetchState = () => getJson<State>("/api/state");
export const fetchStickers = () => getJson<{ stickers: string[]; emoji: string[] }>("/api/stickers");
export const fetchMemory = () => getJson<{ text: string }>("/api/memory");
export const fetchLog = (t: Pick<Task, "session" | "start" | "end">) =>
	getJson<{ steps: Step[] }>(
		`/api/log?${new URLSearchParams({ session: t.session ?? "", start: String(t.start ?? ""), end: String(t.end ?? "") })}`,
	).then((d) => d.steps);
export const fetchRepos = () => getJson<{ repos: string[] }>("/api/repos").then((d) => d.repos);
export const fetchDevDiff = (id: string) => getJson<DevDiff>(`/api/dev/${id}/diff`);

export interface TranscriptItem {
	kind: "user" | "assistant" | "tool";
	t: number;
	text?: string;
	tool?: string;
	args?: any;
	result?: string;
	error?: boolean;
	done?: number;
}

export const fetchDevTranscript = (id: string) => getJson<{ items: TranscriptItem[] }>(`/api/dev/${id}/transcript`).then((d) => d.items);

export const createAgentTask = (input: {
	agent: string;
	request: string;
	repo?: string;
	branch?: string;
	model?: string;
	thinking?: string;
}) => post<{ task: DevTask }>("/api/agent-tasks", input).then((d) => d.task);

export interface ModelOption {
	id: string;
	name: string;
	levels: string[];
}

export const fetchModels = () => getJson<{ models: ModelOption[] }>("/api/models").then((d) => d.models);
