// 提示词页：config/ 下给 agent 的提示词和配置（agents.json、skill-rules.json），看、改、看 git 历史、回滚到某个版本。
// 运行时每次现读这些文件，改完下一次运行就生效。只认这几个文件，不能借这里读写别的路径；改动留在工作区，由 Yi 自己提交。
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CONFIG_DIR, ROOT } from "./config.ts";
import { DraftError } from "./drafts/store.ts";
import { exec } from "./util.ts";

export interface PromptFile {
	/** 相对仓库根目录，比如 config/agents/assistant.md */
	path: string;
	name: string;
	/** 谁用它 */
	usedBy: string;
	json: boolean;
	updated: number;
	/** 和已提交的版本不一样 */
	dirty: boolean;
}

const FIXED: Record<string, { name: string; usedBy: string }> = {
	"config/system.md": { name: "助手规则", usedBy: "所有 agent 的系统提示" },
	"config/draft.md": { name: "起草规则", usedBy: "起草和改写草稿" },
	"config/agents.json": { name: "agent 配置", usedBy: "模型、档位、工具、skill、MCP" },
	"config/skill-rules.json": { name: "命令规则", usedBy: "哪些命令直接放行、要审批、拒绝" },
};

/** agents/*.md 被哪些 agent / 档位引用 */
function usersOf(rel: string): string {
	try {
		const agents = JSON.parse(readFileSync(path.join(CONFIG_DIR, "agents.json"), "utf8"));
		const users: string[] = [];
		for (const [name, a] of Object.entries<any>(agents)) {
			if (name.startsWith("_")) continue;
			if (a.prompt && `config/${a.prompt}` === rel) users.push(name);
			for (const [tier, t] of Object.entries<any>(a.tiers ?? {}))
				if (t.prompt && `config/${t.prompt}` === rel) users.push(`${name} · ${tier} 档`);
		}
		return users.length ? users.join("、") : "没有 agent 引用";
	} catch {
		return "";
	}
}

/** 允许看和改的文件：固定的几个 + config/agents/*.md */
export function promptPaths(): string[] {
	let agents: string[] = [];
	try {
		agents = readdirSync(path.join(CONFIG_DIR, "agents"))
			.filter((f) => f.endsWith(".md"))
			.toSorted()
			.map((f) => `config/agents/${f}`);
	} catch {
		// 没有 agents 目录
	}
	return [...Object.keys(FIXED), ...agents];
}

function check(rel: string): string {
	if (!promptPaths().includes(rel)) throw new DraftError(`不能编辑 ${rel}`);
	return path.join(ROOT, rel);
}

const git = (args: string[]) => exec("git", ["-C", ROOT, ...args], { timeout: 20 });

export async function listPrompts(): Promise<PromptFile[]> {
	// 有改动的文件一次查出来
	const dirty = new Set(
		(await git(["status", "--porcelain", "--", "config"]).catch(() => ""))
			.split("\n")
			.map((l) => l.slice(3).trim())
			.filter(Boolean),
	);
	return promptPaths().map((rel) => ({
		path: rel,
		name: FIXED[rel]?.name ?? path.basename(rel, ".md"),
		usedBy: FIXED[rel]?.usedBy ?? usersOf(rel),
		json: rel.endsWith(".json"),
		updated: statSync(path.join(ROOT, rel)).mtimeMs / 1000,
		dirty: dirty.has(rel),
	}));
}

/** 当前内容和已提交的版本（没提交过为 null） */
export async function readPrompt(rel: string) {
	const content = readFileSync(check(rel), "utf8");
	const head = await git(["show", `HEAD:${rel}`]).catch(() => null);
	return { content, head };
}

export function savePrompt(rel: string, content: string) {
	const file = check(rel);
	if (rel.endsWith(".json")) {
		try {
			JSON.parse(content);
		} catch (e) {
			throw new DraftError(`JSON 格式不对：${(e as Error).message}`);
		}
	}
	if (!content.trim()) throw new DraftError("内容是空的");
	writeFileSync(file, content.endsWith("\n") ? content : `${content}\n`);
}

export async function promptHistory(rel: string) {
	check(rel);
	const out = await git(["log", "-n", "30", "--format=%h%x09%at%x09%s", "--", rel]).catch(() => "");
	return out
		.split("\n")
		.filter(Boolean)
		.map((l) => {
			const [rev, at, ...subject] = l.split("\t");
			return { rev, at: Number(at), subject: subject.join("\t") };
		});
}

export async function promptVersion(rel: string, rev: string) {
	check(rel);
	if (!/^[0-9a-f]{4,40}$/.test(rev)) throw new DraftError("版本号不对");
	return git(["show", `${rev}:${rel}`]);
}
