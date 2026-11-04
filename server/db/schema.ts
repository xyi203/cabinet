import { blob, index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
	},
	(t) => [index("routes_action").on(t.actionKind, t.actionId)],
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
});

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
	created: real("created").notNull(),
	updated: real("updated").notNull(),
});

export type DevTask = typeof devTasks.$inferSelect;
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
