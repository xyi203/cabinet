// 技能页：SKILLS_DIR 下有哪些 skill、各给了哪些 agent、命令规则（放行 / 要审批 / 拒绝）怎么配的；
// 可以把用不上的 skill 对 agent 隐藏（比如 Cloudflare 那一堆）：系统提示里不再列，每次调用少几百到几千 tokens
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { changed } from "./bus.ts";
import { SKILLS_DIR } from "./config.ts";
import { getKv, setKv } from "./db/index.ts";
import { RULES_FILE } from "./agent/guard.ts";
import { loadAgents } from "./agent/router.ts";
import { DraftError } from "./drafts/store.ts";

const HIDDEN = "skills:hidden";

export const hiddenSkills = () => new Set(getKv<string[]>(HIDDEN, []));

export function setSkillHidden(name: string, hidden: boolean) {
	if (!/^[\w.-]+$/.test(name)) throw new DraftError("skill 名字不对");
	const set = hiddenSkills();
	if (hidden) set.add(name);
	else set.delete(name);
	setKv(HIDDEN, [...set].toSorted());
	changed();
}

/** description 字段（不截断）：frontmatter 里可能是多行的 > / | 块 */
export function describeSkill(text: string): string {
	const m = /^description:\s*(?:[>|][-+]?\s*)?([\s\S]*?)(?=^\S[\w-]*:|^---)/m.exec(text);
	return (m?.[1] ?? "").replace(/\s+/g, " ").trim();
}

export interface SkillView {
	name: string;
	desc: string;
	/** 目录在但没有 SKILL.md（失效的软链接之类），agent 用不了 */
	broken: boolean;
	hidden: boolean;
	/** 哪些 agent 能用（配置 "*" 或列了名字） */
	agents: string[];
	/** 命令规则：argv0 指向这个 skill 目录的那几条 */
	rules: Array<{ name: string; read: string[]; write: string[]; deny: string[] }>;
}

export function listSkills(): SkillView[] {
	let dirs: string[] = [];
	try {
		dirs = readdirSync(SKILLS_DIR).toSorted();
	} catch {
		return [];
	}
	const agents = Object.entries(loadAgents().agents);
	let rules: Record<string, any> = {};
	try {
		rules = JSON.parse(readFileSync(RULES_FILE, "utf8"));
	} catch {
		// 没有规则文件
	}
	const hidden = hiddenSkills();
	return dirs.map((name) => {
		const md = path.join(SKILLS_DIR, name, "SKILL.md");
		const broken = !existsSync(md);
		const own = Object.entries(rules)
			.filter(([k, r]) => !k.startsWith("_") && (r.argv0 ?? []).some((a: string) => a.includes(`{skills}/${name}/`)))
			.map(([k, r]) => ({ name: k, read: r.read ?? [], write: r.write ?? [], deny: r.deny ?? [] }));
		return {
			name,
			desc: broken ? "" : describeSkill(readFileSync(md, "utf8")),
			broken,
			hidden: hidden.has(name),
			agents: agents.filter(([, a]) => a.skills === "*" || (Array.isArray(a.skills) && a.skills.includes(name))).map(([n]) => n),
			rules: own,
		};
	});
}

export function readSkill(name: string): string {
	if (!/^[\w.-]+$/.test(name)) throw new Error("skill 名字不对");
	return readFileSync(path.join(SKILLS_DIR, name, "SKILL.md"), "utf8");
}
