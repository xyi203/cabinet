// MR 预审：收到 MR 链接先用机器人回个 Get；预审（review skill）出的评论台账由 Yi 在卡片上过目，
// 点了才发到 GitLab（行内评论 + 总结评论），另外可以 approve。
// 这些动作都由 Yi 在卡片或看板上点出来（点击本身就是确认），以 Yi 的 glab 身份执行；和回复对方的草稿互不影响，草稿发出后也能点。
// 办成后以 Yi 的身份在贴 MR 的那条消息的话题里回「approved」/「已评论」（announceMr）。
// 例外：评审没发现任何要作者处理的问题时不等 Yi 点，直接批准（autoApprove，Yi 定的规则）。
import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { changed } from "../bus.ts";
import { GLAB_BIN } from "../config.ts";
import { db, deleteKv, getKv, listKv, schema, setKv } from "../db/index.ts";
import type { Draft } from "../db/schema.ts";
import { GITLAB_HOST, glabRepo, MR_RE } from "../agent/router.ts";
import { markHandled } from "../handled.ts";
import { react, sendTextAsUser } from "../lark/bot.ts";
import type { Message } from "../lark/types.ts";
import { settle } from "../pipeline.ts";
import { routeRules } from "../rules.ts";
import { exec, log } from "../util.ts";
import { claim, DraftError, getDraft, LIVE, syncCard } from "./store.ts";

/** 收到要预审的 MR 先回的表情：告诉对方收到了，评审结论 Yi 过目后才发到 MR 上 */
export const MR_ACK_EMOJI = "Get";

/**
 * 机器人身份（和 lark-cli --as bot 同一个应用）在 MR 链接那条消息上回 Get，每条消息只回一次（重启接回、手动重试不重复）。
 * 不用 Yi 的身份：Yi 回过表情的消息会被当成「已亲自回复」，草稿直接作废。机器人不在这个会话里（别人私聊 Yi）时回不上，只记日志
 */
export async function ackMr(chatMode: string, m: Pick<Message, "message_id">) {
	if (chatMode === "meego" || chatMode === "doc") return;
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

/** 复审时对旧线程的动作（review skill mr-re-review.md）：已修复或作者回复成立的 resolve，回复不成立的回一次 */
export interface MrThreadAction {
	discussion_id: string;
	action: "resolve" | "reply";
	/** reply 的正文；resolve 也可以带一句说明，先回复再 resolve */
	body?: string;
}

/** 预审的评论台账（review skill gitlab-mr.md 第 7 步）：发到 GitLab 的只有这些，Yi 在卡片上看到的也是这些 */
export interface MrLedger {
	base_sha: string;
	start_sha: string;
	head_sha: string;
	level?: string;
	inline: MrInline[];
	/** 复审才有 */
	threads?: MrThreadAction[];
	summary: string;
	/** agent 判断可以直接通过（结论 ✅、没有待确认的问题）：再经 cleanReview 核对，系统自动批准 */
	approve?: boolean;
}

export const INLINE_MARK = "<!-- gitlab-mr-review -->";
const REPLY_MARK = "<!-- gitlab-mr-review reply -->";

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
	const threads: MrThreadAction[] = [];
	for (const [i, t] of (Array.isArray(v.threads) ? v.threads : []).entries()) {
		const id = String(t?.discussion_id ?? "").trim();
		const action = t?.action === "resolve" || t?.action === "reply" ? t.action : undefined;
		const body = String(t?.body ?? "").trim();
		if (!id || !action) return `第 ${i + 1} 条线程动作缺少 discussion_id 或 action（resolve / reply）`;
		if (action === "reply" && !body) return `第 ${i + 1} 条线程回复没有正文`;
		threads.push({ discussion_id: id, action, ...(body ? { body } : {}) });
	}
	return {
		base_sha: v.base_sha,
		start_sha: v.start_sha,
		head_sha: v.head_sha,
		level: v.level ? String(v.level) : undefined,
		inline,
		...(threads.length ? { threads } : {}),
		summary: v.summary.trim(),
		...(v.approve === true ? { approve: true } : {}),
	};
}

