// 需求任务：飞书工单（需求、缺陷）在 cabinet 里的进度：开发中 → 测试中 → 发布中 → 发布完成。
// 阶段只看 cabinet 这边、由 Yi 在看板上推，不参考也不回写飞书项目的节点；开发任务从这里派，发布工单交给助手提（提交走审批）。
// 发布工单（GD-*）三种挂法：Yi 手动填工单号（可多张）、从需求提的单审批执行后自动挂、刷新时按工单详情里的 feishuStoryIds 对上。
// devops MCP 的 issue_list(scope=mine) 实测对 Yi 返回空，别人提的单也列不出来，所以以工单号为准，列表只当补充来源。
import { eq } from "drizzle-orm";
import { changed } from "./bus.ts";
import { db, schema } from "./db/index.ts";
import type { Story, StoryTicket } from "./db/schema.ts";
import { callMcp } from "./agent/mcp.ts";
import { PATROL_CRON, PATROL_DAYS, PATROL_FULL_MINUTES, PATROL_MODEL, OWNER_OPEN_ID, SKILLS_DIR } from "./config.ts";
import { dispatch, getDevTask, PATROL_OK } from "./dev.ts";
import { sendToUserAsBot } from "./lark/bot.ts";
import { deleteSchedule, listSchedules, saveSchedule } from "./schedules.ts";
import { DraftError } from "./drafts/store.ts";
import { meegle } from "./meego.ts";
import { log, now, when } from "./util.ts";

export const STAGES = ["dev", "test", "release", "done", "dropped"] as const;
export type Stage = (typeof STAGES)[number];

/** 只跟需求和缺陷：技术协助这类自定义类型不走开发发布流程 */
const TYPES: Record<string, string> = { story: "需求", issue: "缺陷" };
const SYNC_INTERVAL = 30 * 60_000;
/** 巡检中的工单单独盯得更勤：全量后第一轮在 5 分钟，30 分钟一刷赶不上 */
const WATCH_INTERVAL = 60_000;
const DEVOPS = "mcp__devops-mcp-prod__";

export const listStories = () => db().select().from(schema.stories).all();
export const getStory = (id: string) => db().select().from(schema.stories).where(eq(schema.stories.id, id)).get();

/** 飞书工单链接（project.feishu.cn/<空间>/<类型>/detail/<id>）或纯数字 ID */
export function parseStoryRef(text: string): { id: string; space?: string } | undefined {
	const m = /project\.feishu\.cn\/([\w-]+)\/[\w-]+\/detail\/(\d+)/.exec(text);
	if (m) return { id: m[2], space: m[1] };
	const id = /^\s*(\d{6,})\s*$/.exec(text)?.[1];
	return id ? { id } : undefined;
}

/** 手动加一张飞书工单（不在「我的待办」里的也行）：给了链接按链接里的空间查，只给 ID 就在看板上已有的空间里逐个试 */
export async function addStory(text: string): Promise<Story> {
	const ref = parseStoryRef(text);
	if (!ref) throw new DraftError("没认出飞书工单：贴工单链接或工单 ID");
	const old = getStory(ref.id);
	if (old) {
		if (old.stage !== "dropped") throw new DraftError(`已经在看板上了：${old.title}`);
		setStage(old.id, "dev");
		return getStory(old.id)!;
	}
	const spaces = ref.space ? [ref.space] : [...new Set(listStories().map((x) => x.projectKey))];
	let wi: any;
	for (const space of spaces) {
		try {
			wi = (await meegle(["workitem", "get", "--project-key", space, "--work-item-id", ref.id]))?.work_item_attribute;
			if (wi?.work_item_id) break;
		} catch (e) {
			log("读取飞书工单失败", space, ref.id, e);
		}
	}
	if (!wi?.work_item_id) throw new DraftError(ref.space ? "查不到这张飞书工单" : "查不到这张飞书工单：只给 ID 时贴完整链接试试");
	const typeKey = String(wi.work_item_type?.key ?? "");
	const simple = wi.owned_project?.simple_name;
	const t = now();
	const row = {
		id: ref.id,
		projectKey: String(wi.owned_project?.key ?? ref.space ?? ""),
		typeKey,
		title: String(wi.work_item_name ?? ""),
		url: simple ? `https://project.feishu.cn/${simple}/${typeKey}/detail/${ref.id}` : "",
		stage: "dev",
		tickets: [],
		created: t,
		updated: t,
	};
	db().insert(schema.stories).values(row).run();
	log("手动添加飞书工单", ref.id, row.title);
	changed();
	return getStory(ref.id)!;
}

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
		db().insert(schema.stories).values({ id, projectKey, typeKey, title, url, stage: "dev", tickets: [], created: t, updated: t }).run();
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

