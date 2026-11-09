// 进程级配置：.env 由 node --env-file 载入。代码与运行数据分开，运行数据都在 DATA_DIR 下，不进 git。
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const env = (key: string, fallback = ""): string => process.env[key]?.trim() || fallback;
const expand = (p: string) => p.replace(/^~(?=$|\/)/, homedir());
const list = (key: string) =>
	env(key)
		.split(",")
		.map((x) => x.trim())
		.filter(Boolean);

export const ROOT = path.resolve(import.meta.dirname, "..");
export const CONFIG_DIR = path.join(ROOT, "config");
export const DATA_DIR = path.resolve(ROOT, expand(env("DATA_DIR", "data")));

export const FEISHU_APP_ID = env("FEISHU_APP_ID");
export const FEISHU_APP_SECRET = env("FEISHU_APP_SECRET");
export const BOT_OPEN_ID = env("BOT_OPEN_ID");
export const OWNER_OPEN_ID = env("OWNER_OPEN_ID");
export const OWNER_NAME = env("OWNER_NAME", "主人");

export const MEEGLE_BIN = expand(env("MEEGLE_BIN", "meegle"));
export const GLAB_BIN = expand(env("GLAB_BIN", "glab"));

export const PI_MODEL = env("PI_MODEL", "claude/claude-opus-5-5");
export const PI_THINKING = env("PI_THINKING", "medium");
// 主模型额度用完、限流或过载时换用的模型；留空则不切换
export const PI_FALLBACK_MODEL = env("PI_FALLBACK_MODEL", "codex/gpt-6.1-sol");
export const PI_TIMEOUT = Number(env("PI_TIMEOUT", "600"));
// agent 任务（首次发布观察、排查、开发）要跑多个 skill、查多处数据，10 分钟常常不够；起草、问答仍按 PI_TIMEOUT
export const TASK_TIMEOUT = Number(env("TASK_TIMEOUT", "1800"));
export const MAX_CONCURRENCY = Number(env("MAX_CONCURRENCY", "3"));
export const THREAD_CONTEXT_N = Number(env("THREAD_CONTEXT_N", "15"));
export const DEFAULT_CWD = expand(env("DEFAULT_CWD", "~"));

export const READ_ROOTS = [DEFAULT_CWD];

// 截图在 data/images 保留的天数；会话闲置超过这么多天，下次换新会话（旧会话里的长上下文和图片不再每轮重发）。0 = 不清理 / 不换
export const IMAGE_RETAIN_DAYS = Number(env("IMAGE_RETAIN_DAYS", "7"));
export const SESSION_IDLE_DAYS = Number(env("SESSION_IDLE_DAYS", "7"));
// 起草复用按聊天划分的会话，上下文会越滚越大（每次调用整段重发，缓存写入是大头）：上一轮结束时超过这么多 tokens 就换新会话。
// 前文、记忆每次起草都另外带上，换会话只丢掉旧的工具输出和截图。0 = 不换
export const SESSION_MAX_TOKENS = Number(env("SESSION_MAX_TOKENS", "50000"));
// Yi 正在会话里聊（触发消息前 YI_ACTIVE_WINDOW 秒内说过话）时先等最多 YI_ACTIVE_DELAY 秒再起草：多半他自己就回了。
// 等的期间每 YI_ACTIVE_CHECK 秒看一次，他回了消息或表情就提前结束（随后按跳过处理）。0 = 不等
export const YI_ACTIVE_WINDOW = Number(env("YI_ACTIVE_WINDOW", "300"));
export const YI_ACTIVE_DELAY = Number(env("YI_ACTIVE_DELAY", "20"));
export const YI_ACTIVE_CHECK = Number(env("YI_ACTIVE_CHECK", "5"));
// 私聊不管你在不在聊，都等到消息来了 P2P_WAIT 秒再起草；分诊成 deep 的等到 DEEP_WAIT 秒。
// 11-09 私聊 37 份草稿 27 份被你亲自回复作废（$3.4，占起草花费 93%）：你一半在 75 秒内回，deep 档多在 2~8 分钟
export const P2P_WAIT = Number(env("P2P_WAIT", "90"));
export const DEEP_WAIT = Number(env("DEEP_WAIT", "300"));
// 发布工单巡检：首次观察用 agent 默认模型（Opus），之后每轮用便宜些的模型、每轮新会话；最多巡检这么多天
export const PATROL_MODEL = env("PATROL_MODEL", "claude/claude-sonnet-5-5");
// 发布观察文档：照模板整理工单和变更，用不着 Opus；首次观察要建基线，仍用 agent 默认模型
export const DOC_MODEL = env("DOC_MODEL", "claude/claude-sonnet-5-5");
export const PATROL_CRON = env("PATROL_CRON", "*/30 * * * *");
export const PATROL_DAYS = Number(env("PATROL_DAYS", "3"));
// 全量后巡检：工单走到「prod 部署」后，在这些分钟各巡检一轮，跑完自动停（逗号分隔）
export const PATROL_FULL_MINUTES = env("PATROL_FULL_MINUTES", "5,15,30,60")
	.split(",")
	.map(Number)
	.filter((x) => x > 0)
	.toSorted((a, b) => a - b);
