// 定时（docs/router-worker.md §5.4）：按已启用 / 已暂停 / 已结束分组；每条带人话时间、下次运行、最近几次的结果格子，
// 每次运行都是工作台里的一件事，点格子或「上次」打开。看板上一句话新建：本地解析成 cron，预览接下来三次运行再创建（Yi 自己点就是确认）
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
	type AgentStat,
	type Schedule,
	type Story,
	type ScheduleRun,
	type TaskView,
	deleteSchedule,
	fetchScheduleRuns,
	fetchSchedules,
	runSchedule,
	saveSchedule,
} from "../lib/api";
import { AGENT_NAME, hm, money, time, waitingOn, when } from "../lib/format";
import { confirmDialog } from "./Confirm";
import { Drawer } from "./Drawer";
import { Markdown } from "./Markdown";
import { dur } from "./ui";
import { toast } from "./Toast";

/** until：结束时间（datetime-local 的值，空 = 不自动停）；fixed：按时间点跑的任务原来的说明，时间一栏没改就沿用原来的时间点 */
type Edit = Pick<Schedule, "name" | "agent" | "prompt"> & { id: string; at: string; until: string; until0: string; fixed?: string };

/** 秒 ↔ datetime-local 输入框的值（本地时间） */
const toLocal = (t: number) => new Date(t * 1000).toLocaleString("sv-SE", { hour12: false }).slice(0, 16).replace(" ", "T");
const fromLocal = (v: string) => (v ? new Date(v).getTime() / 1000 : null);
const editOf = (s: Schedule): Edit => ({
	id: s.id,
	name: s.name,
	at: s.cron,
	agent: s.agent,
	prompt: s.prompt,
	until: s.until != null ? toLocal(s.until) : "",
	until0: s.until != null ? toLocal(s.until) : "",
	fixed: s.times?.length ? s.cron : undefined,
});

const WEEK = "日一二三四五六";
const pad = (n: number) => String(n).padStart(2, "0");

/** 常见的几种 cron 说成人话；认不出的原样给 */
export function humanCron(cron: string): string {
	const [mi, h, dom, mon, dow] = cron.trim().split(/\s+/);
	if (dom !== "*" || mon !== "*") return cron;
	if (/^\*\/\d+$/.test(mi) && h === "*" && dow === "*") return `每 ${mi.slice(2)} 分钟`;
	if (mi === "0" && /^\*\/\d+$/.test(h) && dow === "*") return `每 ${h.slice(2)} 小时`;
	if (/^\d+$/.test(mi) && h === "*" && dow === "*") return +mi ? `每小时第 ${+mi} 分钟` : "每小时整点";
	if (!/^\d+$/.test(mi) || !/^\d+(,\d+)*$/.test(h)) return cron;
	const at = h
		.split(",")
		.map((x) => `${pad(+x)}:${pad(+mi)}`)
		.join("、");
	if (dow === "*") return `每天 ${at}`;
	if (dow === "1-5") return `每个工作日 ${at}`;
	if (/^\d(,\d)*$/.test(dow))
		return `每周${dow
			.split(",")
			.map((d) => WEEK[+d % 7])
			.join("、")} ${at}`;
	return cron;
}

function field(f: string, v: number): boolean {
	if (f === "*") return true;
	return f.split(",").some((p) => {
		if (p.startsWith("*/")) return v % +p.slice(2) === 0;
		if (p.includes("-")) {
			const [a, b] = p.split("-").map(Number);
			return v >= a && v <= b;
		}
		return +p === v || (p === "7" && v === 0);
	});
}

