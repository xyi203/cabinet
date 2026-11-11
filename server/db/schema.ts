import { blob, index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { AgentUi } from "../a2ui/surface.ts";

// 时间统一存 unix 秒（浮点），和 pi 会话日志、旧数据保持一致

/** 待 Yi 确认的代回复草稿。id 是机器人私聊给 Yi 的那条草稿消息的 message_id */
export const drafts = sqliteTable(
	"drafts",
	{
		id: text("id").primaryKey(),
		chatId: text("chat_id").notNull(),
		chatMode: text("chat_mode").notNull(), // p2p / group / meego
		chatName: text("chat_name").notNull().default(""),
		replyTo: text("reply_to").notNull(),
		threadId: text("thread_id"),
		senderId: text("sender_id").notNull().default(""),
		senderName: text("sender_name").notNull().default(""),
		text: text("text").notNull().default(""),
		/** 起草时补齐的上下文（被回复的消息、话题、对方紧挨着发的消息），给 Yi 和改写时用 */
		context: text("context").notNull().default(""),
		meego: text("meego", { mode: "json" }).$type<MeegoCard | null>(),
		agent: text("agent"),
		session: text("session"),
		route: text("route"),
		kind: text("kind").notNull().default("text"), // text / reaction / sticker
		draft: text("draft").notNull().default(""),
		note: text("note").notNull().default(""),
		report: text("report").notNull().default(""),
		status: text("status").notNull(), // pending noreply sending revising sent completed discarded expired replaced
		created: real("created").notNull(),
		/** 起草它的那次分派；改写出的新版本沿用 */
		routeId: integer("route_id"),
	},
	(t) => [index("drafts_chat").on(t.chatId, t.status)],
);

/** 每次处理的流水：问答、起草、发送、失败。看板任务和统计都从这里来 */
export const records = sqliteTable(
	"records",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		ts: real("ts").notNull(),
		kind: text("kind").notNull(), // qa / draft
		status: text("status").notNull(), // replied remembered drafted skipped failed sent discarded completed revised
		chatId: text("chat_id"),
		source: text("source"), // 起草：被回复的原消息；问答：提问消息
		dm: text("dm"),
		session: text("session"),
		agent: text("agent"),
		label: text("label"),
		seconds: real("seconds"),
		usage: text("usage", { mode: "json" }).$type<Usage | null>(),
		question: text("question"),
		answer: text("answer"),
		error: text("error"),
		reason: text("reason"),
		retry: text("retry", { mode: "json" }).$type<unknown>(),
	},
	(t) => [index("records_ts").on(t.ts), index("records_source").on(t.source)],
);

// ---------- 四段模型：trigger -> route -> action -> result（见 docs/pipeline.md） ----------

/** Trigger：渠道来的一条事件，过了程序规则（Fast Path）才落库；落库后不再改内容 */
export const triggers = sqliteTable(
	"triggers",
	{
		/** `${channel}:${渠道内 id}`，同一事件重复到达只记一次 */
		id: text("id").primaryKey(),
		channel: text("channel").notNull(), // lark（轮询 Yi 的私聊 / @Yi）、meego、bot（@机器人 / 私聊机器人）、board（看板派活）
		/** 事件流：同一个会话、话题、工作项下的事件，跨渠道关联靠它和 refs */
		thread: text("thread").notNull(),
		actorId: text("actor_id").notNull().default(""),
		actorName: text("actor_name").notNull().default(""),
		/** 是不是 Yi 本人发的：Yi 的话可以当指令，别人的只是数据 */
		owner: integer("owner", { mode: "boolean" }).notNull().default(false),
		text: text("text").notNull().default(""),
		url: text("url"),
		/** 正文里提到的其他事件流，比如 MR：gitlab:<项目>!<iid> */
		refs: text("refs", { mode: "json" }).$type<string[]>().notNull().default([]),
		at: real("at").notNull(),
		status: text("status").notNull(), // received routed skipped
		routeId: integer("route_id"),
	},
	(t) => [index("triggers_at").on(t.at), index("triggers_thread").on(t.thread)],
);