/** 文字里的发布工单号（GD-123，工单页链接里的也认），去重、转大写 */
export const parseTicketKeys = (text: string): string[] => [...new Set((text.match(/\bGD-\d+\b/gi) ?? []).map((k) => k.toUpperCase()))];

export interface TicketInfo {
	key: string;
	title: string;
	status: string;
	/** 走完流程或终止了：之后刷新不再查 */
	ended: boolean;
	/** 已走到「prod 部署」这一步（全量）；终止、回滚的不算 */
	full: boolean;
	/** 工单里填的飞书工单 ID（feishuStoryIds，逗号分隔可多个） */
	storyIds: string[];
}

const ENDED_RE = /终止|关闭|取消|作废|驳回/;

/** issue_get_info 的结果：{ issue: { issueInfo, issueParams, steps } } */
export function parseTicketInfo(key: string, text: string): TicketInfo {
	const d = parse(text)?.issue ?? {};
	const info = d.issueInfo ?? {};
	if (!info.issueKey) throw new DraftError(`查不到工单 ${key}`);
	const param = (k: string) => String((d.issueParams ?? []).find((x: any) => x?.paramKey === k)?.paramValue ?? "");
	const lastStage = Math.max(0, ...(d.steps ?? []).map((x: any) => Number(x?.stage) || 0));
	const status = String(info.statusName ?? "");
	// 流程节点里「prod AB部署」之后的「prod 部署」就是全量；没有 AB 的发布直接走这一步
	const fullStage = (d.steps ?? []).find((x: any) => /^prod\s*部署$/i.test(String(x?.stepName ?? "").trim()))?.stage;
	return {
		key,
		title: String(info.summary ?? ""),
		status,
		ended: (lastStage > 0 && Number(info.stage) >= lastStage) || ENDED_RE.test(status),
		full: fullStage != null && Number(info.stage) >= Number(fullStage) && !ENDED_RE.test(status),
		storyIds: param("feishuStoryIds")
			.split(/[,\s]+/)
			.filter(Boolean),
	};
}

async function ticketInfo(key: string): Promise<TicketInfo> {
	return parseTicketInfo(key, await callMcp(`${DEVOPS}issue_get_info`, { issueKey: key }));
}

/**
 * 一条需求的发布工单合进新查到的详情：已挂的更新标题和状态；详情里填了这条需求的自动挂上（Yi 解绑过的不再挂）；
 * bind 是这次手动绑或提单后挂的，解绑过的也重新挂上。返回新列表
 */
export function mergeTickets(
	storyId: string,
	tickets: StoryTicket[],
	infos: Map<string, TicketInfo>,
	bind?: { keys: string[]; source: "manual" | "created" },
): StoryTicket[] {
	const out = tickets.map((t) => {
		const info = infos.get(t.key);
		const next: StoryTicket = info ? { ...t, title: info.title, status: info.status, ended: info.ended, full: info.full } : { ...t };
		if (bind?.keys.includes(t.key)) {
			delete next.removed;
			if (next.source === "auto" || !next.source) next.source = bind.source;
		}
		return next;
	});
	const have = new Set(out.map((t) => t.key));
	const add = (key: string, source: StoryTicket["source"]) => {
		const info = infos.get(key);
		out.push({ key, title: info?.title ?? "", status: info?.status ?? "", ended: info?.ended, full: info?.full, source });
		have.add(key);
	};
	for (const key of bind?.keys ?? []) if (!have.has(key)) add(key, bind!.source);
	for (const info of infos.values()) if (!have.has(info.key) && info.storyIds.includes(storyId)) add(info.key, "auto");
	return out;
}