/** 预览用：接下来 n 次触发时间。只看分、时、周，够覆盖 parseOneLine 生成的写法；日、月有限定的不要拿来预览 */
export function nextRuns(cron: string, n: number, from: number): Date[] {
	const [mi, h, , , dow] = cron.trim().split(/\s+/);
	const out: Date[] = [];
	const d = new Date(from);
	d.setSeconds(0, 0);
	for (let i = 0; i < 31 * 1440 && out.length < n; i++) {
		d.setMinutes(d.getMinutes() + 1);
		if (field(mi, d.getMinutes()) && field(h, d.getHours()) && field(dow, d.getDay())) out.push(new Date(d));
	}
	return out;
}

/** 一句话 → 名字 + cron。认「每天 / 每个工作日 / 每周X」+「N 点（M 分 / 半）」，「每 N 分钟 / 小时」；认不出返回 null */
export function parseOneLine(text: string): { name: string; cron: string } | null {
	let cron: string | undefined;
	const every = /每\s*(\d+)\s*(分钟|小时)/.exec(text);
	if (every) {
		const n = +every[1];
		// */0 不是合法 cron；超过一个周期的（每 90 分钟）cron 表达不了，会被当成每小时一次，不如说没认出
		if (n < 1 || n > (every[2] === "分钟" ? 59 : 23)) return null;
		cron = every[2] === "分钟" ? `*/${n} * * * *` : `0 */${n} * * *`;
	} else {
		const m = /(\d{1,2})\s*[点:：]\s*(半|\d{1,2})?/.exec(text);
		if (!m) return null;
		let h = +m[1];
		const mi = m[2] === "半" ? 30 : m[2] ? +m[2] : 0;
		if (/下午|晚上/.test(text) && h < 12) h += 12;
		if (h > 23 || mi > 59) return null;
		const w = /每周([一二三四五六日天])/.exec(text);
		const dow = /工作日/.test(text) ? "1-5" : w ? String(w[1] === "天" ? 0 : WEEK.indexOf(w[1])) : "*";
		cron = `${mi} ${h} * * ${dow}`;
	}
	const name =
		text
			.replace(/每天|每个?工作日|每周[一二三四五六日天]|每\s*\d+\s*(分钟|小时)|上午|下午|晚上|\d{1,2}\s*[点:：]\s*(半|\d{1,2}\s*分?)?/g, "")
			.replace(/^[，,。\s]+/, "")
			.slice(0, 30) || "定时任务";
	return { name, cron };
}

/** 编辑时的「时间」：5 段 cron 原样用，否则当一句话解析；认不出返回 null */
const looksLikeCron = (v: string) => /^[\d*,/-]+(\s+[\d*,/-]+){4}$/.test(v.trim());
const cronOf = (v: string) => (looksLikeCron(v) ? v.trim() : (parseOneLine(v)?.cron ?? null));

/** 预览里的触发时间：今天、明天直接说；再往后带上星期几，方便核对「工作日」「每周X」 */
function runAt(d: Date, now: number) {
	const s = when(d.getTime() / 1000, now);
	return /^\d/.test(s) ? s.replace(" ", ` 周${WEEK[d.getDay()]} `) : s;
}

/** 一次运行的结果格子：c 有结论 / n 正常、无变化 / f 失败 / r 在跑 */
function cellOf(t: TaskView): [string, string] {
	if (t.status === "in_progress" || t.status === "todo") return ["r", "运行中"];
	if (t.need === "retry") return ["f", "失败"];
	if (t.result === "本轮正常") return ["n", "正常"];
	if (t.result === "无变化") return ["n", "无变化"];
	if (t.status === "cancelled") return ["n", t.result ?? "已取消"];
	return ["c", waitingOn(t) ? "有结论，等你处理" : "有结论"];
}

/** 时间：认得出的说人话，cron 原文放悬停提示；认不出的只能给原文 */
function Cron({ cron }: { cron: string }) {
	// 按时间点跑的任务 cron 一栏是说明文字（「全量后 5 / 15 / 30 / 60 分钟」）
	if (!/^[\d*/,\- ]+$/.test(cron.trim())) return <span>{cron}</span>;
	const h = humanCron(cron);
	return h === cron ? <code>{cron}</code> : <span title={`cron：${cron}`}>{h}</span>;
}