/** Route：一次分派的决定。几条 trigger 可以合成一批；agent 为空表示不处理（比如 Yi 已经亲自回了） */
export const routes = sqliteTable(
	"routes",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		triggers: text("triggers", { mode: "json" }).$type<string[]>().notNull(),
		agent: text("agent"),
		/** 怎么判的：MR 链接 / 分诊：<理由> / 兜底 / 草稿指令 / 跳过：<原因> */
		rule: text("rule").notNull(),
		session: text("session"),
		/** 分派时的附加信息（MR 项目和 iid）：接回时沿用这次分派要用 */
		info: text("info", { mode: "json" }).$type<Record<string, string>>().notNull().default({}),
		/** 产出的 action：draft（drafts.id）/ qa（提问消息 id）/ dev（dev_tasks.id）/ remember / command（操作已有的 action）/ none */
		actionKind: text("action_kind").notNull(),
		actionId: text("action_id"),
		at: real("at").notNull(),
		/** 这次分派属于哪件事（tasks.id）；remember、不处理的为空 */
		taskId: text("task_id"),
	},
	(t) => [index("routes_action").on(t.actionKind, t.actionId), index("routes_task").on(t.taskId)],
);

/**
 * Task：一件事（docs/router-worker.md §2）。一条消息、一批告警、一次定时运行、一个看板派活各是一件；
 * 同一话题 / 工作项 / MR 的后续消息、改写、追问、审批都挂在同一件上（routes.task_id）。
 * 草稿、agent 任务、审批仍在各自的表里，是这件事的产出；status / need 由 taskstore.ts 按产出推出来再存下，看板和归属判断都读它。
 */
export const tasks = sqliteTable(
	"tasks",
	{
		/** tsk-<时间><随机> */
		id: text("id").primaryKey(),
		title: text("title").notNull(),
		/** 第一条 trigger 的渠道：lark meego bot board alert cron */
		source: text("source").notNull(),
		/** 归属键：第一条 trigger 的 thread（lark:<chat>[#<话题>]、meego:<工作项>、alert:<chat>、cron:<定时任务>、board:<任务>） */
		thread: text("thread").notNull(),
		/** 正文提到的 MR（gitlab:<项目>!<iid>）：之后提到同一个 MR 的消息也归到这里 */
		refs: text("refs", { mode: "json" }).$type<string[]>().notNull().default([]),
		/** todo in_progress in_review blocked done cancelled */
		status: text("status").notNull(),
		/** 等 Yi 做什么：send 待发送 / approve 待审批 / read 看结论 / decide 要拍板 / retry 失败；只在 in_review、blocked 时有 */
		need: text("need"),
		created: real("created").notNull(),
		updated: real("updated").notNull(),
		/** 进入 done / cancelled 的时间；重开时清掉 */
		closed: real("closed"),
	},
	(t) => [index("tasks_thread").on(t.thread), index("tasks_updated").on(t.updated)],
);

/** Result：一个 action 的最终结果。只经 settle() 写入；effect 说这次结果影响到了哪里 */
export const results = sqliteTable(
	"results",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		actionKind: text("action_kind").notNull(),
		actionId: text("action_id"),
		routeId: integer("route_id"),
		outcome: text("outcome").notNull(), // sent discarded completed expired replied remembered pushed done failed
		effect: text("effect").notNull(), // internal：只在 cabinet 里 / bot：机器人对外说话 / local：改了本机的 worktree / outward：以 Yi 身份发出或推送
		/** 外部留下的痕迹：发出的消息 id、MR 链接 */
		ref: text("ref"),
		detail: text("detail"),
		at: real("at").notNull(),
	},
	(t) => [index("results_action").on(t.actionKind, t.actionId), index("results_at").on(t.at)],
);

/**
 * 订阅：事件流（话题、飞书项目工作项）或被引用的对象（MR）挂到一个 agent 会话上。
 * 之后同一事件流、或提到同一个 MR 的消息直接进这个会话（订阅直通），不再分诊；跨渠道接得上同一件事。
 */
export const subscriptions = sqliteTable(
	"subscriptions",
	{
		/** thread（lark:<chat>#<话题>、meego:<工作项>）或 ref（gitlab:<项目>!<iid>） */
		key: text("key").notNull(),
		agent: text("agent").notNull(),
		session: text("session").notNull(),
		/** 分派时的附加信息（MR 项目和 iid），直通时原样带上 */
		info: text("info", { mode: "json" }).$type<Record<string, string>>().notNull().default({}),
		routeId: integer("route_id"),
		updated: real("updated").notNull(),
	},
	(t) => [primaryKey({ columns: [t.key, t.session] }), index("subscriptions_updated").on(t.updated)],
);

