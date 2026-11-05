// 需求任务：飞书工单（需求、缺陷）在 cabinet 里的进度：开发中 → 测试中 → 发布中 → 发布完成。
// 阶段只看 cabinet 这边、由 Yi 在看板上推，不参考也不回写飞书项目的节点；开发任务从这里派，发布工单交给助手提（提交走审批），
// devops 的发布工单关联了飞书工单 ID，刷新时按这个对上，挂到对应的需求下。
import { eq } from "drizzle-orm";
import { changed } from "./bus.ts";
import { db, getKv, schema, setKv } from "./db/index.ts";
import type { Story, StoryTicket } from "./db/schema.ts";
import { callMcp } from "./agent/mcp.ts";
import { dispatch } from "./dev.ts";
import { DraftError } from "./drafts/store.ts";
import { meegle } from "./meego.ts";
import { log, now } from "./util.ts";

export const STAGES = ["dev", "test", "release", "done", "dropped"] as const;
export type Stage = (typeof STAGES)[number];

/** 只跟需求和缺陷：技术协助这类自定义类型不走开发发布流程 */
const TYPES: Record<string, string> = { story: "需求", issue: "缺陷" };
const SYNC_INTERVAL = 30 * 60_000;
const DEVOPS = "mcp__devops-mcp-prod__";

export const listStories = () => db().select().from(schema.stories).all();
export const getStory = (id: string) => db().select().from(schema.stories).where(eq(schema.stories.id, id)).get();

/** 从「我的待办」拉需求和缺陷：新的建出来（从开发中开始），已有的只更新标题，不动阶段 */
export async function syncStories(): Promise<number> {
	const list: any[] = (await meegle(["mywork", "todo", "--action", "todo"]))?.list ?? [];
	let added = 0;
	for (const it of list) {
		const wi = it.work_item_info ?? {};
		const typeKey = String(wi.work_item_type_key ?? "");
		if (!TYPES[typeKey] || !wi.work_item_id) continue;
		const id = String(wi.work_item_id);
		const title = String(wi.work_item_name ?? "");
		const old = getStory(id);
		if (old) {
			if (old.title !== title) db().update(schema.stories).set({ title, updated: now() }).where(eq(schema.stories.id, id)).run();
			continue;
		}
		const projectKey = String(it.project_key ?? "");
		let url = "";
		try {
			const got = await meegle(["workitem", "get", "--project-key", projectKey, "--work-item-id", id]);
			const simple = got?.work_item_attribute?.owned_project?.simple_name;
			if (simple) url = `https://project.feishu.cn/${simple}/${typeKey}/detail/${id}`;
		} catch (e) {
			log("读取飞书工单失败", id, e);
		}
		const t = now();
		db()
			.insert(schema.stories)
			.values({ id, projectKey, typeKey, title, url, stage: "dev", tickets: [], created: t, updated: t })
			.run();
		added++;
	}
	if (added) log("同步飞书工单，新增", added);
	changed();
	return added;
}

export function setStage(id: string, stage: string) {
	if (!STAGES.includes(stage as Stage)) throw new DraftError(`没有阶段 ${stage}`);
	if (!getStory(id)) throw new DraftError("需求不存在");
	db().update(schema.stories).set({ stage, updated: now() }).where(eq(schema.stories.id, id)).run();
	changed();
}

const parse = (text: string): any => {
	try {
		return JSON.parse(text);
	} catch {
		return {};
	}
};
const ticketKey = (x: any): string => String(x?.issueKey ?? x?.key ?? x?.issue_key ?? "");

/**
 * 发布工单挂到需求上：列出 Yi 提的发布工单，详情里带了飞书工单 ID 的就挂到那条需求下。
 * 工单关联的飞书工单不会变，详情按工单缓存；状态每次从列表取最新的
 */