const ledgerKey = (id: string) => `draftmr:ledger:${id}`;
/** 已经发出去的行内评论（下标），中途失败重试时不重复发；线程动作记成 t<下标> */
const postedKey = (id: string) => `draftmr:posted:${id}`;

export function saveLedger(id: string, ledger: MrLedger) {
	setKv(ledgerKey(id), ledger);
}

export type MrAction = "approve" | "note" | "rereview";

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

/** sha：批准时要求 MR 的 head 还是这个提交（自动批准用，审过的才批）。返回在原消息下回话没成功的提示，成功是空串 */
export async function applyMrAction(id: string, action: MrAction, opts: { sha?: string } = {}): Promise<string> {
	const d = db().select().from(schema.drafts).where(eq(schema.drafts.id, id)).get();
	if (!d) throw new DraftError("草稿不存在");
	const mr = draftMrs([d]).get(id);
	if (!mr) throw new DraftError("这条草稿不是 MR 预审，没有对应的 MR");
	if (action === "rereview") {
		// 复审要跑好几分钟：先回，做完另发一张卡片
		const { reReview } = await import("./actions.ts");
		void reReview(id, "Yi 要求复审").catch((e) => {
			log("复审失败", id, e);
			syncCard(id, `复审没有成功：${(e as Error).message.slice(0, 200)}`);
		});
		return "";
	}
	if (mr.done.includes(action)) throw new DraftError(action === "approve" ? "这个 MR 已经批准过了" : "已经发到 MR 上了");
	const repo = glabRepo(mr.project);
	if (action === "note" && !mr.ledger && !d.report.trim()) throw new DraftError("这条草稿没有评审报告");
	try {
		if (action === "approve")
			await exec(GLAB_BIN, ["mr", "approve", mr.iid, "-R", repo, ...(opts.sha ? ["--sha", opts.sha] : [])], { timeout: 60 });
		else if (mr.ledger) await postLedger(id, mr, mr.ledger);
		else await exec(GLAB_BIN, ["mr", "note", "create", mr.iid, "-R", repo, "-m", d.report.trim()], { timeout: 60 });
	} catch (e) {
		log("MR 操作失败", action, mr.project, mr.iid, e);
		if (e instanceof HeadMoved) {
			// 评论位置对不上新提交了：直接按新提交复审，不让 Yi 再点一次
			const { reReview } = await import("./actions.ts");
			void reReview(id, e.message).catch((err) => log("复审失败", id, err));
			throw new DraftError(`${e.message}，评论的位置可能对不上了。已开始按新提交复审，好了另发一张卡片`);
		}
		if (e instanceof DraftError) throw e;
		throw new DraftError(`${action === "approve" ? "批准 MR" : "发评论"}没有成功：${String((e as Error).message).slice(0, 300)}`);
	}
	setKv(doneKey(id), [...mr.done, action]);
	// GitLab 上办成了，在原消息的话题里告诉对方一声；没回上不影响 MR 上的结果，卡片上提示 Yi
	const told = await announceMr(d, action).then(
		() => "",
		(e) => {
			log("MR 结果回话题失败", action, d.replyTo, e);
			return `已${action === "approve" ? "批准" : "发到 MR"}，但在原消息下回「${MR_DONE_REPLY[action]}」没成功：${String((e as Error).message).slice(0, 100)}`;
		},
	);
	// 评论发出去了：开始盯这个 MR，对方推了新提交或在线程里回复就复审（mrwatch.ts）
	if (action === "note") await watchMr(mr, id, mr.ledger?.head_sha).catch((e) => log("开始盯 MR 失败", mr.url, e));
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
	syncCard(id, told);
	changed();
	return told;
}

/** approve / 发评论之后回给对方的话（Yi 定的） */
export const MR_DONE_REPLY: Record<Exclude<MrAction, "rereview">, string> = { approve: "approved", note: "已评论" };