/** 轮询已处理过的消息，重启后不重复起草 */
export const handled = sqliteTable("handled", {
	messageId: text("message_id").primaryKey(),
	at: real("at").notNull(),
});

export const kv = sqliteTable("kv", {
	key: text("key").primaryKey(),
	value: text("value", { mode: "json" }).$type<unknown>(),
});

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cost: number;
}

export interface MeegoCard {
	title: string;
	mention: boolean;
	commentId: string;
	simpleName: string;
	workItemType: string;
	workItemId: string;
	workItemTitle: string;
	url: string;
	senderName: string;
	senderId: string;
	/** 发评人的飞书 user_id，评论里 @ 他要用；取自通知卡片 */
	senderLarkId?: string;
	comment: string;
	projectKey?: string;
	notifiedAt?: string;
}

export type Draft = typeof drafts.$inferSelect;
export type RecordRow = typeof records.$inferSelect;

/**
 * agent 任务：Yi 直接交给某个 agent 的活，可以一直对话。
 * dev agent 的任务在独立 worktree 里改代码、本地提交，Yi 审核后才推送建 MR；其他 agent 只读，repo/branch/worktree 为空串。
 */
export const devTasks = sqliteTable("dev_tasks", {
	id: text("id").primaryKey(),
	agent: text("agent").notNull().default("dev"),
	/** 新建时选的模型和思考强度，为空则用 agent 配置 */
	model: text("model"),
	thinking: text("thinking"),
	/** 来源草稿（需求消息） */
	draftId: text("draft_id"),
	title: text("title").notNull(),
	request: text("request").notNull().default(""),
	context: text("context").notNull().default(""),
	instructions: text("instructions").notNull().default(""),
	repo: text("repo").notNull(),
	base: text("base").notNull(),
	branch: text("branch").notNull(),
	worktree: text("worktree").notNull(),
	status: text("status").notNull(), // running review failed pushing pushed discarded done
	summary: text("summary").notNull().default(""),
	error: text("error"),
	mrUrl: text("mr_url"),
	session: text("session"),
	runs: integer("runs").notNull().default(0),
	usage: text("usage", { mode: "json" }).$type<Usage | null>(),
	created: real("created").notNull(),
	updated: real("updated").notNull(),
	routeId: integer("route_id"),
	/** 每轮结束都私聊 Yi（定时任务、告警这类不是 Yi 在看板上派的活） */
	notify: integer("notify", { mode: "boolean" }).notNull().default(false),
	/** 看板「对话」页里和助手的聊天：不进任务看板和待你处理，不私聊卡片，不用点完成 */
	chat: integer("chat", { mode: "boolean" }).notNull().default(false),
	/** 从哪个需求任务（飞书工单）派出来的 */
	storyId: text("story_id"),
	/** 发布工单巡检的一轮：本轮正常就直接归档、不私聊；额度用完不换备用模型 */
	patrol: integer("patrol", { mode: "boolean" }).notNull().default(false),
	/** 最近一轮用 show_ui 交的结构化报告（A2UI v1.0 消息），看板按它渲染 summary；这一轮没交为空 */
	ui: text("ui", { mode: "json" }).$type<AgentUi | null>(),
});

/**
 * 需求任务：一张飞书工单（需求或缺陷）在 cabinet 里的进度。阶段只以这边为准，Yi 在看板上推，不看也不改飞书项目的节点；
 * 开发任务从这里派、发布工单由助手提（devops 发布工单关联飞书工单 ID，按这个对上）
 */
export const stories = sqliteTable("stories", {
	/** 飞书工单 ID（work_item_id） */
	id: text("id").primaryKey(),
	projectKey: text("project_key").notNull(),
	/** 工作项类型：story 需求、issue 缺陷，其余是自定义类型 */
	typeKey: text("type_key").notNull(),
	title: text("title").notNull(),
	url: text("url").notNull().default(""),
	/** dev 开发中 / test 测试中 / release 发布中 / done 发布完成 / dropped 不跟了 */
	stage: text("stage").notNull().default("dev"),
	/** 关联的发布工单（GD-*）：手动绑、提单后挂、按工单里的飞书工单 ID 对上；标题和状态刷新时从 devops 取 */
	tickets: text("tickets", { mode: "json" }).$type<StoryTicket[]>().notNull().default([]),
	note: text("note").notNull().default(""),
	created: real("created").notNull(),
	updated: real("updated").notNull(),
});