/** 把查到的详情合进所有需求，变了的写回 */
function applyTickets(infos: Map<string, TicketInfo>, bind?: { storyId: string; keys: string[]; source: "manual" | "created" }) {
	for (const s of listStories()) {
		const tickets = mergeTickets(s.id, s.tickets, infos, bind?.storyId === s.id ? bind : undefined);
		if (JSON.stringify(tickets) !== JSON.stringify(s.tickets))
			db().update(schema.stories).set({ tickets, updated: now() }).where(eq(schema.stories.id, s.id)).run();
	}
	changed();
}

/**
 * 刷新发布工单：已挂的、没结束的逐张查详情更新状态，顺带按详情里的飞书工单 ID 挂到别的需求下；
 * 再加上 issue_list(mine) 列出的单（现在对 Yi 返回空，等接口修好就能自动发现在外面提的单）
 */
export async function refreshTickets(): Promise<void> {
	const keys = new Set<string>();
	for (const s of listStories()) for (const t of s.tickets) if (!t.removed && !t.ended) keys.add(t.key);
	try {
		const issues: any[] = parse(await callMcp(`${DEVOPS}issue_list`, { scope: "mine", perPage: 50 })).issues ?? [];
		for (const it of issues) if (ticketKey(it)) keys.add(ticketKey(it));
	} catch (e) {
		log("列出发布工单失败", e);
	}
	applyTickets(await ticketInfos(keys));
	syncPatrols();
}

async function ticketInfos(keys: Iterable<string>) {
	const infos = new Map<string, TicketInfo>();
	for (const key of keys) {
		try {
			infos.set(key, await ticketInfo(key));
		} catch (e) {
			log("读取发布工单失败", key, e);
		}
	}
	return infos;
}

/** 巡检过（不是手动停的）、还没全量的工单：每分钟查一次，一全量就转成全量后巡检 */
let watching = false;
async function watchFull() {
	if (watching) return;
	watching = true;
	try {
		const keys = new Set<string>();
		for (const s of listStories())
			for (const t of s.tickets)
				if (!t.removed && !t.ended && !t.full && t.patrol && !MANUAL_STOP.has(t.patrol.stopped ?? "")) keys.add(t.key);
		if (!keys.size) return;
		applyTickets(await ticketInfos(keys));
		syncPatrols();
	} finally {
		watching = false;
	}
}

/**
 * 给需求挂发布工单（文字里的工单号都挂，可多张）。manual 要每张都查得到才挂；
 * created 是提单审批执行后的结果，详情一时查不到也先挂上工单号，下次刷新补标题和状态
 */
export async function bindTickets(storyId: string, text: string, source: "manual" | "created" = "manual") {
	if (!getStory(storyId)) throw new DraftError("需求不存在");
	const keys = parseTicketKeys(text);
	if (!keys.length) throw new DraftError("没认出发布工单号：形如 GD-12345，或贴工单页链接");
	const infos = new Map<string, TicketInfo>();
	const failed: string[] = [];
	for (const key of keys) {
		try {
			infos.set(key, await ticketInfo(key));
		} catch (e) {
			log("读取发布工单失败", key, e);
			// 工单真不存在是 DraftError；别的（MCP 没连上、超时）把原因带上，免得以为是单号错了
			failed.push(e instanceof DraftError ? key : `${key}（${String((e as Error).message).slice(0, 80)}）`);
		}
	}
	const bound = source === "created" ? keys : keys.filter((k) => infos.has(k));
	if (!bound.length) throw new DraftError(`查不到工单：${failed.join("、")}`);
	applyTickets(infos, { storyId, keys: bound, source });
	return { bound, failed: source === "created" ? [] : failed };
}

