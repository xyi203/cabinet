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
	/** 起草这一版的 durable 会话：任务详情按它拉执行步骤 */
	session?: string | null;
	kind: "text" | "reaction" | "sticker";
	draft: string;
	note: string;
	report: string;
	status: string;
	created: number;
	/** MR 预审的草稿：对应的 MR 和已经做过的动作 */
	mr?: { project: string; iid: string; url: string; done: Array<"approve" | "note"> };
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
	chat?: boolean;
	/** 发布工单巡检的一轮 */
	patrol?: boolean;
	storyId?: string | null;
}

export interface StoryTicket {
	key: string;
	title: string;
	status: string;
	url?: string;
	/** auto 按工单里的飞书工单 ID 对上 / manual 手动绑 / created 从需求提的单 */
	source?: "auto" | "manual" | "created";
	/** 解绑了，不显示 */
	removed?: boolean;
	ended?: boolean;
	/** 生成发布观察文档的助手任务 */
	doc?: { taskId: string };
	/** 巡检：stopped 有值就是停了 */
	patrol?: { observeTaskId: string; scheduleId: string; started: number; stopped?: string };
}

/** 需求任务：一张飞书工单（需求 / 缺陷）的进度 */
export interface Story {
	id: string;
	projectKey: string;
	typeKey: string;
	title: string;
	url: string;
	stage: string;
	tickets: StoryTicket[];
	note: string;
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

export type TaskStatus = "todo" | "in_progress" | "in_review" | "blocked" | "done" | "cancelled";
/** 等 Yi 做什么：send 待发送 / approve 待审批 / read 看结论 / decide 要拍板 / retry 失败 */
export type Need = "send" | "approve" | "read" | "decide" | "retry";

export type TaskEvent =
	| { k: "msg"; at: number; who: string; owner: boolean; text: string; url?: string | null }
	| { k: "route"; at: number; rule: string; agent: string | null; tier?: string; kind: string }
	| { k: "result"; at: number; outcome: string; detail?: string | null; ref?: string | null };

/** 一件事（server/tasks.ts TaskView）：排队里的消息 id 是 q:<消息>，分派前就失败的是 fail-/qa-<消息>，记忆冲突是 mem:<id>，挂不上任务的审批是 apv:<id> */
export interface TaskView {
	id: string;
	title: string;
	/** lark meego bot board alert cron memory */
	source: string;
	label: string;
	status: TaskStatus;
	need: Need | null;
	worker?: string | null;
	tier?: string | null;
	created: number;
	updated: number;
	closed?: number | null;
	storyId?: string | null;
	scheduleId?: string | null;
	hold?: number;
	runId?: string;
	live?: string;
	result?: string;
	error?: string | null;
	retryId?: string;
	drafts: string[];
	devTasks: string[];
	approvals: string[];
	memories?: number[];
	events: TaskEvent[];
}

/** 待审批的写操作；command 是给人看的命令原文，learn 是「执行并以后放行」会记进规则的那条 */
export interface ApprovalView {
	id: string;
	created: number;
	tool: string;
	reason: string;
	origin: string;
	command: string;
	learn?: string;
	devTaskId?: string | null;
	draftReplyTo?: string | null;
}

export interface Issue {
	key: string;
	title: string;
	detail: string;
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
		/** 等 Yi 的件数（in_review + blocked） */
		waiting: number;
		usage: Usage;
	};
	running: number;
	inflight: number;
	drafts: Draft[];
	devTasks: DevTask[];
	/** 对话页里和助手的聊天（底层也是 agent 任务） */
	chats: DevTask[];
	stories: Story[];
	agents: AgentStat[];
	records: RecordRow[];
	items: TaskView[];
	approvals: ApprovalView[];
	/** Watchdog 发现、还没恢复的问题 */
	issues: Issue[];
	/** Claude 订阅额度（经 magpie 响应头查到的）；没查到过为 null */
	quota?: Quota | null;
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
	const send = async () =>
		fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Cabinet-Token": await getToken() },
			body: JSON.stringify(body),
		});
	let res = await send();
	// 后端每次启动换一个 token：页面还拿着旧的时第一次写操作会被拒（403，请求没有执行），换新 token 重试一次
	if (res.status === 403) {
		token = undefined;
		res = await send();
	}
	const data = await res.json().catch(() => ({}));
	if (res.status === 403) {
		token = undefined;
		throw new Error("看板和后台的连接过期了，刷新页面再试");
	}
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
export const memoryAction = (
	m: Memory,
	action: "confirm" | "forget" | "restore" | "classify" | "edit",
	extra: Partial<Classification> & { content?: string } = {},
) => post(`/api/memory/${m.id}/${action}`, { revision: m.revision, ...extra });
/** 裁定一组冲突：最终文字落在 keep 那条上，其余转为已取代 */
export const resolveMemories = (keep: number, items: Memory[], content: string) =>
	post("/api/memory/resolve", { keep, content, items: items.map((m) => ({ id: m.id, revision: m.revision })) });
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
	/** 对话页的聊天 */
	chat?: boolean;
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
	model?: string | null;
	/** 到这个时间自动停（巡检用） */
	until?: number | null;
	/** 发布工单巡检建的定时任务 */
	patrol?: boolean;
}
export const fetchSchedules = () => getJson<{ items: Schedule[] }>("/api/schedules").then((d) => d.items);
/** 定时任务的一次运行（server/schedules.ts scheduleRuns） */
export interface ScheduleRun {
	at: number;
	outcome: "conclusion" | "quiet" | "failed" | "running" | "skipped";
	label: string;
	brief: string;
	detail: string;
	taskId: string | null;
	devId: string | null;
	waiting: boolean;
	cost: number | null;
	seconds: number | null;
}
export const fetchScheduleRuns = (id: string) =>
	getJson<{ items: ScheduleRun[] }>(`/api/schedules/${encodeURIComponent(id)}/runs`).then((d) => d.items);