export interface StoryTicket {
	key: string;
	title: string;
	status: string;
	url?: string;
	/** auto 按工单里的飞书工单 ID 对上 / manual Yi 手动绑 / created 从需求提的单；老数据没有，当 auto */
	source?: "auto" | "manual" | "created";
	/** Yi 解绑了：留着记录，刷新时不再自动挂回来 */
	removed?: boolean;
	/** 工单走完流程或终止了，刷新不再查 */
	ended?: boolean;
	/** 生成发布观察文档的那个助手任务（文档链接在任务结论里） */
	doc?: { taskId: string };
	/** 巡检：首次观察任务 + 每 30 分钟一轮的定时任务；stopped 写了停止原因就是停了 */
	patrol?: { observeTaskId: string; scheduleId: string; started: number; stopped?: string };
	/** 已走到「prod 部署」（全量）这一步 */
	full?: boolean;
	/** 全量后巡检：全量后按 PATROL_FULL_MINUTES 各跑一轮的定时任务，跑完自动停 */
	fullPatrol?: { scheduleId: string; started: number; stopped?: string };
}

/** 定时任务（借鉴 multica 的 Autopilots）：到点交给一个只读 agent 跑一次，结论私聊给 Yi */
export const schedules = sqliteTable("schedules", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	/** 5 段 cron（分 时 日 月 周），本机时区 */
	cron: text("cron").notNull(),
	agent: text("agent").notNull(),
	prompt: text("prompt").notNull(),
	enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
	nextRun: real("next_run"),
	lastRun: real("last_run"),
	/** 最近一次跑出来的 agent 任务 */
	lastTask: text("last_task"),
	/** 跑这个任务用的模型和思考强度，为空用 agent 配置 */
	model: text("model"),
	thinking: text("thinking"),
	/** 过了这个时间（unix 秒）自动停用 */
	until: real("until"),
	/** 按时间点跑（unix 秒，升序），给了就不看 cron，cron 只当显示用的说明；跑完最后一个自动停用。全量后巡检用 */
	times: text("times", { mode: "json" }).$type<number[]>(),
	/** 发布工单巡检：派出的任务按巡检处理（见 dev_tasks.patrol） */
	patrol: integer("patrol", { mode: "boolean" }).notNull().default(false),
	created: real("created").notNull(),
	updated: real("updated").notNull(),
});

export type DevTask = typeof devTasks.$inferSelect;
export type Story = typeof stories.$inferSelect;
export type TriggerRow = typeof triggers.$inferSelect;
export type RouteRow = typeof routes.$inferSelect;
export type ResultRow = typeof results.$inferSelect;
export type Subscription = typeof subscriptions.$inferSelect;
export type Schedule = typeof schedules.$inferSelect;

// ---------- 长期记忆（借鉴 komo docs/memory.md §9） ----------

/** 记忆的依据：哪条消息、哪次工具调用、哪条草稿，quote 是原文片段 */
export interface Evidence {
	/** yi：Yi 自己说的话；tool：工具结果；board：Yi 在看板上写的；message：别人的消息、草稿、处理结果 */
	kind: "yi" | "tool" | "board" | "message";
	ref: string;
	quote: string;
	at: number;
}

/**
 * 一条记忆。kind 说内容是什么，provenance 说从哪来，confirmed 说 Yi 有没有复核过这一版，
 * application 说怎么用：convention 在 appliesWhen 成立时直接照做，reference 只是线索。
 * 改正文、用法、条件或作用域都升 revision，索引跟着重建。
 */