export function Schedules({
	agents,
	stories,
	items,
	now,
	onOpenTask,
	onOpenStory,
	openId,
	onOpenSched,
}: {
	agents: AgentStat[];
	stories: Story[];
	items: TaskView[];
	/** 看板状态里的当前时间（秒）：判断到期、预览下次运行 */
	now: number;
	/** 打开工作台里的那件事；fromSched：从哪个定时任务的详情点进来，能返回 */
	onOpenTask: (taskId: string, fromSched?: string) => void;
	onOpenStory: (storyId: string) => void;
	/** 打开详情的定时任务（URL 里的 sched） */
	openId?: string;
	onOpenSched: (id: string | null) => void;
}) {
	// 从结果格子点进来时默认展开那一次
	const [focusTask, setFocusTask] = useState<string | undefined>();
	const openSched = (id: string, task?: string) => {
		setFocusTask(task);
		onOpenSched(id);
	};
	const qc = useQueryClient();
	const { data: list } = useQuery({ queryKey: ["schedules"], queryFn: fetchSchedules, refetchInterval: 30_000 });
	const [edit, setEdit] = useState<Edit | null>(null);
	const [line, setLine] = useState("");
	const [parsed, setParsed] = useState<{ name: string; cron: string } | null | undefined>(undefined);
	const [busy, setBusy] = useState(false);
	// 开发任务要仓库和分支，不能定时跑
	const choices = agents.filter((a) => a.name !== "dev");

	async function act(fn: () => Promise<unknown>, ok: string) {
		setBusy(true);
		try {
			await fn();
			toast(ok);
			await qc.invalidateQueries({ queryKey: ["schedules"] });
			void qc.invalidateQueries({ queryKey: ["state"] });
			return true;
		} catch (e) {
			toast((e as Error).message, true);
			return false;
		} finally {
			setBusy(false);
		}
	}
	// 巡检定时任务挂在哪条需求的哪张工单上（需求的 tickets[].patrol.scheduleId）
	const patrolOf = (id: string) => {
		for (const st of stories) {
			const t = st.tickets.find((x) => (x.patrol?.scheduleId === id || x.fullPatrol?.scheduleId === id) && !x.removed);
			if (t) return { story: st, ticket: t, stopped: t.patrol?.scheduleId === id ? t.patrol.stopped : t.fullPatrol?.stopped };
		}
	};
	const ended = (s: Schedule) => !s.enabled && ((s.until != null && s.until <= now) || Boolean(patrolOf(s.id)?.stopped));
	const all = list ?? [];
	const groups: Array<[string, Schedule[]]> = [
		["已启用", all.filter((s) => s.enabled)],
		["已暂停", all.filter((s) => !s.enabled && !ended(s))],
		["已结束", all.filter(ended)],
	];
	const hasRuns = all.some((s) => items.some((t) => t.scheduleId === s.id));

	const btn = (label: string, on: () => void, cls = "") => (
		<button className={`btn sm ${cls}`} disabled={busy} onClick={on}>
			{label}
		</button>
	);

	function editRow(e: Edit) {
		const cron = e.fixed && e.at.trim() === e.fixed ? e.fixed : cronOf(e.at);
		// 没动结束时间就不传：输入框只到分钟，原样传回去会把秒抹掉，已过期的也会被当成新设的结束时间
		const until = e.until === e.until0 ? undefined : fromLocal(e.until);
		return (
			<div key={e.id} className="srow">
				<div className="sedit">
					<label htmlFor="sedit-name">名称</label>
					<input id="sedit-name" value={e.name} onChange={(x) => setEdit({ ...e, name: x.target.value })} />
					<label htmlFor="sedit-at">时间</label>
					<div className="at">
						<input
							id="sedit-at"
							value={e.at}
							onChange={(x) => setEdit({ ...e, at: x.target.value })}
							placeholder="每天 9 点，或 5 段 cron"
							title="可以写「每个工作日 10 点」这样的话，也可以写 5 段 cron：分 时 日 月 周"
						/>
						{cron ? (
							cron !== e.at.trim() || humanCron(cron) !== cron ? (
								<span>{humanCron(cron)}</span>
							) : null
						) : (
							<span className="bad">没认出时间</span>
						)}
					</div>
					<label htmlFor="sedit-until">结束</label>
					<div className="at">
						<input
							id="sedit-until"
							type="datetime-local"
							value={e.until}
							onChange={(x) => setEdit({ ...e, until: x.target.value })}
							title="到这个时间自动停用，留空一直跑"
						/>
						{e.until ? (
							<button type="button" className="linkbtn" onClick={() => setEdit({ ...e, until: "" })}>
								不自动停
							</button>
						) : (
							<span>不自动停</span>
						)}
					</div>
					{choices.length > 1 && (
						<>
							<label htmlFor="sedit-agent">交给</label>
							<select id="sedit-agent" value={e.agent} onChange={(x) => setEdit({ ...e, agent: x.target.value })}>
								{choices.map((a) => (
									<option key={a.name} value={a.name}>
										{AGENT_NAME[a.name] ?? a.name}
									</option>
								))}
							</select>
						</>
					)}
					<label htmlFor="sedit-prompt">提示词</label>
					<textarea id="sedit-prompt" value={e.prompt} onChange={(x) => setEdit({ ...e, prompt: x.target.value })} />
					<div className="oa">
						<button
							className="btn pri sm"
							disabled={busy || !cron || !e.name.trim() || !e.prompt.trim()}
							onClick={async () => {
								if (
									cron &&
									(await act(() => saveSchedule({ id: e.id, name: e.name, cron, agent: e.agent, prompt: e.prompt, until }), "已保存"))
								)
									setEdit(null);
							}}
						>
							保存
						</button>
						<button className="btn ghost sm" onClick={() => setEdit(null)}>
							取消
						</button>
					</div>
				</div>
			</div>
		);
	}

	function row(s: Schedule) {
		if (edit?.id === s.id) return editRow(edit);
		const runs = items.filter((t) => t.scheduleId === s.id).toSorted((a, b) => a.created - b.created);
		const last = runs.at(-1);
		const p = s.patrol ? patrolOf(s.id) : undefined;
		const done = ended(s);
		return (
			<div
				key={s.id}
				className="srow click"
				tabIndex={0}
				aria-label={`${s.name}：查看执行记录`}
				onClick={() => openSched(s.id)}
				onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && openSched(s.id)}
			>
				<div className="tb">
					<div className="nm">
						<span className="title">{s.name}</span>
						{p && (
							<button
								className="story"
								title={p.story.title}
								onClick={(e) => {
									e.stopPropagation();
									onOpenStory(p.story.id);
								}}
							>
								查看需求
							</button>
						)}
					</div>
					<div className="meta">
						<Cron cron={s.cron} />
						{s.agent !== "assistant" && <span>交给{AGENT_NAME[s.agent] ?? s.agent}</span>}
						{s.enabled && s.nextRun && <span className="num">下次 {when(s.nextRun, now)}</span>}
						{s.until != null &&
							(s.enabled ? (
								<span className="num">{when(s.until, now)} 自动停止</span>
							) : s.until <= now ? (
								<span className="num">{when(s.until, now)} 到期</span>
							) : null)}
						{p?.stopped && <span>{p.stopped}</span>}
					</div>
					<div className="hist">
						{runs.length > 0 && (
							<span className="sq" aria-label={`最近 ${Math.min(8, runs.length)} 次结果`}>
								{runs.slice(-8).map((t) => {
									const [c, label] = cellOf(t);
									return (
										<i
											key={t.id}
											className={c}
											title={`${time(t.created)} ${label}`}
											onClick={(e) => {
												e.stopPropagation();
												openSched(s.id, t.id);
											}}
										/>
									);
								})}
							</span>
						)}
						{last ? (
							<span className="num">
								上次 {when(last.created, now)} {cellOf(last)[1]}
							</span>
						) : s.lastRun ? (
							<span className="num">上次 {when(s.lastRun, now)}</span>
						) : (
							<span>还没运行过</span>
						)}
					</div>
				</div>
				<div className="acts" onClick={(e) => e.stopPropagation()}>
					{s.enabled && btn("运行一次", () => act(() => runSchedule(s.id).then(() => openSched(s.id)), "已开始运行"))}
					{btn(
						s.enabled ? "暂停" : done ? "重新启用" : "恢复",
						() => act(() => saveSchedule({ ...s, enabled: !s.enabled }), s.enabled ? "已暂停" : done ? "已重新启用" : "已恢复"),
						"ghost",
					)}
					{btn("编辑", () => setEdit(editOf(s)), "ghost")}
					{btn(
						"删除",
						async () => {
							if (
								await confirmDialog({
									title: `删除定时任务「${s.name}」？`,
									body: "删除后不能恢复。已经运行过的记录还留在工作台。",
									confirmText: "删除",
								})
							)
								void act(() => deleteSchedule(s.id), "已删除");
						},
						"ghost",
					)}
				</div>
			</div>
		);
	}

	const preview = parsed ? nextRuns(parsed.cron, 3, now * 1000) : [];
	return (
		<>
			<div className="newbox">
				<label htmlFor="cron-line">用一句话新建定时任务</label>
				<textarea
					id="cron-line"
					value={line}
					onChange={(e) => {
						setLine(e.target.value);
						setParsed(undefined);
					}}
					placeholder="比如：每个工作日上午 10 点，查一下昨天合进 develop 但还没发布的 MR"
				/>
				{parsed === null && (
					<div className="bad">没认出时间，可以写成「每天 9 点」「每个工作日下午 3 点半」「每周五 17 点」「每 30 分钟」</div>
				)}
				{parsed && (
					<div className="preview">
						<label htmlFor="cron-name">名称</label>
						<input
							id="cron-name"
							className="in wide"
							value={parsed.name}
							onChange={(e) => setParsed({ ...parsed, name: e.target.value })}
						/>
						<span>时间</span>
						<Cron cron={parsed.cron} />
						<span>接下来</span>
						<span className="runs num">
							{preview.map((d) => (
								<span key={d.getTime()}>{runAt(d, now)}</span>
							))}
						</span>
						<span>结果</span>
						<span>有结论放进工作台，和上次比没变化就不打扰你</span>
					</div>
				)}
				<div className="oa">
					{parsed ? (
						<button
							className="btn pri sm"
							disabled={busy || !parsed.name.trim()}
							onClick={async () => {
								const ok = await act(
									() =>
										saveSchedule({
											name: parsed.name.trim(),
											cron: parsed.cron,
											agent: choices.find((a) => a.name === "assistant")?.name ?? choices[0]?.name ?? "assistant",
											prompt: line.trim(),
										}),
									preview[0] ? `已创建，下次 ${runAt(preview[0], now)}` : "已创建",
								);
								if (ok) {
									setLine("");
									setParsed(undefined);
								}
							}}
						>
							创建
						</button>
					) : (
						<button className="btn sm" disabled={!line.trim()} onClick={() => setParsed(parseOneLine(line))}>
							预览
						</button>
					)}
					<span className="meta">也可以在飞书私聊机器人创建</span>
				</div>
			</div>
			{hasRuns && (
				<div className="legend">
					<span>
						<i className="c" />
						有结论
					</span>
					<span>
						<i className="n" />
						正常或无变化
					</span>
					<span>
						<i className="f" />
						失败
					</span>
					<span>
						<i className="r" />
						运行中
					</span>
					<span>点一行查看全部执行记录</span>
				</div>
			)}
			{list && !list.length && <p className="m-0 text-[14px] text-muted">还没有定时任务</p>}
			{groups.map(([name, xs], i) =>
				!xs.length ? null : i === 2 ? (
					// 已结束的只留着查记录，默认收起
					<details key={name} className="wgroup more">
						<summary className="gh">
							<h2>{name}</h2>
							<span className="c">{xs.length}</span>
						</summary>
						<div className="list">{xs.map(row)}</div>
					</details>
				) : (
					<section key={name} className="wgroup">
						<div className="gh">
							<h2>{name}</h2>
							<span className="c">{xs.length}</span>
						</div>
						<div className="list">{xs.map(row)}</div>
					</section>
				),
			)}
			{openId &&
				(() => {
					const s = all.find((x) => x.id === openId);
					if (!s) return null;
					return (
						<ScheduleDrawer
							key={s.id}
							s={s}
							now={now}
							items={items}
							focusTask={focusTask}
							busy={busy}
							onClose={() => onOpenSched(null)}
							onOpenTask={(id) => onOpenTask(id, s.id)}
							onRun={() => act(() => runSchedule(s.id), "已开始运行，结果会出现在执行记录里")}
							onToggle={() => act(() => saveSchedule({ ...s, enabled: !s.enabled }), s.enabled ? "已暂停" : "已恢复")}
							onEdit={() => {
								onOpenSched(null);
								setEdit(editOf(s));
							}}
						/>
					);
				})()}
		</>
	);
}

