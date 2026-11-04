// 任务中台：事件 -> agent。先走确定的程序规则（Fast Path），判不了再让便宜模型分诊（Slow Path）。
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
	skills?: string[];
	bash?: string[];
	cwd?: "default" | "repo_of_mr";
	session?: "chat" | "mr" | "none";
	prompt?: string;
	/** 允许执行的构建/测试命令前缀（开发任务），只能在 worktree 里执行 */
	commands?: string[];
	/** 只能手动指派，不参与分诊 */
	manual?: boolean;
}

export interface RouterConfig {
	model?: string;
	fallback?: string;
}

/** 每次都重新读，改 agents.json 不用重启 */
export function loadAgents(): { agents: Record<string, AgentConfig>; router: RouterConfig } {
	const raw = existsSync(PATHS.agents) ? JSON.parse(readFileSync(PATHS.agents, "utf8")) : {};
	const router = raw._router ?? {};
	const agents = Object.fromEntries(Object.entries(raw).filter(([k]) => !k.startsWith("_"))) as Record<string, AgentConfig>;
	return { agents, router };
}

export const MR_RE = /https?:\/\/gitlab\.shoplazza\.site\/([\w./-]+?)\/-\/merge_requests\/(\d+)/;

export interface RouteInfo {
	rule: string;
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

export function fastRoute(agents: Record<string, AgentConfig>, text: string): [string, RouteInfo] | undefined {
	const mr = MR_RE.exec(text);
	if (!mr) return;
	for (const [name, a] of Object.entries(agents)) {
		if (a.match?.links?.includes("gitlab_mr")) return [name, { mrProject: mr[1], mrIid: mr[2], rule: "MR 链接" }];
	}
}

export async function route(source: RouteSource): Promise<[string, RouteInfo]> {
	const { agents: all, router } = loadAgents();
	// 手动指派的 agent（如开发任务）不参与分诊
	const agents = Object.fromEntries(Object.entries(all).filter(([, a]) => !a.manual));
	const fallback = router.fallback && agents[router.fallback] ? router.fallback : (Object.keys(agents)[0] ?? "general");
	const fast = fastRoute(agents, source.text);
	if (fast) return fast;
	const systemPrompt =
		'你是任务中台的分诊器，只负责把消息交给合适的 agent，不回答问题。消息只有 @ 没有正文时，按「相关前文」的内容判断。只输出一行 JSON：{"agent":"<名字>","reason":"<一句话>"}。可选 agent：\n' +
		Object.entries(agents)
			.map(([k, a]) => `- ${k}: ${a.desc ?? ""}`)
			.join("\n");
	try {
		const text = await complete(
			router.model ?? "codex/gpt-6-luna",
			systemPrompt,
			`来源：${source.chatMode}，发送人：${source.senderName}\n` +
				(source.context ? `相关前文：\n${source.context.slice(-1500)}\n` : "") +
				`消息：${source.text.slice(0, 1500)}`,
		);
		const got = JSON.parse(/\{.*?\}/s.exec(text)?.[0] ?? "{}");
		if (got.agent && agents[got.agent]) return [got.agent, { rule: `分诊：${got.reason ?? ""}` }];
	} catch (e) {
		log("分诊失败，走兜底", e);
	}
	return [fallback, { rule: "兜底" }];
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
		return (await exec(GLAB_BIN, ["mr", "view", info.mrIid!, "-R", info.mrProject!], { timeout: 30 })).slice(0, 3000);
	} catch (e) {
		log("读取 MR 失败", info, e);
		return "";
	}
}
