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

/** 待你处理：服务端按急缓排好（server/tasks.ts buildInbox） */
export interface InboxItem {
	kind: "draft" | "failure" | "dev" | "memory" | "watch" | "approval";
	ref: string;
	level: "now" | "soon" | "later";
	why: string;
	title: string;
	label: string;
	at: number;
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
	inbox: InboxItem[];
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
export interface Evidence {
	kind: "yi" | "tool" | "board" | "message";
	ref: string;
	quote: string;
	at: number;
}

export interface Memory {
	id: number;
	revision: number;
	content: string;
	kind: "preference" | "fact" | "experience";
	application: "convention" | "reference";
	appliesWhen: string;
	scope: string;
	scopeName: string;
	provenance: "user_statement" | "tool_observation" | "model_inference";
	confirmed: boolean;
	state: "candidate" | "active" | "contested" | "superseded" | "forgotten";
	evidence: Evidence[];
	conflicts: number[];
	supersededBy: number | null;
	source: string;
	injected: number;
	lastInjected: number | null;
	created: number;
	updated: number;
}

export interface ArmScore {
	id: number;
	keyword?: number;
	vector?: number;
	passed: "keyword" | "vector" | "both" | null;
}

export interface MemoryState {
	items: Memory[];
	vectors: { model: string; total: number; pending: number; retryIn?: number };
}

export interface Classification {
	kind: Memory["kind"];
	application: Memory["application"];
	appliesWhen: string;
}

export const fetchMemory = () => getJson<MemoryState>("/api/memory");
export const searchMemory = (q: string) =>
	getJson<{ ids: number[]; scores: ArmScore[]; degraded?: string }>(`/api/memory/search?${new URLSearchParams({ q })}`);
export const addMemory = (input: Classification & { content: string }) => post("/api/memory", input);
export const memoryAction = (m: Memory, action: "confirm" | "forget" | "restore" | "classify", extra: Partial<Classification> = {}) =>
	post(`/api/memory/${m.id}/${action}`, { revision: m.revision, ...extra });
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
	/** 工具结果里的图片（data URL）、文字里提到的本地截图（/api/images/…） */
	images?: string[];
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

export interface Schedule {
	id: string;
	name: string;
	cron: string;
	agent: string;
	prompt: string;
	enabled: boolean;
	nextRun: number | null;
	lastRun: number | null;
	lastTask: string | null;
}
export const fetchSchedules = () => getJson<{ items: Schedule[] }>("/api/schedules").then((d) => d.items);
export const saveSchedule = (s: Partial<Schedule> & Pick<Schedule, "name" | "cron" | "agent" | "prompt">) =>
	post<{ item: Schedule }>("/api/schedules", s).then((d) => d.item);
export const runSchedule = (id: string) => post<{ task: string }>(`/api/schedules/${id}/run`).then((d) => d.task);
export const deleteSchedule = (id: string) => post(`/api/schedules/${id}/delete`);