/**
 * 以 Yi 的身份在贴 MR 的那条消息下回一句：群里回到话题里（还没有话题就由这条开出来），之后对方在话题里接着说，
 * 复审能顺着话题根挂回这个 MR；私聊引用回复。点「批准」「发到 MR」本身就是 Yi 的确认。
 * 发出的这条记成已处理：轮询再看到它不当成 Yi 亲自回复，不去作废这张卡片（发完评论可能还要批准），也不当口吻样本
 */
export async function announceMr(
	d: Pick<Draft, "id" | "chatMode" | "replyTo">,
	action: Exclude<MrAction, "rereview">,
	send: typeof sendTextAsUser = sendTextAsUser,
) {
	if (d.chatMode === "meego" || !d.replyTo.startsWith("om_")) return;
	const sent = await send(
		{ replyTo: d.replyTo, inThread: d.chatMode !== "p2p" },
		MR_DONE_REPLY[action],
		`mr-${action}-${d.id}`.slice(0, 50),
	);
	markHandled([sent]);
}

/**
 * 评审没问题：agent 标了可以直接通过，台账里也确实没有要发的行内评论、没有要回复作者的旧线程。
 * 只信 agent 的标记不够（它可能漏写评论），只看台账为空也不够（没审成也可能是空的）
 */
export const cleanReview = (l: MrLedger) => l.approve === true && !l.inline.length && !(l.threads ?? []).some((t) => t.action === "reply");

/**
 * 预审 / 复审出了新一版、评审没问题：直接批准（钉在审过的 head 上，之后又推了提交就不批），在原消息下回 approved。
 * 没有要回对方的话、也没有要处理的旧线程时，这次预审就办完了。Yi 改写出的版本不走这里，由他自己点
 */
export async function autoApprove(id: string): Promise<void> {
	const d = getDraft(id);
	const mr = d ? draftMrs([d]).get(id) : undefined;
	if (!d || !mr?.ledger || !cleanReview(mr.ledger) || mr.done.includes("approve")) return;
	log("评审没发现问题，自动批准", mr.url, mr.ledger.head_sha.slice(0, 8));
	let told: string;
	try {
		told = await applyMrAction(id, "approve", { sha: mr.ledger.head_sha });
	} catch (e) {
		log("自动批准失败", mr.url, e);
		syncCard(id, `评审没发现问题，但自动批准没成功：${String((e as Error).message).slice(0, 200)}`);
		return;
	}
	if (!mr.ledger.threads?.length && claim(id, ["noreply"], "completed"))
		settle({
			actionKind: "draft",
			actionId: id,
			routeId: d.routeId,
			outcome: "completed",
			effect: "internal",
			detail: "评审没问题，已自动批准",
		});
	syncCard(id, `评审没发现问题，已自动批准${told ? `。${told}` : "，并在原消息下回了 approved"}`);
	changed();
}

export const glabApi = (method: string, url: string, body?: object) =>
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
		throw new HeadMoved(`MR 有了新提交（审的是 ${ledger.head_sha.slice(0, 8)}，现在是 ${String(head).slice(0, 8)}）`);
	const posted = new Set(getKv<Array<number | string>>(postedKey(id), []));
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
	// 复审的线程动作：回复带标记（下次复审认得出是自己回过的），resolve 用 PUT
	for (const [i, t] of (ledger.threads ?? []).entries()) {
		const k = `t${i}`;
		if (posted.has(k)) continue;
		const thread = `${base}/discussions/${encodeURIComponent(t.discussion_id)}`;
		if (t.body) await glabApi("POST", `${thread}/notes`, { body: t.body.includes(REPLY_MARK) ? t.body : `${t.body}\n\n${REPLY_MARK}` });
		if (t.action === "resolve") await glabApi("PUT", `${thread}?resolved=true`);
		posted.add(k);
		setKv(postedKey(id), [...posted]);
	}
	let summary = ledger.summary;
	if (unplaced.length) summary = `${summary}\n\n**以下发现未能定位到 diff 行**\n\n${unplaced.join("\n\n")}`;
	const marker = `<!-- gitlab-mr-review head_sha=${ledger.head_sha} level=${ledger.level ?? "standard"} -->`;
	if (!summary.includes("<!-- gitlab-mr-review head_sha=")) summary = `${summary}\n\n${marker}`;
	await glabApi("POST", `${base}/discussions`, { body: summary });
	if (unplaced.length) log(`${unplaced.length} 条行内评论改写进了总结评论`, mr.project, mr.iid);
}