// 日报的文字总结用的模型（一天一次，几千 tokens）
export const JOURNAL_MODEL = env("JOURNAL_MODEL", "claude/claude-sonnet-5-5");
// Claude 订阅额度：每隔这么多分钟经 magpie 用这个模型发一个 1 token 的请求，读它转发的 anthropic-ratelimit-unified-* 响应头。0 = 不查
export const QUOTA_INTERVAL = Number(env("QUOTA_INTERVAL", "10"));
export const QUOTA_MODEL = env("QUOTA_MODEL", "claude/claude-haiku-5-5");
// 5 小时窗口用量到这个比例就暂停巡检（跳过这一轮），把额度留给起草
export const PATROL_PAUSE_AT = Number(env("PATROL_PAUSE_AT", "0.8"));

export const DRAFT_ENABLED = env("DRAFT_ENABLED", "1") === "1";
// 分层轮询：每 POLL_FAST 秒拉一次会话列表和最活跃的 POLL_HOT_N 个会话；其余会话和别的渠道（飞书项目）还是 POLL_INTERVAL 秒一次
export const POLL_INTERVAL = Number(env("POLL_INTERVAL", "30"));
export const POLL_FAST = Number(env("POLL_FAST", "5"));
export const POLL_HOT_N = Number(env("POLL_HOT_N", "5"));
export const POLL_TOP_N = Number(env("POLL_TOP_N", "15"));
export const DRAFT_SKIP_CHATS = new Set(list("DRAFT_SKIP_CHATS"));
// 告警：群里机器人 @Yi 的消息不起草回复，按群攒一批交给 alert agent（docs/pipeline.md §4）
export const ALERT_ENABLED = env("ALERT_ENABLED", "true") !== "false";
/** 只认这些机器人（发送者 id）；为空时任何机器人 @Yi 都算 */
export const ALERT_SENDERS = new Set(list("ALERT_SENDERS"));
/** 只认这些群里的告警；为空时任何群都算 */
export const ALERT_CHATS = new Set(list("ALERT_CHATS"));
/** 一批收口：这么多秒没有新告警，或者从第一条起满 ALERT_MAX_WAIT 秒 */
export const ALERT_QUIET = Number(env("ALERT_QUIET", "120"));
export const ALERT_MAX_WAIT = Number(env("ALERT_MAX_WAIT", "600"));
/** 同一个群这么多秒内又来告警，且上一批的任务还没归档：并进上一批，不另开 */
export const ALERT_FOLLOW = Number(env("ALERT_FOLLOW", "3600"));
export const ALERT_AGENT = env("ALERT_AGENT", "alert");
/** Watchdog 多少秒查一次 */
export const WATCHDOG_INTERVAL = Number(env("WATCHDOG_INTERVAL", "300"));
/** 订阅直通：话题 / 工作项 / MR 挂到会话上，这么多秒没再用到就失效（默认 3 天） */
export const SUBSCRIBE_TTL = Number(env("SUBSCRIBE_TTL", String(3 * 86400)));

export const PORT = Number(env("PORT", "10086"));
// 开发时页面由 vite（5173）提供并代理 /api，需要放行这个来源
export const DEV_ORIGIN = env("DEV_ORIGIN");

// 飞书用户授权的回调地址，必须和开发者后台「重定向 URL」一致；授权时临时监听这个端口
export const OAUTH_REDIRECT = env("OAUTH_REDIRECT", "http://127.0.0.1:9768/callback");

export const MEEGO_ENABLED = env("MEEGO_ENABLED", "1") === "1";
export const MEEGO_CHAT = env("MEEGO_CHAT");

// ~/.agents/skills 是维护中的那份；~/.pi/agent/skills 只是指过去的软链接，已有不少失效
export const SKILLS_DIR = expand(env("SKILLS_DIR", "~/.agents/skills"));
// MCP server 定义，沿用 pi 的 mcp.json；agent 在 agents.json 的 mcp 里选用（server/agent/mcp.ts）
export const MCP_CONFIG = expand(env("MCP_CONFIG", "~/.pi/agent/mcp.json"));

