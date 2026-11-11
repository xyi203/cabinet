// 写操作审批（docs/redesign.md 阶段 2）：守卫把 agent 的写操作判成「要审批」时，这里记一条、私聊 Yi 一张卡片；
// Yi 点「执行」才由 cabinet 按记录原样执行（执行前按会话当前的策略再复核一次），结果回到原处：
// agent 任务作为新消息发回任务；起草的交给那条消息的草稿改写；其余只在卡片上显示。
// - 同一条只执行一次：pending -> running 原子切换
// - 24 小时没处理就过期
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { guardFor, setApprovalHandler, type ApprovalHandler } from "./agent/driver.ts";
import { type Learn, rememberRead, tokenize } from "./agent/guard.ts";
import { callMcp } from "./agent/mcp.ts";
import { ASSISTANT, loadAgents } from "./agent/router.ts";
import { changed } from "./bus.ts";
import { OWNER_OPEN_ID, PORT } from "./config.ts";
import { db, schema } from "./db/index.ts";
import type { Approval } from "./db/schema.ts";
import { messageDev } from "./dev.ts";
import { applyDraftAction } from "./drafts/actions.ts";
import { queuePatch, sendCardToUserAsBot } from "./lark/bot.ts";
import { CronError, nextRun, parseCron, saveSchedule } from "./schedules.ts";
import { ticketsCreated } from "./stories.ts";
import { execFile } from "node:child_process";
import { footnote } from "./drafts/card.ts";
import { log, now, when } from "./util.ts";

export const APPROVAL_TTL = 86400;
const RESULT_MAX = 3000;

export class ApprovalError extends Error {}

export const getApproval = (id: string) => db().select().from(schema.approvals).where(eq(schema.approvals.id, id)).get();

export function pendingApprovals(): Approval[] {
	return db().select().from(schema.approvals).where(eq(schema.approvals.status, "pending")).orderBy(desc(schema.approvals.created)).all();
}

const fmt = (t: number) => when(t);

/** schedule 工具的 until：本机时间「YYYY-MM-DD HH:mm」→ unix 秒；没给是 undefined，格式不对是 NaN */
export function scheduleUntil(args: Record<string, unknown>): number | undefined {
	const v = String(args.until ?? "").trim();
	if (!v) return;
	const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(v);
	return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime() / 1000 : Number.NaN;
}

/** 定时任务的参数：名字、cron、内容都要有，cron 要能解析，给了结束时间要晚于现在 */
export function checkSchedule(args: Record<string, unknown>): string | undefined {
	const name = String(args.name ?? "").trim();
	const prompt = String(args.prompt ?? "").trim();
	if (!name || !prompt) return "定时任务要有名字（name）和要做的事（prompt）";
	try {
		parseCron(String(args.cron ?? ""));
	} catch (e) {
		return `cron 写得不对：${(e as CronError).message}。格式是 5 段「分 时 日 月 周」，例如 0 9 * * 1-5`;
	}
	const until = scheduleUntil(args);
	if (until !== undefined && !(until > now())) return "until 要写成晚于现在的本机时间，格式 YYYY-MM-DD HH:mm";
}

/** 接下来几次运行时间 */
export function nextRuns(cron: string, n = 3, from = now()): number[] {
	const out: number[] = [];
	let t = from;
	for (let i = 0; i < n; i++) {
		const next = nextRun(cron, t);
		if (!next) break;
		out.push(next);
		t = next;
	}
	return out;
}

/** 这条审批能不能「执行并以后放行」：只有没登记的 skill 脚本 / 子命令可以，规则里明确是写操作的不行 */
export function learnOf(a: Pick<Approval, "tool" | "args" | "convId" | "cwd">): Learn | undefined {
	if (a.tool !== "bash" || a.convId == null) return undefined;
	const g = guardFor(a.convId);
	return g?.guard.learnable(String(a.args.command ?? ""), a.cwd || g.cwd);
}

export const learnText = (l: Learn) => (l.isNew ? `新建规则 ${l.rule}，放行 ${l.sub}` : `${l.rule} 的 ${l.sub} 记成只读`);