/** 发评论前 MR 又有了新提交 */
class HeadMoved extends Error {}

// ---------- 盯 MR：评论发出后，对方推新提交或在线程里回复就复审（mrwatch.ts 轮询） ----------

export interface MrWatch {
	project: string;
	iid: string;
	url: string;
	/** 最近一版 MR 预审草稿：复审接着它的会话 */
	draftId: string;
	/** 已经审过的 head */
	head: string;
	/** 看到过的最大 note id：比它新的才算新回复；undefined 时第一次轮询只记下来 */
	seenNote?: number;
	/** 新 head 先等它稳定一会儿再复审（对方常连推几次） */
	pendingHead?: string;
	pendingSince?: number;
	/** 复审开跑的时间：跑完删掉这条盯梢；还标着说明在跑（或者跑到一半进程退出了，见 mrwatch.ts REVIEWING_GRACE） */
	reviewing?: number;
	since: number;
}

export const watchKey = (project: string, iid: string) => `mrwatch:${project}!${iid}`;

export async function watchMr(mr: Pick<DraftMr, "project" | "iid" | "url">, draftId: string, head?: string) {
	const base = `projects/${encodeURIComponent(mr.project)}/merge_requests/${mr.iid}`;
	const h = head ?? JSON.parse(await glabApi("GET", base))?.diff_refs?.head_sha;
	if (!h) return;
	setKv(watchKey(mr.project, mr.iid), {
		project: mr.project,
		iid: mr.iid,
		url: mr.url,
		draftId,
		head: h,
		since: Date.now() / 1000,
	} satisfies MrWatch);
}

export const listWatches = () => listKv<MrWatch>("mrwatch:").map((x) => x.value);
export const saveWatch = (w: MrWatch) => setKv(watchKey(w.project, w.iid), w);
export const unwatch = (w: Pick<MrWatch, "project" | "iid">) => deleteKv(watchKey(w.project, w.iid));

// ---------- 跟进：没带链接的「已更新，继续 CR」挂回前面那次 CR ----------

/**
 * 对方改完了请 Yi 再看。没带 MR 链接时靠这类说法认出是在催复审；只认「改了 / 再看」，
 * 不认单独的「看下」「帮忙」：同一个人几天里贴过 MR，之后问别的事也常说「帮忙看下」
 */
export const MR_FOLLOW_RE =
	/已更新|更新(了|好)|改(好|完)了?|已(修改|改|调整|处理|修复|提交|推)|(修改|调整|处理|修复|提交|push|推)(好|完)?了|继续\s*(cr|review|看|审)|再\s*(帮忙|帮我)?\s*(cr|review|看|瞅|过|审)|复审|re-?review|重新\s*(cr|review|看|审)/i;

export interface MrFollow {
	/** 认定的 MR（gitlab:<project>!<iid>）；几个都可能时为空，交给 Yi 定 */
	ref?: string;
	candidates: string[];
	/** 怎么认出来的，写进路由规则和提示 */
	via: "回复原消息" | "同一会话";
}

const mrRefs = (refs: string[]) => refs.filter((r) => r.startsWith("gitlab:"));