/** 解绑：留着记录标成已解绑，刷新时详情里填了这条需求也不再自动挂回来；在巡检的一并停掉 */
export function unbindTicket(storyId: string, key: string) {
	const s = getStory(storyId);
	if (!s) throw new DraftError("需求不存在");
	if (!s.tickets.some((t) => t.key === key)) throw new DraftError(`没挂 ${key}`);
	const t0 = s.tickets.find((t) => t.key === key)!;
	if (t0.patrol && !t0.patrol.stopped) stopPatrol(storyId, key, "已解绑");
	if (t0.fullPatrol && !t0.fullPatrol.stopped) stopFullPatrol(storyId, key, "已解绑");
	const tickets = getStory(storyId)!.tickets.map((t) => (t.key === key ? { ...t, removed: true } : t));
	db().update(schema.stories).set({ tickets, updated: now() }).where(eq(schema.stories.id, storyId)).run();
	changed();
}

/** 审批执行成功后调：从需求派出的任务提了发布工单（issue_create），把结果里的工单号挂到那条需求上 */
export function ticketsCreated(tool: string, devTaskId: string | null, result: string) {
	if (!tool.endsWith("__issue_create") || !devTaskId) return;
	const storyId = getDevTask(devTaskId)?.storyId;
	if (!storyId || !parseTicketKeys(result).length) return;
	bindTickets(storyId, result, "created")
		.then(({ bound }) => log("提单后挂到需求", storyId, bound))
		.catch((e) => log("提单后挂到需求失败", storyId, e));
}

// ---------- 发布观察文档与巡检 ----------

const OBSERVATION_DIR = `${SKILLS_DIR}/release-observation`;

/** 改一条需求下某张发布工单的字段 */
function patchTicket(storyId: string, key: string, patch: (t: StoryTicket) => StoryTicket) {
	const s = getStory(storyId);
	if (!s) throw new DraftError("需求不存在");
	if (!s.tickets.some((t) => t.key === key && !t.removed)) throw new DraftError(`没挂 ${key}`);
	const tickets = s.tickets.map((t) => (t.key === key ? patch(t) : t));
	db().update(schema.stories).set({ tickets, updated: now() }).where(eq(schema.stories.id, storyId)).run();
	changed();
	return { story: s, ticket: tickets.find((t) => t.key === key)! };
}

const liveTicket = (storyId: string, key: string) => {
	const s = getStory(storyId);
	const t = s?.tickets.find((x) => x.key === key && !x.removed);
	if (!s || !t) throw new DraftError(s ? `没挂 ${key}` : "需求不存在");
	return { s, t };
};

export function docPrompt(s: Story, key: string) {
	return [
		`给${header(s)}的发布工单 ${key} 写发布观察文档（发布计划），按 release-doc skill 来：`,
		`- 用 devops 的 issue_get_info ${key}（或 devops skill 的 scripts/publish issue）读工单：服务、版本、发布方式；以发布前线上实际版本到目标版本核对完整变更，不只看一个 MR。`,
		"- 按 doc-templates 的发布观察模板写清观察指标、验证方法、风险与回滚；查不到的写「待确认」，不编版本、时间和结论。",
		"- 文档按 team-wiki 放到团队知识库「迭代记录 → 发布观察 → 季度」下（季度取计划发布日期）；同一次发布已有文档就更新。写飞书是写操作，会给我发审批卡片。",
		`- 文档写好后挂到工单：issue_update ${key} 的 fbgc（发布观察）和 fxya（风险预案）第一行写文档链接，原有文字留在后面，其他字段不动。先 confirmed=false 看预览，没问题直接 confirmed=true，审批卡片就是我的确认，不用停下来等我回复「提交」。`,
		"- 最后单独一行给出文档链接。",
	].join("\n");
}