/** 卡片上「要执行什么」 */
export function describe(a: Pick<Approval, "tool" | "args">): string {
	if (a.tool === "bash") return "```\n" + String(a.args.command ?? "") + "\n```";
	if (a.tool === "schedule") {
		const until = scheduleUntil(a.args);
		const runs = nextRuns(String(a.args.cron))
			.filter((t) => until === undefined || t <= until)
			.map(fmt)
			.join("、");
		return [
			`新建定时任务「${a.args.name}」`,
			`- cron：\`${a.args.cron}\`（接下来：${runs || "算不出"}）`,
			until !== undefined ? `- 结束：${fmt(until)}，之后自动停用` : "",
			`- 到点交给助手做：${a.args.prompt}`,
		]
			.filter(Boolean)
			.join("\n");
	}
	// 发布工单的 params 是多行文字，JSON 里只剩一串 \n，审批时看不清要写进去的内容
	const { params, ...rest } = a.args as { params?: unknown };
	const lines = Array.isArray(params)
		? params.map(
				(p: { paramKey?: string; paramValue?: unknown }) =>
					`**${p.paramKey}**\n\`\`\`\n${String(p.paramValue ?? "").slice(0, 800)}\n\`\`\``,
			)
		: [];
	const json = JSON.stringify(lines.length ? rest : a.args, null, 2).slice(0, 1500);
	return [`调用 \`${a.tool}\`\n\`\`\`\n${json}\n\`\`\``, ...lines].join("\n");
}

const plain = (content: string) => ({ tag: "plain_text", content });
const note = (content: string, color = "grey") => ({
	tag: "div",
	text: { tag: "plain_text", content, text_color: color, text_size: "notation" },
});
// 颜色：等你批准和正在执行的青绿，结束的灰，执行出错的红
const STATUS: Record<string, [string, string]> = {
	pending: ["等你批准", "turquoise"],
	running: ["正在执行…", "turquoise"],
	done: ["已执行", "grey"],
	failed: ["执行出错", "red"],
	rejected: ["已拒绝", "grey"],
	expired: ["已过期（超过 24 小时没处理）", "grey"],
};

export function approvalCard(a: Approval): object {
	const [subtitle, template] = STATUS[a.status] ?? [a.status, "grey"];
	const elements: object[] = [
		{ tag: "markdown", content: `**来源**：${a.origin || "未知"}\n**原因**：${a.reason}` },
		{ tag: "markdown", content: describe(a) },
	];
	if (a.result)
		elements.push({ tag: "markdown", content: `**${a.status === "rejected" ? "拒绝理由" : "结果"}**\n${a.result.slice(0, 1500)}` });
	if (a.status === "pending") {
		const learn = learnOf(a);
		elements.push({ tag: "hr" });
		if (learn) elements.push(note(`确认它只读、不改东西的话，可以点「批准，以后不再问」（${learnText(learn)}）`));
		elements.push({
			tag: "form",
			name: "apv",
			elements: [
				{ tag: "input", name: "note", placeholder: plain("拒绝的话可以写一句理由，助手会看到"), max_length: 300, width: "fill" },
				{
					tag: "column_set",
					horizontal_spacing: "8px",
					columns: [
						["apv_ok", "批准", "primary_filled", "approve"],
						...(learn ? [["apv_learn", "批准，以后不再问", "default", "approve_remember"]] : []),
						["apv_no", "拒绝", "default", "reject"],
					].map(([name, label, type, act]) => ({
						tag: "column",
						width: "auto",
						elements: [
							{
								tag: "button",
								name,
								text: plain(label),
								type,
								form_action_type: "submit",
								behaviors: [{ type: "callback", value: { k: "apv", a: act, t: a.id } }],
							},
						],
					})),
				},
			],
		});
	}
	elements.push(footnote(`${fmt(a.created)} 发起`, `http://127.0.0.1:${PORT}/`));
	return {
		schema: "2.0",
		config: { update_multi: true, summary: { content: `审批：${a.reason}` } },
		header: {
			title: plain(
				`审批：${
					a.tool === "bash"
						? String(a.args.command ?? "")
								.split(/\s+/)
								.slice(0, 3)
								.join(" ")
						: a.tool
				}`.slice(0, 60),
			),
			subtitle: plain(subtitle),
			template,
		},
		body: { elements },
	};
}

function sync(id: string) {
	const a = getApproval(id);
	if (a?.dm)
		queuePatch(a.dm, () => {
			const cur = getApproval(id);
			return cur && approvalCard(cur);
		});
	changed();
}

