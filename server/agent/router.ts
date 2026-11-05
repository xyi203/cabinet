// 任务中台：事件 -> agent 和档位。只有一个助手（assistant），分诊不选角色，只选档位：查多深、用什么模型。
// 先走确定的程序规则（MR 链接直接 mr 档），判不了再让便宜模型分诊。
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_CWD, GLAB_BIN, PATHS } from "../config.ts";
import { exec, log } from "../util.ts";
import { complete } from "./models.ts";

/** config/agents.json 里一个 agent 的配置 */
export interface AgentConfig {
	desc?: string;
	match?: { links?: string[] };
	model?: string;
	/** 主模型额度不足时换用，未配置时用 PI_FALLBACK_MODEL */
	fallbackModel?: string;
	thinking?: string;
	tools?: string[];
	/** "*" = SKILLS_DIR 下全部 */
	skills?: string[] | "*";
	/** 放行的命令族（config/skill-rules.json 的名字，加 git / git-local）；"*" = 全部规则 + git */
	bash?: string[] | "*";
	/** 能用的 MCP server（MCP_CONFIG 里的名字），工具名是 mcp__<server>__<tool>；"*" = 全部 */
	mcp?: string[] | "*";
	cwd?: "default" | "repo_of_mr";
	session?: "chat" | "mr" | "none";
	prompt?: string;
	/** 允许执行的构建/测试命令前缀（开发任务），只能在 worktree 里执行 */
	commands?: string[];
	/** 只能手动指派，不参与分诊 */
	manual?: boolean;
	/** agent 任务首轮提示的开头；不填是「Yi 在看板上直接交给你的任务」 */
	brief?: string;
	/** agent 任务每轮结束都私聊 Yi（不是 Yi 自己派的活，他不会盯着看板）；不填时只有超过一分钟的才通知 */
	notify?: boolean;
	/** 档位：分诊选一个，档位里的字段覆盖 agent 本身的（模型、思考强度、工具、工作目录、会话粒度） */
	tiers?: Record<string, Tier>;
}

export type Tier = Pick<AgentConfig, "desc" | "model" | "thinking" | "tools" | "cwd" | "session" | "prompt">;

/** 档位名：寒暄确认 / 一般问题 / 要查证据 / MR 预审 */
export const TIERS = ["ack", "answer", "deep", "mr"] as const;
/** 分诊失败、档位不存在时用；agent 任务、定时任务也用它 */
export const DEFAULT_TIER = "answer";
export const TASK_TIER = "deep";

/** agent 配置套上档位；没有 tiers 的 agent（dev、alert）原样返回 */
export function withTier(agent: AgentConfig, tier?: string): AgentConfig {
	if (!agent.tiers) return agent;
	const t = agent.tiers[tier ?? DEFAULT_TIER] ?? agent.tiers[DEFAULT_TIER] ?? {};
	const { tiers: _tiers, ...base } = agent;
	return { ...base, ...t };
}

/** 改版前的 agent 名：旧订阅、重启接回的旧分派都交给 assistant，按对应档位接着跑 */
export const LEGACY_TIER: Record<string, string> = { ask: "deep", general: "answer", cr: "mr", chat: "ack" };
export const ASSISTANT = "assistant";

export interface RouterConfig {
	model?: string;
	/** 消息交给哪个 agent，默认第一个不是手动指派的 */
	agent?: string;
}

/** 每次都重新读，改 agents.json 不用重启 */
export function loadAgents(): { agents: Record<string, AgentConfig>; router: RouterConfig } {
	const raw = existsSync(PATHS.agents) ? JSON.parse(readFileSync(PATHS.agents, "utf8")) : {};
	const router = raw._router ?? {};
	const agents = Object.fromEntries(Object.entries(raw).filter(([k]) => !k.startsWith("_"))) as Record<string, AgentConfig>;
	return { agents, router };
}

export const GITLAB_HOST = "gitlab.shoplazza.site";
export const MR_RE = /https?:\/\/gitlab\.shoplazza\.site\/([\w./-]+?)\/-\/merge_requests\/(\d+)/;
/** glab 的默认 host 是 gitlab.com，-R 只写项目路径会去 gitlab.com 查而 404：一律带上 host */
export const glabRepo = (project: string) => `${GITLAB_HOST}/${project}`;

