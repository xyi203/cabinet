// 助手的 schedule 工具（agent/tools.ts）：列出、新建、修改、暂停、恢复、结束、删除定时任务。
// 列出是只读的，守卫直接放行；其余是写操作，守卫判成「要审批」，Yi 在卡片上批准后由 approvals.ts 调这里的 executeSchedule。
// 校验（checkSchedule）在提交审批前做，写错了当场退回给助手改，不让 Yi 批一张执行不了的卡片
import { modelOptions } from "./agent/models.ts";
import { ASSISTANT, loadAgents } from "./agent/router.ts";
import { checkModel } from "./dev.ts";
import {
	CronError,
	deleteSchedule,
	describeTimes,
	getSchedule,
	listSchedules,
	nextRun,
	parseCron,
	saveSchedule,
	setScheduleEnabled,
	updateSchedule,
} from "./schedules.ts";
import { endScheduleById } from "./stories.ts";
import { now, when } from "./util.ts";

const fmt = (t: number) => when(t);
const nextText = (t: number | null) => (t ? `下次运行 ${fmt(t)}` : "没有下一次了");

export const SCHEDULE_ACTIONS = {
	create: "新建",
	update: "修改",
	pause: "暂停",
	resume: "恢复",
	end: "结束",
	delete: "删除",
} as const;
type Action = keyof typeof SCHEDULE_ACTIONS;

/** 没写 action 就是新建（老的调用只有 name / cron / prompt） */
export const scheduleAction = (args: Record<string, unknown>): string => String(args.action ?? "").trim() || "create";

const str = (v: unknown) => (v == null ? undefined : String(v).trim());

/** 本机时间「YYYY-MM-DD HH:mm」→ unix 秒；格式不对是 NaN */
function local(v: string): number {
	const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(v.trim());
	return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime() / 1000 : Number.NaN;
}

/** schedule 工具的 until：没给是 undefined，格式不对是 NaN */
export function scheduleUntil(args: Record<string, unknown>): number | undefined {
	const v = str(args.until);
	return v ? local(v) : undefined;
}

/** at：只跑一次 / 几次的时间点，逗号或顿号隔开；没给是 undefined，有一个格式不对是 null */
export function scheduleAt(args: Record<string, unknown>): number[] | undefined | null {
	const v = str(args.at);
	if (!v) return undefined;
	const times = v
		.split(/[,，、;；]/)
		.map((x) => x.trim())
		.filter(Boolean)
		.map(local);
	return times.some((t) => Number.isNaN(t)) ? null : times.toSorted((a, b) => a - b);
}

/** model 写 default 是回到助手的默认 */
const modelArg = (args: Record<string, unknown>) => {
	const m = str(args.model);
	return m === undefined ? undefined : m === "default" ? "" : m;
};

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

/** 提交审批前的校验：写错了返回给助手的说明，没问题返回 undefined */
export function checkSchedule(args: Record<string, unknown>): string | undefined {
	const action = scheduleAction(args);
	if (action === "list") return;
	if (!(action in SCHEDULE_ACTIONS)) return "action 只能是 list / create / update / pause / resume / end / delete";
	if (action !== "create") {
		const id = str(args.id);
		if (!id || !getSchedule(id)) return `没有定时任务 ${id || "（没给 id）"}，先用 action=list 查到 id`;
	}
	if (action !== "create" && action !== "update") return;
	const name = str(args.name);
	const prompt = str(args.prompt);
	if (action === "create" && (!name || !prompt)) return "定时任务要有名字（name）和要做的事（prompt）";
	if (action === "update" && (name === "" || prompt === "")) return "name、prompt 不改就别传，传了不能是空的";
	const cron = str(args.cron);
	const at = scheduleAt(args);
	if (cron && at !== undefined) return "cron（重复跑）和 at（只跑一次 / 几次）只给一个";
	if (action === "create" && !cron && at === undefined) return "要给 cron（重复跑）或 at（只跑一次 / 几次）";
	if (cron)
		try {
			parseCron(cron);
		} catch (e) {
			return `cron 写得不对：${(e as CronError).message}。格式是 5 段「分 时 日 月 周」，例如 0 9 * * 1-5`;
		}
	if (at === null) return "at 写成本机时间 YYYY-MM-DD HH:mm，几个时间用逗号隔开";
	if (at && !at.some((t) => t > now())) return "at 给的时间都已经过了";
	const until = scheduleUntil(args);
	if (until !== undefined && !(until > now())) return "until 要写成晚于现在的本机时间，格式 YYYY-MM-DD HH:mm";
	const model = modelArg(args);
	const thinking = str(args.thinking);
	try {
		checkModel(model || undefined, thinking || undefined);
	} catch (e) {
		return `${(e as Error).message}。可选的模型：${modelOptions()
			.map((m) => m.id)
			.join("、")}`;
	}
}