export const memories = sqliteTable(
	"memories",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		revision: integer("revision").notNull().default(1),
		content: text("content").notNull(),
		kind: text("kind").notNull(), // preference / fact / experience
		application: text("application").notNull().default("reference"), // convention / reference
		appliesWhen: text("applies_when").notNull().default(""),
		/** personal：处处适用；person:<open_id>：只在和这个人有关时；chat:<chat_id>：只在这个会话 */
		scope: text("scope").notNull().default("personal"),
		scopeName: text("scope_name").notNull().default(""),
		provenance: text("provenance").notNull(), // user_statement / tool_observation / model_inference
		confirmed: integer("confirmed", { mode: "boolean" }).notNull().default(false),
		state: text("state").notNull(), // candidate active contested superseded forgotten
		evidence: text("evidence", { mode: "json" }).$type<Evidence[]>().notNull().default([]),
		/** 互相矛盾、等 Yi 裁定的条目 */
		conflicts: text("conflicts", { mode: "json" }).$type<number[]>().notNull().default([]),
		supersededBy: integer("superseded_by"),
		/** 记下它的途径：remember / board / import / draft:<消息 id> / qa:<消息 id> */
		source: text("source").notNull().default(""),
		injected: integer("injected").notNull().default(0),
		lastInjected: real("last_injected"),
		created: real("created").notNull(),
		updated: real("updated").notNull(),
	},
	(t) => [index("memories_state").on(t.state, t.application)],
);

/** 关键词索引：terms 是首尾带空格的 token 串，查询用 instr(terms, ' tok ')（Turso 没有 FTS5） */
export const memoryTerms = sqliteTable("memory_terms", {
	memoryId: integer("memory_id").primaryKey(),
	revision: integer("revision").notNull(),
	terms: text("terms").notNull(),
});

/** 向量索引：Turso 的 vector32，按 model 区分向量空间，换模型后旧向量不再参与比较 */
export const memoryVectors = sqliteTable("memory_vectors", {
	memoryId: integer("memory_id").primaryKey(),
	revision: integer("revision").notNull(),
	model: text("model").notNull(),
	vec: blob("vec").notNull(),
});

export type MemoryRow = typeof memories.$inferSelect;

/** 写操作审批（docs/redesign.md 阶段 2）：agent 调写操作时守卫判成「要审批」，记一条、私聊 Yi 一张卡片，Yi 点执行才由 cabinet 执行 */
export const approvals = sqliteTable(
	"approvals",
	{
		id: text("id").primaryKey(),
		created: real("created").notNull(),
		/** pending / done（已执行）/ failed（执行出错）/ rejected / expired */
		status: text("status").notNull(),
		/** bash、mcp__<server>__<tool>、schedule */
		tool: text("tool").notNull(),
		args: text("args", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
		/** 守卫给的说明，例如「archery submit 是写操作」 */
		reason: text("reason").notNull().default(""),
		/** 是谁的消息、哪个任务引起的，给 Yi 看 */
		origin: text("origin").notNull().default(""),
		/** 发起审批的 durable 会话：执行时按它的权限策略复核 */
		convId: integer("conv_id"),
		cwd: text("cwd").notNull().default(""),
		/** 执行结果回到哪：agent 任务；或起草时被回复的那条消息（找到它的草稿再改写） */
		devTaskId: text("dev_task_id"),
		draftReplyTo: text("draft_reply_to"),
		/** 私聊 Yi 的审批卡片 */
		dm: text("dm"),
		result: text("result"),
		decided: real("decided"),
	},
	(t) => [index("approvals_status").on(t.status)],
);

export type Approval = typeof approvals.$inferSelect;

/** 每次 agent 运行（起草、改写、问答、agent 任务、巡检…）一条：统计页按它算趋势和按 agent / 档位 / 模型的拆分 */
export const runs = sqliteTable(
	"runs",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		ts: real("ts").notNull(),
		agent: text("agent"),
		/** assistant 的档位（ack / answer / deep / mr），agent 任务是 task */
		tier: text("tier"),
		/** 实际用的模型；额度用完换了备用模型的记备用模型。补录的老数据为空 */
		model: text("model"),
		request: text("request"),
		label: text("label"),
		seconds: real("seconds"),
		ok: integer("ok", { mode: "boolean" }).notNull().default(true),
		input: integer("input").notNull().default(0),
		output: integer("output").notNull().default(0),
		cacheRead: integer("cache_read").notNull().default(0),
		cost: real("cost").notNull().default(0),
	},
	(t) => [index("runs_ts").on(t.ts)],
);