const RUN_PILL: Record<ScheduleRun["outcome"], string> = {
	conclusion: "p-read",
	quiet: "p-q",
	failed: "p-fail",
	running: "p-run",
	skipped: "p-off",
};
const RUN_FILTERS: Array<[string, ScheduleRun["outcome"] | null]> = [
	["全部", null],
	["有结论", "conclusion"],
	["失败", "failed"],
	["跳过", "skipped"],
];

/**
 * 一个定时任务的详情：什么时候跑、做什么，以及全部执行记录（新的在前，按天分组）。
 * 每条点开就地看完整结论或报错；还在工作台里的，能跳到那件事的详情（能返回这里）
 */
function ScheduleDrawer({
	s,
	now,
	items,
	focusTask,
	busy,
	onClose,
	onOpenTask,
	onRun,
	onToggle,
	onEdit,
}: {
	s: Schedule;
	now: number;
	items: TaskView[];
	/** 从结果格子点进来的那一次：默认展开 */
	focusTask?: string;
	busy: boolean;
	onClose: () => void;
	onOpenTask: (taskId: string) => void;
	onRun: () => void;
	onToggle: () => void;
	onEdit: () => void;
}) {
	const { data: runs, isLoading } = useQuery({
		queryKey: ["schedule-runs", s.id, s.lastRun],
		queryFn: () => fetchScheduleRuns(s.id),
		refetchInterval: 30_000,
		placeholderData: (prev) => prev,
	});
	const [filter, setFilter] = useState<ScheduleRun["outcome"] | null>(null);
	const [expanded, setExpanded] = useState<number | null>(null);
	const focusRun = focusTask ? runs?.find((r) => r.taskId === focusTask)?.at : undefined;
	const openAt = expanded ?? focusRun ?? null;
	const count = (o: ScheduleRun["outcome"]) => runs?.filter((r) => r.outcome === o).length ?? 0;
	const shown = (runs ?? []).filter((r) => !filter || r.outcome === filter);
	const inBoard = new Set(items.map((t) => t.id));
	// 按天分组：今天 / 昨天 / 11月7日
	const days: Array<[string, ScheduleRun[]]> = [];
	for (const r of shown) {
		const d = when(r.at, now).split(" ")[0];
		if (days.at(-1)?.[0] === d) days.at(-1)![1].push(r);
		else days.push([d, [r]]);
	}
	const total = runs?.length ?? 0;
	const parts = (
		[
			["有结论", count("conclusion")],
			["正常或无变化", count("quiet")],
			["失败", count("failed")],
			["跳过", count("skipped")],
		] as Array<[string, number]>
	).filter(([, n]) => n > 0);
	return (
		<Drawer
			title={s.name}
			onClose={onClose}
			actions={
				<>
					{s.enabled && (
						<button className="btn primary" disabled={busy} onClick={onRun}>
							运行一次
						</button>
					)}
					<button className="btn" disabled={busy} onClick={onToggle}>
						{s.enabled ? "暂停" : "恢复"}
					</button>
					<button className="btn" disabled={busy} onClick={onEdit}>
						编辑
					</button>
				</>
			}
		>
			<div className="meta">
				<Cron cron={s.cron} />
				{s.agent !== "assistant" && <span>交给{AGENT_NAME[s.agent] ?? s.agent}</span>}
				{s.enabled && s.nextRun ? <span className="num">下次 {when(s.nextRun, now)}</span> : <span>已暂停</span>}
				{s.until != null && s.enabled && <span className="num">{when(s.until, now)} 自动停止</span>}
			</div>
			<details className="ctxwrap">
				<summary>提示词</summary>
				<div className="body prompt-body">{s.prompt}</div>
			</details>
			<div className="runs-h">
				<h3>执行记录</h3>
				{total > 0 && (
					<span className="meta num">
						{total >= 200 ? "最近 200 次" : `共 ${total} 次`}：{parts.map(([l, n]) => `${l} ${n} 次`).join("，")}
					</span>
				)}
			</div>
			{total > 0 && RUN_FILTERS.some(([, o]) => o && count(o) > 0) && (
				<div className="chips">
					{RUN_FILTERS.filter(([, o]) => !o || count(o) > 0).map(([l, o]) => (
						<button key={l} className={`chip${filter === o ? " on" : ""}`} aria-pressed={filter === o} onClick={() => setFilter(o)}>
							{l}
							{o && <span className="num"> {count(o)}</span>}
						</button>
					))}
				</div>
			)}
			{isLoading && !runs ? (
				<p className="calm">加载中…</p>
			) : !total ? (
				<p className="calm">还没运行过。到点后每次运行都会记在这里。</p>
			) : (
				days.map(([d, rs]) => (
					<section key={d} className="runday">
						<div className="label">{d}</div>
						<ul className="runlist">
							{rs.map((r) => {
								const open = openAt === r.at;
								const expandable = Boolean(r.detail) || (r.taskId != null && inBoard.has(r.taskId));
								return (
									<li key={r.at} className={open ? "open" : undefined}>
										<button
											className="runhead"
											aria-expanded={expandable ? open : undefined}
											disabled={!expandable}
											onClick={() => setExpanded(open ? -1 : r.at)}
										>
											<span className="num t">{hm(r.at)}</span>
											<span className={`pill ${RUN_PILL[r.outcome]}`}>{r.waiting ? "待查看" : r.label}</span>
											{/* 展开后下面就是完整内容，这里不再重复摘要 */}
											<span className="b clamp">{open && r.detail ? "" : r.brief}</span>
											<span className="num m">
												{[r.seconds != null ? dur(r.seconds) : "", r.cost != null ? money(r.cost) : ""].filter(Boolean).join("，")}
											</span>
										</button>
										{open && (
											<div className="rundetail">
												{r.outcome === "failed" ? <div className="err">{r.detail}</div> : r.detail && <Markdown text={r.detail} />}
												{r.taskId && inBoard.has(r.taskId) && (
													<div className="oa">
														<button className="btn sm" onClick={() => onOpenTask(r.taskId!)}>
															查看详情
														</button>
													</div>
												)}
											</div>
										)}
									</li>
								);
							})}
						</ul>
					</section>
				))
			)}
		</Drawer>
	);
}