export function observePrompt(s: Story, key: string, docTask?: string) {
	return [
		`对${header(s)}的发布工单 ${key} 做一次首次发布观察，按 release-observation skill 的第零到第六步。`,
		docTask ? `这张工单的发布观察文档在任务 ${docTask} 的结论里（lookup ${docTask}），观察指标以文档为准。` : "",
		"不要启动 loop 或定时巡查：之后由 cabinet 每 30 分钟派一轮巡检，每轮是新会话。",
		"回复结尾单独写一段「【巡检范围与基线】」：服务和版本区间、要盯的 deployment / 渠道 / 受影响接口、各项基线数值、每轮该查什么。之后每一轮巡检都只靠这段来做，写全、写具体。",
	]
		.filter(Boolean)
		.join("\n\n");
}

export function patrolPrompt(s: Story, key: string, observeTaskId?: string, fullAt?: number) {
	return [
		fullAt
			? `发布工单 ${key}（${header(s)}）已在 ${when(fullAt)} 前后全量（走到 prod 部署），这是全量后巡检：全量后 ${PATROL_FULL_MINUTES.join(" / ")} 分钟各一轮，最后一轮跑完自动停。重点看流量全部切到新版本后的变化：错误率、5xx、P95、资源、重启、Sentry 新增，和 AB 阶段的基线比。`
			: `发布工单 ${key}（${header(s)}）的定时巡检。`,
		observeTaskId
			? `1. 先 lookup ${observeTaskId}，读首次观察结尾的「【巡检范围与基线】」；首次观察还没跑完就先只看放量时间线和 Sentry 新增。`
			: `1. 没有首次观察：先用 devops 的 issue_get_info ${key} 读服务、版本和发布方式，基线取发布前的数据。`,
		`2. 按 ${OBSERVATION_DIR}/references/patrol.md 做增量检查：只读这份，不重读 SKILL.md、不重走七步，不启动 loop。`,
		`3. 没有异常：回复第一行只写「${PATROL_OK}」，后面最多一两句（这一轮会直接归档、不打扰 Yi）。`,
		"4. 有异常：第一行写清异常和证据，再给建议（停止放量 / 回滚 / 继续观察）。满足 patrol.md 的停止条件时，第一行写「建议停止巡检」和原因。",
	].join("\n");
}

/** 生成发布观察文档：派一个助手任务（写飞书走审批），任务记在工单上，文档链接从任务结论里取 */
export async function startDoc(storyId: string, key: string) {
	const { s } = liveTicket(storyId, key);
	const task = await dispatch({ agent: "assistant", request: docPrompt(s, key), title: `观察文档 ${key} · ${s.title}`, storyId });
	patchTicket(storyId, key, (t) => ({ ...t, doc: { taskId: task.id } }));
	return task;
}

/** 开始巡检：先派首次观察（默认模型），再建定时任务：每轮用 PATROL_MODEL、新会话、正常不私聊，PATROL_DAYS 天后自动停 */
export async function startPatrol(storyId: string, key: string) {
	const { s, t } = liveTicket(storyId, key);
	if (t.patrol && !t.patrol.stopped) throw new DraftError("已经在巡检了");
	if (t.ended) throw new DraftError(`工单已经结束（${t.status}），不用巡检`);
	const observe = await dispatch({
		agent: "assistant",
		request: observePrompt(s, key, t.doc?.taskId),
		title: `首次观察 ${key} · ${s.title}`,
		storyId,
		notify: true,
	});
	const sched = saveSchedule({
		name: `巡检 ${key} · ${s.title}`.slice(0, 80),
		cron: PATROL_CRON,
		agent: "assistant",
		prompt: patrolPrompt(s, key, observe.id),
		model: PATROL_MODEL,
		until: now() + PATROL_DAYS * 86400,
		patrol: true,
	});
	patchTicket(storyId, key, (x) => ({ ...x, patrol: { observeTaskId: observe.id, scheduleId: sched.id, started: now() } }));
	log("开始巡检", key, sched.id, observe.id);
	return { observe, schedule: sched };
}