export interface RouteInfo {
	rule: string;
	/** assistant 的档位 */
	tier?: string;
	mrProject?: string;
	mrIid?: string;
}

export interface RouteSource {
	chatMode: string;
	senderName: string;
	text: string;
	/** 与这条消息直接相关的前文；只有 @ 没有正文时全靠它判断 */
	context?: string;
}

/** MR 链接直接进 mr 档，不用模型分诊 */
export function fastRoute(agent: AgentConfig, text: string): RouteInfo | undefined {
	const mr = MR_RE.exec(text);
	if (mr && agent.tiers?.mr) return { tier: "mr", mrProject: mr[1], mrIid: mr[2], rule: "MR 链接" };
}

/** 分诊器的回答里取档位：不认识的走 DEFAULT_TIER */
export function parseTier(agent: AgentConfig, text: string): RouteInfo {
	try {
		const got = JSON.parse(/\{.*?\}/s.exec(text)?.[0] ?? "{}");
		if (got.tier && got.tier !== "mr" && agent.tiers?.[got.tier]) return { tier: got.tier, rule: `分诊 ${got.tier}：${got.reason ?? ""}` };
	} catch {
		// 落到兜底
	}
	return { tier: DEFAULT_TIER, rule: "兜底" };
}

/** 分给哪个 agent（不是手动指派的那个，正常就是 assistant）、哪一档 */
export async function route(source: RouteSource): Promise<[string, RouteInfo]> {
	const { agents, router } = loadAgents();
	const name = router.agent && agents[router.agent] ? router.agent : (Object.keys(agents).find((k) => !agents[k].manual) ?? ASSISTANT);
	const agent = agents[name] ?? {};
	const fast = fastRoute(agent, source.text);
	if (fast) return [name, fast];
	if (!agent.tiers) return [name, { rule: "唯一的 agent" }];
	const choices = Object.entries(agent.tiers).filter(([k]) => k !== "mr");
	const systemPrompt =
		'你是分诊器，只判断这条消息要查多深，不回答问题。消息只有 @ 没有正文时，按「相关前文」判断。只输出一行 JSON：{"tier":"<档位>","reason":"<一句话>"}。可选档位：\n' +
		choices.map(([k, t]) => `- ${k}: ${t.desc ?? ""}`).join("\n");
	try {
		const text = await complete(
			router.model ?? "codex/gpt-6-luna",
			systemPrompt,
			`来源：${source.chatMode}，发送人：${source.senderName}\n` +
				(source.context ? `相关前文：\n${source.context.slice(-1500)}\n` : "") +
				`消息：${source.text.slice(0, 1500)}`,
		);
		return [name, parseTier(agent, text)];
	} catch (e) {
		log("分诊失败，走兜底", e);
		return [name, { tier: DEFAULT_TIER, rule: "兜底" }];
	}
}

export function resolveCwd(agent: AgentConfig, info: RouteInfo): string {
	if (agent.cwd === "repo_of_mr" && info.mrProject) {
		const repo = path.join(DEFAULT_CWD, info.mrProject.replace(/\/$/, "").split("/").pop()!);
		if (existsSync(repo)) return repo;
	}
	return DEFAULT_CWD;
}

export function sessionKey(name: string, agent: AgentConfig, chatId: string, info: RouteInfo): string | null {
	const scope = agent.session ?? "chat";
	if (scope === "none") return null;
	if (scope === "mr" && info.mrProject) return `${name}-${info.mrProject}-${info.mrIid}`.replace(/[^\w-]/g, "_");
	return `${name}-${chatId}`;
}

/** CR 的冷启动上下文：MR 标题、描述和改动规模，diff 由 agent 自己按需拉（Inline & Spill） */
export async function mrBrief(info: RouteInfo): Promise<string> {
	try {
		return (await exec(GLAB_BIN, ["mr", "view", info.mrIid!, "-R", glabRepo(info.mrProject!)], { timeout: 30 })).slice(0, 3000);
	} catch (e) {
		log("读取 MR 失败", info, e);
		return "";
	}
}