export async function refreshTickets(ids = listStories().filter((s) => s.stage !== "dropped").map((s) => s.id)): Promise<void> {
	if (!ids.length) return;
	const issues: any[] = parse(await callMcp(`${DEVOPS}issue_list`, { scope: "mine", perPage: 50 })).issues ?? [];
	const found = new Map<string, StoryTicket[]>(ids.map((id) => [id, []]));
	for (const it of issues) {
		const key = ticketKey(it);
		if (!key) continue;
		const cacheKey = `gdinfo:${key}`;
		let info = getKv<string>(cacheKey, "");
		if (!info) {
			info = await callMcp(`${DEVOPS}issue_get_info`, { issueKey: key }).catch(() => "");
			if (info) setKv(cacheKey, info.slice(0, 50_000));
		}
		for (const id of ids)
			if (info.includes(id))
				found.get(id)!.push({
					key,
					title: String(it.summary ?? it.title ?? ""),
					status: String(it.status?.name ?? it.statusName ?? it.status ?? ""),
					url: it.url ? String(it.url) : undefined,
				});
	}
	for (const [id, tickets] of found) {
		const old = getStory(id);
		if (old && JSON.stringify(old.tickets) !== JSON.stringify(tickets))
			db().update(schema.stories).set({ tickets, updated: now() }).where(eq(schema.stories.id, id)).run();
	}
	changed();
}

const header = (s: Story) => `飞书${TYPES[s.typeKey] ?? "工单"}「${s.title}」（ID ${s.id}${s.url ? `，${s.url}` : ""}）`;

/** 发布工单的说明：环境、发布方式给出来了就按这个提，没给的照 devops 的流程逐项问 Yi */
export function releasePrompt(s: Story, what: string) {
	return [
		`给${header(s)}提发布工单：${what || "按当前进度判断该提哪一种，先跟我确认"}。`,
		"用 devops-mcp-prod 的 issue_* 工具，按它的规则一步步来：先 issue_list_supported_types 选类型，issue_get_schema / issue_get_teams 拿字段，服务版本用 issue_get_service_tags、平台和发布方式用 issue_get_deploy_options，选项原样给我编号让我选，不要自己猜；飞书工单就选上面这张。",
		"工单名称让我给。字段齐了先 issue_validate，再 issue_create(confirmed=false) 出预览给我看；我确认后再 confirmed=true 提交，提交会给我发审批卡片。",
	].join("\n");
}

/** 从需求派活：dev 在新分支上实现，assistant 只读地查或者提发布工单 */
export async function storyTask(
	id: string,
	input: { kind: "dev" | "ask" | "release"; text?: string; repo?: string; branch?: string; model?: string; thinking?: string },
) {
	const s = getStory(id);
	if (!s) throw new DraftError("需求不存在");
	const text = input.text?.trim() ?? "";
	if (input.kind === "release")
		return dispatch({ agent: "assistant", request: releasePrompt(s, text), title: `提发布工单 · ${s.title}`, storyId: id, model: input.model, thinking: input.thinking });
	if (input.kind === "ask") {
		if (!text) throw new DraftError("写一下要查什么");
		return dispatch({ agent: "assistant", request: `${header(s)}\n\n${text}`, title: `${text.slice(0, 60)} · ${s.title}`, repo: input.repo, storyId: id, model: input.model, thinking: input.thinking });
	}
	const task = await dispatch({
		agent: "dev",
		request: `${header(s)}\n\n${text || "按工单实现，需求细节先用 meegle 读工单描述和评论"}`,
		title: s.title,
		repo: input.repo,
		branch: input.branch,
		storyId: id,
		model: input.model,
		thinking: input.thinking,
	});
	return task;
}

const syncAll = () =>
	void syncStories()
		.catch((e) => log("同步飞书工单失败", e))
		.then(() => refreshTickets())
		.catch((e) => log("刷新发布工单失败", e));

export function startStories() {
	syncAll();
	setInterval(syncAll, SYNC_INTERVAL).unref();
}