/** gitlab:<project>!<iid> -> project / iid / url */
export function parseMrRef(ref: string): Pick<DraftMr, "project" | "iid" | "url"> | undefined {
	const m = /^gitlab:(.+)!(\d+)$/.exec(ref);
	if (m) return { project: m[1], iid: m[2], url: `https://${glabRepo(m[1])}/-/merge_requests/${m[2]}` };
}

/**
 * 没带 MR 链接、但像是在催复审的消息挂到哪次 CR 上：
 * - 回复原消息、话题里回复：原消息（话题根）提到的 MR
 * - 否则同一个会话（群主线、私聊，按同一个人）重开时间内对方贴过的 MR
 * 只有一个才认定；不止一个返回候选、不挑，交给 Yi 定。不像催复审或者找不到 MR 返回 undefined
 */
export function mrFollowup(m: { thread: string; senderId: string; text: string; at: number; rootRefs: string[] }): MrFollow | undefined {
	if (MR_RE.test(m.text) || !MR_FOLLOW_RE.test(m.text)) return;
	let candidates = [...new Set(mrRefs(m.rootRefs))];
	let via: MrFollow["via"] = "回复原消息";
	if (!candidates.length) {
		via = "同一会话";
		const t = schema.triggers;
		const rows = db()
			.select({ refs: t.refs })
			.from(t)
			.where(and(eq(t.thread, m.thread), eq(t.actorId, m.senderId), gte(t.at, m.at - routeRules().reopen), lt(t.at, m.at)))
			.orderBy(desc(t.at))
			.limit(50)
			.all();
		candidates = [...new Set(rows.flatMap((r) => mrRefs(r.refs)))];
	}
	if (!candidates.length) return;
	return { ...(candidates.length === 1 ? { ref: candidates[0] } : {}), candidates, via };
}

/** 这个 MR 最近一版预审草稿（首轮或复审出的新一版）：复审接着它的报告和台账 */
export function lastMrDraft(project: string, iid: string): Draft | undefined {
	const r = schema.routes;
	return db()
		.select()
		.from(schema.drafts)
		.innerJoin(r, eq(schema.drafts.routeId, r.id))
		.where(and(sql`json_extract(${r.info}, '$.mrProject') = ${project}`, sql`json_extract(${r.info}, '$.mrIid') = ${iid}`))
		.orderBy(desc(schema.drafts.created))
		.limit(1)
		.get()?.drafts;
}

/**
 * 复审的要求（review skill mr-re-review.md）：盯 MR 触发、Yi 点复审（drafts/actions.ts reReview），
 * 和对方没带链接催复审（drafts/make.ts）共用。head 是上次审到的提交，台账里没有时用 watch 记的
 */
export function reReviewAsk(report: string, mr: Pick<DraftMr, "done" | "ledger"> | undefined, reason: string, head?: string): string {
	const noted = Boolean(mr?.done.includes("note"));
	const from = mr?.ledger?.head_sha ?? head;
	return [
		`上一轮评审报告：\n${report || "（无）"}`,
		`上一轮的评论台账${noted ? "（已经发到 MR 上了）" : "（还没发）"}：\n${mr?.ledger ? JSON.stringify(mr.ledger, null, 2) : "（无）"}`,
		`这次是复审，原因：${reason}。`,
		`按 review skill 的 references/mr-re-review.md 做：上次审到的 head 是 ${from ?? "MR 总结评论标记里的 head_sha"}，只审它之后的增量（force-push 就全量审并说明）；` +
			"读 MR 的 discussions，本工具开的线程（首条 note 带 `<!-- gitlab-mr-review -->`）逐个判断，已修复、或作者回复成立的 resolve，回复不成立的回复一次，都写进台账的 threads。" +
			(noted
				? "台账只放这一轮要新发的内容，上一轮已经发出去的评论不要再写。"
				: "上一轮台账还没发，这一轮的台账要包含仍然成立的旧发现，替代上一轮。"),
		"按 MR 预审的输出格式完整输出（回复、【评审报告】、【MR评论】三段都要有），评审报告开头写清这一轮看了什么、旧线程处理结果。",
	].join("\n\n");
}