/** 守卫判成「要审批」时由 driver 调：记一条、发卡片，返回给 agent 的拦截说明 */
export const createApproval: ApprovalHandler = (req) => {
	if (req.tool === "schedule") {
		const bad = checkSchedule(req.args);
		if (bad) return bad;
	}
	const id = `apv-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
	const row: Approval = {
		id,
		created: now(),
		status: "pending",
		tool: req.tool,
		args: req.args,
		reason: req.reason,
		origin: req.origin?.label ?? "",
		convId: req.convId,
		cwd: req.cwd,
		devTaskId: req.origin?.devTaskId ?? null,
		draftReplyTo: req.origin?.draftReplyTo ?? null,
		dm: null,
		result: null,
		decided: null,
	};
	db().insert(schema.approvals).values(row).run();
	changed();
	log("写操作待审批", id, req.tool, req.reason);
	if (OWNER_OPEN_ID)
		void sendCardToUserAsBot(OWNER_OPEN_ID, approvalCard(row))
			.then((dm) => {
				db().update(schema.approvals).set({ dm }).where(eq(schema.approvals.id, id)).run();
				// 发卡片的同时 Yi 可能已经在看板上处理了
				sync(id);
			})
			.catch((e) => log("审批卡片发送失败", id, e));
	const back = req.origin?.devTaskId
		? "Yi 处理后，执行结果（或拒绝理由）会作为新消息发给你"
		: req.origin?.draftReplyTo
			? "Yi 批准后会按执行结果再改写这条草稿；这一轮先在【备注】里写清要执行什么、为什么"
			: "结果只在审批卡片上给 Yi 看；这一轮先在回复里写清要执行什么、为什么";
	return `已提交审批 ${id}（${req.reason}）。${back}。不要换个写法重试，也不要重复提交。`;
};

/** 跑命令，出错时带上完整输出（通用的 exec 只留 300 字，报错那行常被截掉）；成功返回输出，失败抛出 */
export function run(cmd: string, args: string[], cwd: string): Promise<string> {
	return new Promise((resolve, reject) =>
		execFile(cmd, args, { cwd, timeout: 120_000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
			const out = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
			if (err)
				reject(
					new ApprovalError(`退出码 ${(err as { code?: unknown }).code ?? err.message}：\n${out || err.message}`.slice(0, RESULT_MAX)),
				);
			else resolve(out || "（没有输出）");
		}),
	);
}

/** 按记录执行：执行前按会话当前策略复核，仍判成「要审批」才执行 */
async function execute(a: Approval): Promise<string> {
	if (a.tool === "schedule") {
		const s = saveSchedule({
			name: String(a.args.name),
			cron: String(a.args.cron),
			prompt: String(a.args.prompt),
			agent: loadAgents().router.agent ?? ASSISTANT,
			until: scheduleUntil(a.args) ?? null,
		});
		return `已建定时任务 ${s.id}「${s.name}」，下次运行 ${s.nextRun ? fmt(s.nextRun) : "无"}`;
	}
	const g = a.convId != null ? guardFor(a.convId) : undefined;
	if (!g) throw new ApprovalError("找不到发起这次调用的会话权限，不执行");
	const args = { ...a.args };
	const v = g.guard.verdict(a.tool, args, a.cwd || g.cwd);
	if (v.kind !== "approve")
		throw new ApprovalError(v.kind === "deny" ? `现在的规则不允许：${v.reason}` : "现在的规则把它当成只读，不用审批，让助手直接执行");
	if (a.tool === "bash") {
		const tokens = tokenize(String(args.command ?? ""));
		if (typeof tokens === "string" || !tokens.length) throw new ApprovalError(`命令解析失败：${tokens}`);
		return run(tokens[0], tokens.slice(1), a.cwd || g.cwd);
	}
	return callMcp(a.tool, args);
}

/** 草稿还在等 Yi 处理时，按执行结果改写；Yi 已经发了或不发了就不动 */
function pendingDraftOf(replyTo: string) {
	return db()
		.select()
		.from(schema.drafts)
		.where(and(eq(schema.drafts.replyTo, replyTo), inArray(schema.drafts.status, ["pending", "noreply"])))
		.orderBy(desc(schema.drafts.created))
		.get();
}

async function followUp(a: Approval, text: string, approved: boolean) {
	try {
		if (a.devTaskId) await messageDev(a.devTaskId, text);
		else if (a.draftReplyTo && approved) {
			const d = pendingDraftOf(a.draftReplyTo);
			if (d) await applyDraftAction(d.id, "revise", `${text}\n按这个结果更新草稿和备注。`);
		}
	} catch (e) {
		log("审批结果回写失败", a.id, e);
	}
}

/** Yi 点执行 / 拒绝（卡片和看板共用）。执行是异步的：先切到 running 返回，跑完更新卡片 */
/** remember：执行成功后把这条命令记成只读（见 learnOf），以后同样的子命令直接放行 */
export async function decideApproval(id: string, action: "approve" | "reject", why = "", remember = false): Promise<Approval> {
	const a = getApproval(id);
	if (!a) throw new ApprovalError("找不到这条审批");
	if (a.status !== "pending") throw new ApprovalError(`这条审批${STATUS[a.status]?.[0] ?? a.status}`);
	if (now() - a.created > APPROVAL_TTL) {
		expire(a.id);
		throw new ApprovalError("超过 24 小时没处理，已经过期了；需要的话让助手重新发起");
	}
	const next = action === "approve" ? "running" : "rejected";
	const res = db()
		.update(schema.approvals)
		.set({ status: next, decided: now(), result: action === "reject" ? why.trim() || "（没写理由）" : null })
		.where(and(eq(schema.approvals.id, id), eq(schema.approvals.status, "pending")))
		.run();
	if (!res.changes) throw new ApprovalError("这条审批刚被处理过");
	sync(id);
	if (action === "reject") {
		void followUp(a, `Yi 拒绝了审批 ${id}（${describe(a)}）。理由：${why.trim() || "没写"}。不要再试这个操作，按 Yi 的意思调整。`, false);
		return getApproval(id)!;
	}
	void (async () => {
		let status = "done";
		let result: string;
		try {
			// 先算好要学的规则：执行前后规则文件都可能被改，以批准这一刻的判断为准
			const learn = remember ? learnOf(a) : undefined;
			result = (await execute(a)).slice(0, RESULT_MAX);
			if (learn) {
				try {
					rememberRead(learn);
					result = `（已${learnText(learn)}，以后直接放行）\n${result}`;
					log("审批时记成只读", id, learn);
				} catch (e) {
					log("记规则失败", id, e);
				}
			}
		} catch (e) {
			status = "failed";
			result = String((e as Error).message ?? e).slice(0, RESULT_MAX);
		}
		db().update(schema.approvals).set({ status, result }).where(eq(schema.approvals.id, id)).run();
		log("审批执行", id, status);
		sync(id);
		if (status === "done") ticketsCreated(a.tool, a.devTaskId, result);
		await followUp(
			a,
			status === "done"
				? `Yi 批准了审批 ${id}，已执行：\n${describe(a)}\n结果：\n${result}`
				: `Yi 批准了审批 ${id}，但执行出错：\n${result}`,
			true,
		);
	})();
	return getApproval(id)!;
}

function expire(id: string) {
	db()
		.update(schema.approvals)
		.set({ status: "expired", decided: now() })
		.where(and(eq(schema.approvals.id, id), eq(schema.approvals.status, "pending")))
		.run();
	sync(id);
}

/** 过期没处理的审批 */
export function expireApprovals(t = now()): number {
	const stale = db()
		.select({ id: schema.approvals.id })
		.from(schema.approvals)
		.where(and(eq(schema.approvals.status, "pending"), lt(schema.approvals.created, t - APPROVAL_TTL)))
		.all();
	for (const { id } of stale) expire(id);
	return stale.length;
}

/** 重启时还在 running 的（执行到一半进程退出）：不知道执行没执行，标成出错让 Yi 去看 */
function recoverRunning() {
	db()
		.update(schema.approvals)
		.set({ status: "failed", result: "执行过程中 cabinet 重启了，不确定有没有执行成功，请到对应系统里确认" })
		.where(eq(schema.approvals.status, "running"))
		.run();
}

let timer: NodeJS.Timeout | undefined;
export function startApprovals() {
	setApprovalHandler(createApproval);
	recoverRunning();
	expireApprovals();
	timer = setInterval(() => expireApprovals(), 3_600_000);
	timer.unref();
}
