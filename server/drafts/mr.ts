// MR 预审：收到 MR 链接先用机器人回个 Get；预审（review skill）出的评论台账由 Yi 在卡片上过目，
// 点了才发到 GitLab（行内评论 + 总结评论），另外可以 approve。
// 这些动作都由 Yi 在卡片或看板上点出来（点击本身就是确认），以 Yi 的 glab 身份执行；和回复对方的草稿互不影响，草稿发出后也能点。
import { eq, inArray } from "drizzle-orm";
import { changed } from "../bus.ts";
import { GLAB_BIN } from "../config.ts";
import { db, getKv, schema, setKv } from "../db/index.ts";
import type { Draft } from "../db/schema.ts";
import { GITLAB_HOST, glabRepo } from "../agent/router.ts";
import { react } from "../lark/bot.ts";
import type { Message } from "../lark/types.ts";
import { settle } from "../pipeline.ts";
import { exec, log } from "../util.ts";
import { claim, DraftError, LIVE, syncCard } from "./store.ts";

/** 收到要预审的 MR 先回的表情：告诉对方收到了，评审结论 Yi 过目后才发到 MR 上 */
export const MR_ACK_EMOJI = "Get";

/**
 * 机器人身份（和 lark-cli --as bot 同一个应用）在 MR 链接那条消息上回 Get，每条消息只回一次（重启接回、手动重试不重复）。
 * 不用 Yi 的身份：Yi 回过表情的消息会被当成「已亲自回复」，草稿直接作废。机器人不在这个会话里（别人私聊 Yi）时回不上，只记日志
 */
export async function ackMr(chatMode: string, m: Pick<Message, "message_id">) {
	if (chatMode === "meego") return;
	const key = `mrack:${m.message_id}`;
	if (getKv(key, false)) return;
	setKv(key, true);
	if (!(await react(m.message_id, MR_ACK_EMOJI))) log("MR 链接回 Get 没成功（机器人可能不在这个会话里）", m.message_id);
}

/** 一条行内评论：位置按 GitLab discussions 的 position，行号是 head_sha 下的绝对行号 */
export interface MrInline {
	old_path: string;
	new_path: string;
	new_line?: number;
	old_line?: number;
	body: string;
}

/** 预审的评论台账（review skill gitlab-mr.md 第 7 步）：发到 GitLab 的只有这些，Yi 在卡片上看到的也是这些 */
export interface MrLedger {
	base_sha: string;
	start_sha: string;
	head_sha: string;
	level?: string;
	inline: MrInline[];
	summary: string;
}

const INLINE_MARK = "<!-- gitlab-mr-review -->";

/** 【MR评论】段（可能包在 ```json 里）-> 台账；格式不对返回原因 */
export function parseLedger(raw: string): MrLedger | string {
	const text = raw
		.trim()
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/```\s*$/, "");
	let v: any;
	try {
		v = JSON.parse(text);
	} catch (e) {
		return `不是合法的 JSON：${(e as Error).message}`;
	}
	for (const k of ["base_sha", "start_sha", "head_sha"]) if (typeof v?.[k] !== "string" || !v[k]) return `缺少 ${k}`;
	if (typeof v.summary !== "string" || !v.summary.trim()) return "缺少 summary（总结评论）";
	const inline: MrInline[] = [];
	for (const [i, c] of (Array.isArray(v.inline) ? v.inline : []).entries()) {
		const line = (x: unknown) => (Number.isInteger(x) && (x as number) > 0 ? (x as number) : undefined);
		const item = {
			old_path: String(c?.old_path ?? c?.new_path ?? ""),
			new_path: String(c?.new_path ?? c?.old_path ?? ""),
			new_line: line(c?.new_line),
			old_line: line(c?.old_line),
			body: String(c?.body ?? "").trim(),
		};
		if (!item.new_path || !item.body || (!item.new_line && !item.old_line)) return `第 ${i + 1} 条行内评论缺少路径、行号或正文`;
		inline.push(item);
	}
	return {
		base_sha: v.base_sha,
		start_sha: v.start_sha,
		head_sha: v.head_sha,
		level: v.level ? String(v.level) : undefined,
		inline,
		summary: v.summary.trim(),
	};
}

const ledgerKey = (id: string) => `draftmr:ledger:${id}`;
/** 已经发出去的行内评论（下标），中途失败重试时不重复发 */
const postedKey = (id: string) => `draftmr:posted:${id}`;

export function saveLedger(id: string, ledger: MrLedger) {
	setKv(ledgerKey(id), ledger);
}

export type MrAction = "approve" | "note";

export interface DraftMr {
	project: string;
	iid: string;
	url: string;
	/** 已经做过的动作 */
	done: MrAction[];
	/** 预审出的评论台账；没有时「发到 MR」把评审报告整段发成一条评论 */
	ledger?: MrLedger;
}

const doneKey = (id: string) => `draftmr:${id}`;

/** 草稿对应的 MR：分派时记在路由的 info 里（mr 档才有） */
export function draftMrs(drafts: Array<Pick<Draft, "id" | "routeId">>): Map<string, DraftMr> {
	const ids = [...new Set(drafts.map((d) => d.routeId).filter((x): x is number => x != null))];
	const out = new Map<string, DraftMr>();
	if (!ids.length) return out;
	const routes = new Map(
		db()
			.select({ id: schema.routes.id, info: schema.routes.info })
			.from(schema.routes)
			.where(inArray(schema.routes.id, ids))
			.all()
			.map((r) => [r.id, r.info]),
	);
	for (const d of drafts) {
		const info = d.routeId != null ? routes.get(d.routeId) : undefined;
		if (!info?.mrIid || !info.mrProject) continue;
		out.set(d.id, {
			project: info.mrProject,
			iid: info.mrIid,
			url: `https://${glabRepo(info.mrProject)}/-/merge_requests/${info.mrIid}`,
			done: getKv<MrAction[]>(doneKey(d.id), []),
			ledger: getKv<MrLedger | undefined>(ledgerKey(d.id), undefined),
		});
	}
	return out;
}