/** 停止巡检：删掉定时任务，工单上记下原因 */
export function stopPatrol(storyId: string, key: string, reason = "手动停止") {
	const { t } = liveTicket(storyId, key);
	if (!t.patrol || t.patrol.stopped) throw new DraftError("没在巡检");
	try {
		deleteSchedule(t.patrol.scheduleId);
	} catch {
		// 定时任务已经被删了：只记状态
	}
	patchTicket(storyId, key, (x) => ({ ...x, patrol: { ...x.patrol!, stopped: reason } }));
	log("停止巡检", key, reason);
}

/** 停全量后巡检：删掉定时任务，工单上记下原因 */
export function stopFullPatrol(storyId: string, key: string, reason = "手动停止") {
	const { t } = liveTicket(storyId, key);
	if (!t.fullPatrol || t.fullPatrol.stopped) throw new DraftError("没在做全量后巡检");
	try {
		deleteSchedule(t.fullPatrol.scheduleId);
	} catch {
		// 定时任务已经被删了：只记状态
	}
	patchTicket(storyId, key, (x) => ({ ...x, fullPatrol: { ...x.fullPatrol!, stopped: reason } }));
	log("停止全量后巡检", key, reason);
}

/**
 * 全量后巡检：从现在起按 PATROL_FULL_MINUTES 各跑一轮，跑完自动停；还在 AB 巡检的先停掉。
 * 工单全量时自动开（auto），也可以在需求里手动点
 */
export function startFullPatrol(storyId: string, key: string, auto = false) {
	const { s, t } = liveTicket(storyId, key);
	if (t.fullPatrol && !t.fullPatrol.stopped) throw new DraftError("已经在做全量后巡检了");
	if (!PATROL_FULL_MINUTES.length) throw new DraftError("PATROL_FULL_MINUTES 没配");
	if (t.patrol && !t.patrol.stopped) stopPatrol(storyId, key, "已全量，转为全量后巡检");
	const at = now();
	const times = PATROL_FULL_MINUTES.map((m) => at + m * 60);
	const sched = saveSchedule({
		name: `全量后巡检 ${key} · ${s.title}`.slice(0, 80),
		cron: `全量后 ${PATROL_FULL_MINUTES.join(" / ")} 分钟`,
		times,
		agent: "assistant",
		prompt: patrolPrompt(s, key, t.patrol?.observeTaskId, at),
		model: PATROL_MODEL,
		// 最后一轮之后一分钟算到期：定时页按到期归到「已结束」
		until: times.at(-1)! + 60,
		patrol: true,
	});
	patchTicket(storyId, key, (x) => ({ ...x, fullPatrol: { scheduleId: sched.id, started: at } }));
	log("开始全量后巡检", key, sched.id, auto ? "自动" : "手动");
	if (auto && OWNER_OPEN_ID)
		void sendToUserAsBot(
			OWNER_OPEN_ID,
			`发布工单 ${key}（${s.title}）已全量（${t.status}），AB 巡检已停，改为全量后 ${PATROL_FULL_MINUTES.join(" / ")} 分钟各巡检一轮。`,
		).catch((e) => log("全量后巡检通知失败", key, e));
	return sched;
}

/** Yi 手动停的、解绑的：全量了也不自动接着巡检 */
const MANUAL_STOP = new Set(["手动停止", "已解绑"]);

/**
 * 刷新后收尾：AB 巡检过的工单一全量就转成全量后巡检；工单结束（没全量就终止了）停巡检并私聊一句；
 * 定时任务到期停用、跑完或被删了，工单上也标成停了
 */
