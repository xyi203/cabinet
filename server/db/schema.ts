import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
});

export type DevTask = typeof devTasks.$inferSelect;