export const saveSchedule = (s: Partial<Schedule> & Pick<Schedule, "name" | "cron" | "agent" | "prompt">) =>
	post<{ item: Schedule }>("/api/schedules", s).then((d) => d.item);
export const runSchedule = (id: string) => post<{ task: string }>(`/api/schedules/${id}/run`).then((d) => d.task);
export const deleteSchedule = (id: string) => post(`/api/schedules/${id}/delete`);

export interface QuotaWindow {
	/** 0~1 */
	utilization: number;
	resetsAt: number;
}
export interface Quota {
	at: number;
	windows: Record<string, QuotaWindow>;
	error?: string;
}

export type StatsRange = "today" | "7d" | "30d";
export interface StatsBucket {
	t: number;
	label: string;
	runs: number;
	failed: number;
	cost: number;
	tokens: number;
}
export interface StatsGroup {
	name: string;
	runs: number;
	failed: number;
	cost: number;
	tokens: number;
	seconds: number;
}
export interface Stats {
	range: StatsRange;
	series: StatsBucket[];
	total: { runs: number; failed: number; cost: number; tokens: number };
	byAgent: StatsGroup[];
	byTier: StatsGroup[];
	byModel: StatsGroup[];
	drafts: Array<{ status: string; name: string; count: number }>;
	/** 草稿用上（发了、标记完成）占已有结果的比例 */
	hitRate: number | null;
}
export const fetchStats = (range: StatsRange) => getJson<Stats>(`/api/stats?range=${range}`);

export interface DispatchSuspect {
	key: string;
	title: string;
	detail: string;
	action?: { kind: "stop" | "retry" | "open"; ref: string };
}
export interface DispatchRoute {
	id: number;
	received: number | null;
	routed: number;
	settled: number | null;
	channel: string;
	actor: string;
	text: string;
	agent: string | null;
	tier: string | null;
	rule: string;
	actionKind: string;
	outcome: string | null;
}
export interface DispatchState {
	now: number;
	queue: { capacity: number; free: number; waiting: number };
	running: Array<{ key: string; label: string; agent: string | null; chatId: string | null; started: number; suspicious: boolean }>;
	inflight: Array<{ id: string; label: string; text: string; since: number; waitUntil: number | null }>;
	suspects: DispatchSuspect[];
	routes: DispatchRoute[];
}
export const fetchDispatch = () => getJson<DispatchState>("/api/dispatch");

export interface PromptFile {
	path: string;
	name: string;
	usedBy: string;
	json: boolean;
	updated: number;
	dirty: boolean;
}
export const fetchPrompts = () => getJson<{ items: PromptFile[] }>("/api/prompts").then((d) => d.items);
export const fetchPrompt = (path: string) =>
	getJson<{ content: string; head: string | null }>(`/api/prompts/file?path=${encodeURIComponent(path)}`);
export const fetchPromptHistory = (path: string) =>
	getJson<{ items: Array<{ rev: string; at: number; subject: string }> }>(`/api/prompts/history?path=${encodeURIComponent(path)}`).then(
		(d) => d.items,
	);
export const fetchPromptVersion = (path: string, rev: string) =>
	getJson<{ content: string }>(`/api/prompts/version?path=${encodeURIComponent(path)}&rev=${rev}`).then((d) => d.content);

export interface SkillView {
	name: string;
	desc: string;
	broken: boolean;
	hidden: boolean;
	agents: string[];
	rules: Array<{ name: string; read: string[]; write: string[]; deny: string[] }>;
}
export const fetchSkills = () => getJson<{ items: SkillView[] }>("/api/skills").then((d) => d.items);
export const fetchSkillDoc = (name: string) =>
	getJson<{ text: string }>(`/api/skills/doc?name=${encodeURIComponent(name)}`).then((d) => d.text);

export type AudienceLevel = "trusted" | "normal" | "careful";
export interface Audience {
	id: string;
	kind: "person" | "chat";
	name: string;
	level: AudienceLevel;
	note: string;
	updated: number;
}
export interface AudienceData {
	items: Audience[];
	candidates: Array<{ id: string; kind: "person" | "chat"; name: string; n: number }>;
	levels: Record<AudienceLevel, { name: string; prompt: string }>;
}
export const fetchAudience = () => getJson<AudienceData>("/api/audience");

export interface Journal {
	date: string;
	markdown: string;
	summary: { text: string; at: number; model: string } | null;
}
export const fetchJournal = (date: string) => getJson<Journal>(`/api/journal?date=${date}`);

/** 立即拉取新消息；带消息 id 时，这条如果在「你在聊，等一会儿再起草」就不等了 */
export const pollNow = (id?: string) => post<{ skipped: boolean }>("/api/poll", id ? { id } : {});

/** 路由规则（server/rules.ts）：config/routes.json，没写的项是默认值 */
export interface RouteRules {
	reopen: number;
	yiActive: { window: number; delay: number; check: number };
	alert: { quiet: number; maxWait: number; follow: number; senders: string[]; chats: string[] };
	cron: { patrolPauseAt: number };
}
export const fetchRoutes = () => getJson<{ rules: RouteRules; defaults: RouteRules }>("/api/routes");
export const saveRoutes = (r: RouteRules) => post<{ rules: RouteRules }>("/api/routes/save", r).then((d) => d.rules);