function syncPatrols() {
	const scheds = new Map(listSchedules().map((x) => [x.id, x]));
	for (const s of listStories())
		for (const t of s.tickets) {
			if (t.removed) continue;
			if (t.full && !t.fullPatrol && t.patrol && !MANUAL_STOP.has(t.patrol.stopped ?? "")) {
				try {
					startFullPatrol(s.id, t.key, true);
				} catch (e) {
					log("自动开始全量后巡检失败", t.key, e);
				}
				continue;
			}
			if (t.fullPatrol && !t.fullPatrol.stopped) {
				const sched = scheds.get(t.fullPatrol.scheduleId);
				if (!sched || !sched.enabled)
					patchTicket(s.id, t.key, (x) => ({
						...x,
						fullPatrol: { ...x.fullPatrol!, stopped: sched ? "已跑完" : "定时任务已删除" },
					}));
			}
			if (!t.patrol || t.patrol.stopped) continue;
			const sched = scheds.get(t.patrol.scheduleId);
			if (t.ended) {
				stopPatrol(s.id, t.key, `工单已结束（${t.status}）`);
				if (OWNER_OPEN_ID)
					void sendToUserAsBot(OWNER_OPEN_ID, `发布工单 ${t.key}（${s.title}）已结束（${t.status}），巡检已自动停止。`).catch((e) =>
						log("巡检停止通知失败", t.key, e),
					);
			} else if (!sched || !sched.enabled) {
				patchTicket(s.id, t.key, (x) => ({
					...x,
					patrol: { ...x.patrol!, stopped: sched ? `满 ${PATROL_DAYS} 天自动停止` : "定时任务已删除" },
				}));
			}
		}
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

// 观察文档任务按 docPrompt 最后单独一行给链接；取结论里最后一个飞书文档链接
const docLink = (text: string) => text.match(/https:\/\/[\w.-]+\.feishu\.cn\/(?:wiki|docx)\/\w+/g)?.at(-1);

/**
 * 需求上挂着的发布工单、观察文档和首次观察：交给助手时一起带上，「把当前 AB 数据更新到观察文档」这种话
 * 不用 agent 再去猜是哪张单、哪份文档
 */
export function ticketContext(
	s: Pick<Story, "tickets">,
	summaryOf: (taskId: string) => string | undefined = (id) => getDevTask(id)?.summary,
): string {
	const lines = s.tickets
		.filter((t) => !t.removed)
		.map((t) => {
			const parts = [`- ${t.key}${t.title ? `「${t.title}」` : ""}：${t.status || "状态未知"}${t.ended ? "（已结束）" : ""}`];
			if (t.doc) {
				const link = docLink(summaryOf(t.doc.taskId) ?? "");
				parts.push(`发布观察文档${link ? ` ${link}` : "（链接见任务结论）"}，任务 ${t.doc.taskId}`);
			}
			if (t.patrol)
				parts.push(`首次观察任务 ${t.patrol.observeTaskId}${t.patrol.stopped ? `，巡检已停（${t.patrol.stopped}）` : "，巡检中"}`);
			if (t.fullPatrol) parts.push(t.fullPatrol.stopped ? `全量后巡检已停（${t.fullPatrol.stopped}）` : "全量后巡检中");
			return parts.join("；");
		});
	return lines.length ? `这条需求挂着的发布工单（来龙去脉用 lookup 沿任务 ID 查）：\n${lines.join("\n")}` : "";
}

/** 从需求派活：dev 在新分支上实现，assistant 查数据、分析、更新文档（写操作走审批）或者提发布工单 */
export async function storyTask(
	id: string,
	input: { kind: "dev" | "ask" | "release"; text?: string; repo?: string; branch?: string; model?: string; thinking?: string },
) {
	const s = getStory(id);
	if (!s) throw new DraftError("需求不存在");
	const text = input.text?.trim() ?? "";
	if (input.kind === "release")
		return dispatch({
			agent: "assistant",
			request: releasePrompt(s, text),
			title: `提发布工单 · ${s.title}`,
			storyId: id,
			model: input.model,
			thinking: input.thinking,
		});
	if (input.kind === "ask") {
		if (!text) throw new DraftError("写一下要查什么");
		return dispatch({
			agent: "assistant",
			request: [header(s), ticketContext(s), text].filter(Boolean).join("\n\n"),
			title: `${text.slice(0, 60)} · ${s.title}`,
			repo: input.repo,
			storyId: id,
			model: input.model,
			thinking: input.thinking,
		});
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
	setInterval(() => void watchFull().catch((e) => log("盯全量失败", e)), WATCH_INTERVAL).unref();
}