export async function applyMrAction(id: string, action: MrAction): Promise<void> {
	const d = db().select().from(schema.drafts).where(eq(schema.drafts.id, id)).get();
	if (!d) throw new DraftError("草稿不存在");
	const mr = draftMrs([d]).get(id);
	if (!mr) throw new DraftError("这条草稿不是 MR 预审，没有对应的 MR");
	if (mr.done.includes(action)) throw new DraftError(action === "approve" ? "已经 approve 过了" : "评审意见已经发到 MR 上了");
	const repo = glabRepo(mr.project);
	if (action === "note" && !mr.ledger && !d.report.trim()) throw new DraftError("这条草稿没有评审报告");
	try {
		if (action === "approve") await exec(GLAB_BIN, ["mr", "approve", mr.iid, "-R", repo], { timeout: 60 });
		else if (mr.ledger) await postLedger(id, mr, mr.ledger);
		else await exec(GLAB_BIN, ["mr", "note", "create", mr.iid, "-R", repo, "-m", d.report.trim()], { timeout: 60 });
	} catch (e) {
		log("MR 操作失败", action, mr.project, mr.iid, e);
		if (e instanceof DraftError) throw e;
		throw new DraftError(`${action === "approve" ? "approve" : "发评论"}没有成功：${String((e as Error).message).slice(0, 300)}`);
	}
	setKv(doneKey(id), [...mr.done, action]);
	settle({
		actionKind: "draft",
		actionId: id,
		routeId: d.routeId,
		outcome: action === "approve" ? "mr_approved" : "mr_noted",
		effect: "outward",
		ref: mr.url,
	});
	log("MR", action, mr.project, mr.iid);
	// 评论发到 MR 上，这次预审就办完了：还挂着的草稿（多半是「无需回复」）标成完成，不再留在待办里
	if (action === "note" && claim(id, LIVE, "completed"))
		settle({ actionKind: "draft", actionId: id, routeId: d.routeId, outcome: "completed", effect: "internal", detail: "评论已发到 MR" });
	syncCard(id);
	changed();
}

const glabApi = (method: string, url: string, body?: object) =>
	exec(
		GLAB_BIN,
		["api", "--hostname", GITLAB_HOST, "--method", method, url, ...(body ? ["-H", "Content-Type: application/json", "--input", "-"] : [])],
		{ timeout: 60, stdin: body ? JSON.stringify(body) : undefined },
	);

/**
 * 按台账发评论（review skill post-inline-comments.md）：先核对 head 没变，再逐条发行内评论，最后发总结评论。
 * 位置被 GitLab 拒的那条不悄悄改成普通评论：写进总结评论（注明实际位置），卡片上也提示 Yi
 */
async function postLedger(id: string, mr: DraftMr, ledger: MrLedger) {
	const base = `projects/${encodeURIComponent(mr.project)}/merge_requests/${mr.iid}`;
	const head = JSON.parse(await glabApi("GET", base))?.diff_refs?.head_sha;
	if (head !== ledger.head_sha)
		throw new DraftError(
			`MR 有新提交（预审时 ${ledger.head_sha.slice(0, 8)}，现在 ${String(head).slice(0, 8)}），评论位置过期了，重新预审后再发`,
		);
	const posted = new Set(getKv<number[]>(postedKey(id), []));
	const unplaced: string[] = [];
	for (const [i, c] of ledger.inline.entries()) {
		if (posted.has(i)) continue;
		const body = c.body.includes(INLINE_MARK) ? c.body : `${c.body}\n\n${INLINE_MARK}`;
		const position = {
			position_type: "text",
			base_sha: ledger.base_sha,
			start_sha: ledger.start_sha,
			head_sha: ledger.head_sha,
			old_path: c.old_path,
			new_path: c.new_path,
			...(c.new_line ? { new_line: c.new_line } : {}),
			...(c.old_line ? { old_line: c.old_line } : {}),
		};
		try {
			const res = JSON.parse(await glabApi("POST", `${base}/discussions`, { body, position }));
			if (res?.notes?.[0]?.type !== "DiffNote") log("行内评论没落在 diff 行上", mr.project, mr.iid, i, res?.notes?.[0]?.id);
			posted.add(i);
			setKv(postedKey(id), [...posted]);
		} catch (e) {
			log("行内评论位置被拒", mr.project, mr.iid, c.new_path, c.new_line ?? c.old_line, e);
			unplaced.push(
				`- 实际位置 \`${c.new_path}:${c.new_line ?? c.old_line}\`（未能挂到 diff 行）\n\n${c.body.replace(INLINE_MARK, "").trim()}`,
			);
		}
	}
	let summary = ledger.summary;
	if (unplaced.length) summary = `${summary}\n\n**以下发现未能定位到 diff 行**\n\n${unplaced.join("\n\n")}`;
	const marker = `<!-- gitlab-mr-review head_sha=${ledger.head_sha} level=${ledger.level ?? "standard"} -->`;
	if (!summary.includes("<!-- gitlab-mr-review head_sha=")) summary = `${summary}\n\n${marker}`;
	await glabApi("POST", `${base}/discussions`, { body: summary });
	if (unplaced.length) log(`${unplaced.length} 条行内评论改写进了总结评论`, mr.project, mr.iid);
}