// 长期记忆：约定每次都带，线索按关键词 + 向量召回、过门槛才带；草稿反馈和工具结果自动提取
export const MEMORY = {
	enabled: env("MEMORY_ENABLED", "1") === "1",
	/** 提取与「记住」分类用的模型 */
	model: env("MEMORY_MODEL", PI_MODEL),
	/** Ollama 的 /api/embed；留空则只用关键词 */
	embedUrl: env("EMBED_URL", "http://127.0.0.1:11434"),
	embedModel: env("EMBED_MODEL", "qwen3-embedding:4b"),
	/** 只加在查询上；换前缀或模型要重新校准下面三个门槛 */
	queryPrefix: env("EMBED_QUERY_PREFIX", "Instruct: Given a chat message, retrieve memories relevant to replying to it\nQuery: "),
	/** 向量臂：余弦过它就留下（0 = 不启用） */
	minSimilarity: Number(env("MEMORY_MIN_SIMILARITY", "0.58")),
	/** 关键词臂：命中 token 的归一 IDF 之和过它就留下 */
	minKeyword: Number(env("MEMORY_MIN_KEYWORD", "1.0")),
	/** 只过关键词门槛的，向量跑了且余弦低于它就不算过（挡常用词凑分的误召回） */
	minKeywordCosine: Number(env("MEMORY_MIN_KEYWORD_COSINE", "0.45")),
	topK: Number(env("MEMORY_TOP_K", "8")),
	tokens: Number(env("MEMORY_TOKENS", "1500")),
	conventionTokens: Number(env("MEMORY_CONVENTION_TOKENS", "800")),
};

export const PATHS = {
	db: path.join(DATA_DIR, "cabinet.db"),
	/** pi-durable 的对话存储（会话、模型轮次、工具调用） */
	agentDb: path.join(DATA_DIR, "agents.sqlite"),
	sessions: path.join(DATA_DIR, "sessions"),
	/** 旧版记忆文件，启动时导入一次 */
	memory: path.join(DATA_DIR, "memory", "MEMORY.md"),
	stickers: path.join(DATA_DIR, "stickers"),
	/** 消息里的截图：起草时下载到这里，把路径给 agent 用 read 查看 */
	images: path.join(DATA_DIR, "images"),
	agents: path.join(CONFIG_DIR, "agents.json"),
	/** 路由规则（server/rules.ts），看板能改 */
	routes: path.join(CONFIG_DIR, "routes.json"),
	system: path.join(CONFIG_DIR, "system.md"),
	draftRules: path.join(CONFIG_DIR, "draft.md"),
	emojiTypes: path.join(CONFIG_DIR, "emoji_types.txt"),
	migrations: path.join(ROOT, "drizzle"),
	web: path.join(ROOT, "dist"),
};

export const EMOJI_TYPES = new Set(existsSync(PATHS.emojiTypes) ? readFileSync(PATHS.emojiTypes, "utf8").split(/\s+/).filter(Boolean) : []);
// 起草时推荐给模型、看板上放按钮的常用表情回复（Yi 飞书里「最常使用」）
export const COMMON_EMOJI = list("COMMON_EMOJI").length
	? list("COMMON_EMOJI")
	: ["OK", "CRY", "HUSKY", "Get", "YouAreTheBest", "BLACKFACE", "Yes", "THUMBSUP", "DONE", "FISTBUMP", "LOL", "No"];
// 飞书里「表情 赞」这类中文别名
export const EMOJI_ALIASES: Record<string, string> = {
	赞: "THUMBSUP",
	好的: "OK",
	收到: "Get",
	完成: "DONE",
	谢谢: "THANKS",
	加油: "MUSCLE",
	鼓掌: "APPLAUSE",
	"+1": "JIAYI",
	加一: "JIAYI",
	看: "OnIt",
	稍等: "OneSecond",
	送花: "YouAreTheBest",
	花: "YouAreTheBest",
	你最棒: "YouAreTheBest",
	玫瑰: "ROSE",
	搞定: "DONE",
	黑脸: "BLACKFACE",
	哈士奇: "HUSKY",
	笑哭: "LOL",
	感动: "CRY",
	捂嘴: "CRY",
	碰拳: "FISTBUMP",
	是: "Yes",
	不: "No",
};

export function missingConfig(): string[] {
	return ["FEISHU_APP_ID", "FEISHU_APP_SECRET", "BOT_OPEN_ID", "OWNER_OPEN_ID"].filter((k) => !env(k));
}