const modelLine = (args: Record<string, unknown>) => {
	const m = modelArg(args);
	const t = str(args.thinking);
	if (m === undefined && !t) return "";
	return `- 模型：${m || "助手默认"}${t ? `，思考强度 ${t}` : ""}`;
};

const timeLines = (args: Record<string, unknown>) => {
	const at = scheduleAt(args);
	const until = scheduleUntil(args);
	const cron = str(args.cron);
	const lines: string[] = [];
	if (at) lines.push(`- 时间：${describeTimes(at)}，跑完自动结束`);
	else if (cron) {
		const runs = nextRuns(cron)
			.filter((t) => until === undefined || t <= until)
			.map(fmt)
			.join("、");
		lines.push(`- cron：\`${cron}\`（接下来：${runs || "算不出"}）`);
	}
	if (until !== undefined) lines.push(`- 结束：${fmt(until)}，之后自动停用`);
	return lines;
};

/** 审批卡片上「要执行什么」 */
export function describeSchedule(args: Record<string, unknown>): string {
	const action = scheduleAction(args) as Action;
	if (action === "create")
		return [`新建定时任务「${args.name}」`, ...timeLines(args), modelLine(args), `- 到点交给助手做：${args.prompt}`]
			.filter(Boolean)
			.join("\n");
	const id = String(args.id ?? "");
	const s = getSchedule(id);
	const head = `${SCHEDULE_ACTIONS[action] ?? action}定时任务「${s?.name ?? id}」（${id}）`;
	if (action === "update")
		return [
			head,
			str(args.name) ? `- 改名：${args.name}` : "",
			...timeLines(args),
			modelLine(args),
			str(args.prompt) ? `- 到点改成做：${args.prompt}` : "",
		]
			.filter(Boolean)
			.join("\n");
	if (action === "delete") return `${head}\n- 删除后不能恢复，已经运行过的记录还留在工作台`;
	return head;
}

/** Yi 批准后执行，返回卡片上和发回给助手的结果 */
export function executeSchedule(args: Record<string, unknown>): string {
	const action = scheduleAction(args) as Action;
	const at = scheduleAt(args) ?? undefined;
	const model = modelArg(args);
	const thinking = str(args.thinking);
	if (action === "create") {
		const s = saveSchedule({
			name: String(args.name),
			cron: at ? describeTimes(at) : String(args.cron),
			prompt: String(args.prompt),
			agent: loadAgents().router.agent ?? ASSISTANT,
			until: scheduleUntil(args) ?? null,
			model: model || null,
			thinking: thinking || null,
			times: at ?? null,
		});
		return `已建定时任务 ${s.id}「${s.name}」，${nextText(s.nextRun)}`;
	}
	const id = String(args.id);
	if (action === "update") {
		const s = updateSchedule(id, {
			name: str(args.name),
			cron: str(args.cron),
			prompt: str(args.prompt),
			until: scheduleUntil(args),
			model,
			thinking: thinking === undefined ? (model === "" ? "" : undefined) : thinking,
			times: at,
		});
		return `已修改定时任务 ${s.id}「${s.name}」，${s.enabled ? nextText(s.nextRun) : "现在是停用的"}`;
	}
	if (action === "pause" || action === "resume") {
		const s = setScheduleEnabled(id, action === "resume");
		return action === "pause" ? `已暂停定时任务「${s.name}」` : `已恢复定时任务「${s.name}」，${nextText(s.nextRun)}`;
	}
	const name = getSchedule(id)?.name ?? id;
	if (action === "end") {
		endScheduleById(id);
		return `已结束定时任务「${name}」，执行记录还在`;
	}
	deleteSchedule(id);
	return `已删除定时任务「${name}」`;
}

/** action=list：给助手看的定时任务清单，改、停都要用这里的 id */
export function listScheduleText(): string {
	const t = now();
	const rows = listSchedules().toSorted((a, b) => Number(b.enabled) - Number(a.enabled) || b.updated - a.updated);
	if (!rows.length) return "还没有定时任务。";
	return rows
		.map((s) => {
			const state = s.enabled ? "启用" : s.until != null && s.until <= t ? "已结束" : "已暂停";
			const parts = [
				`${s.id}「${s.name}」${state}`,
				s.times?.length ? s.cron : `cron \`${s.cron}\``,
				s.enabled && s.nextRun ? `下次 ${fmt(s.nextRun)}` : "",
				s.until != null && s.until > t ? `${fmt(s.until)} 自动停` : "",
				s.model ? `模型 ${s.model}${s.thinking ? `（${s.thinking}）` : ""}` : "",
				s.patrol ? "发布巡检" : "",
			].filter(Boolean);
			const prompt = s.prompt.replace(/\s+/g, " ");
			return `- ${parts.join(" · ")}\n  做什么：${prompt.length > 160 ? `${prompt.slice(0, 160)}…` : prompt}`;
		})
		.join("\n");
}
