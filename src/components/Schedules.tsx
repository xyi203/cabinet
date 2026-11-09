// 定时（docs/router-worker.md §5.4）：按启用 / 暂停 / 已结束分组；每条带人话时间、下次运行、最近几次的结果格子，
// 每次运行都是工作台里的一件事，点「上次」打开。看板上一句话新建：本地解析成 cron，预览接下来三次运行再创建（Yi 自己点就是确认）
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
	type AgentStat,
	type Schedule,
	type Story,
	type TaskView,
	deleteSchedule,
	fetchSchedules,
	runSchedule,
	saveSchedule,
} from "../lib/api";
import { AGENT_NAME, time } from "../lib/format";
import { confirmDialog } from "./Confirm";
import { toast } from "./Toast";

type Edit = Pick<Schedule, "name" | "cron" | "agent" | "prompt"> & { id?: string };

const WEEK = "日一二三四五六";
const pad = (n: number) => String(n).padStart(2, "0");

/** 常见的几种 cron 说成人话；认不出的原样给 */
export function humanCron(cron: string): string {
	const [mi, h, dom, mon, dow] = cron.trim().split(/\s+/);
	if (dom !== "*" || mon !== "*") return cron;
	if (/^\*\/\d+$/.test(mi) && h === "*" && dow === "*") return `每 ${mi.slice(2)} 分钟`;
	if (mi === "0" && /^\*\/\d+$/.test(h) && dow === "*") return `每 ${h.slice(2)} 小时`;
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

/** 预览用：接下来 n 次触发时间（只看分、时、周，和服务端常用的写法一致） */
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
	if (every) cron = every[2] === "分钟" ? `*/${every[1]} * * * *` : `0 */${every[1]} * * *`;
	else {
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

const when = (d: Date) => `${d.getMonth() + 1}-${d.getDate()} 周${WEEK[d.getDay()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** 一次运行的结果格子：c 有结论 / n 本轮正常 / f 失败 / r 在跑 */
function cellOf(t: TaskView): [string, string] {
	if (t.status === "in_progress" || t.status === "todo") return ["r", "运行中"];
	if (t.need === "retry") return ["f", "失败"];
	if (t.result === "本轮正常" || t.result === "无变化") return ["n", "无变化"];
	return ["c", t.status === "in_review" ? "有结论，等你看" : "有结论"];
}

export function Schedules({
	agents,
	stories,
	items,
	now,
	onOpenTask,
	onOpenDev,
	onOpenStory,
}: {
	agents: AgentStat[];
	stories: Story[];
	items: TaskView[];
	/** 看板状态里的当前时间（秒）：判断到期、预览下次运行 */
	now: number;
	onOpenTask: (taskId: string) => void;
	onOpenDev: (devId: string) => void;
	onOpenStory: (storyId: string) => void;
}) {
	const qc = useQueryClient();
	const { data: list = [] } = useQuery({ queryKey: ["schedules"], queryFn: fetchSchedules, refetchInterval: 30_000 });
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
			const t = st.tickets.find((x) => x.patrol?.scheduleId === id && !x.removed);
			if (t) return { story: st, ticket: t };
		}
	};
	const ended = (s: Schedule) => !s.enabled && ((s.until != null && s.until <= now) || Boolean(patrolOf(s.id)?.ticket.patrol?.stopped));
	const groups: Array<[string, Schedule[], string]> = [
		["启用", list.filter((s) => s.enabled), ""],
		["暂停", list.filter((s) => !s.enabled && !ended(s)), "不会触发，恢复后接着按时间跑"],
		["已结束", list.filter(ended), "到期或巡检自动停止的"],
	];

	function row(s: Schedule) {
		const runs = items.filter((t) => t.scheduleId === s.id).toSorted((a, b) => a.created - b.created);
		const last = runs.at(-1);
		const p = s.patrol ? patrolOf(s.id) : undefined;
		const b = (label: string, on: () => void, cls = "") => (
			<button className={`btn sm ${cls}`} disabled={busy} onClick={on}>
				{label}
			</button>
		);
		return (
			<div key={s.id} className="srow">
				<div className="tb">
					<div className="nm">
						<span className={`pill ${s.enabled ? "p-done" : "p-off"}`}>{s.enabled ? "启用" : ended(s) ? "已结束" : "暂停"}</span>
						<span className="title">{s.name}</span>
						{p && (
							<button className="story" title={p.story.title} onClick={() => onOpenStory(p.story.id)}>
								{p.ticket.key}
							</button>
						)}
					</div>
					<div className="meta">
						<span>{humanCron(s.cron)}</span>
						<span className="mono">{s.cron}</span>
						<span>交给 {AGENT_NAME[s.agent] ?? s.agent}</span>
						{s.enabled && s.nextRun && (
							<span>
								下次 <b className="mono">{time(s.nextRun).slice(5, 16)}</b>
							</span>
						)}
						{s.enabled && s.until ? <span>{time(s.until).slice(5, 16)} 到期自动停</span> : null}
						{p?.ticket.patrol?.stopped && <span>{p.ticket.patrol.stopped}</span>}
					</div>
					<div className="hist">
						{runs.length > 0 && (
							<span className="sq" aria-label={`最近 ${Math.min(8, runs.length)} 次结果`}>
								{runs.slice(-8).map((t) => {
									const [c, label] = cellOf(t);
									return <i key={t.id} className={c} title={`${time(t.created).slice(5, 16)} ${label}`} onClick={() => onOpenTask(t.id)} />;
								})}
							</span>
						)}
						{last ? (
							<button className="link" onClick={() => onOpenTask(last.id)}>
								上次 {time(last.created).slice(5, 16)} · {cellOf(last)[1]}
							</button>
						) : s.lastTask ? (
							<button className="link" onClick={() => onOpenDev(s.lastTask!)}>
								上次 {s.lastRun ? time(s.lastRun).slice(5, 16) : ""} · 打开
							</button>
						) : (
							<span>还没跑过</span>
						)}
					</div>
					<details className="prompt">
						<summary>提示词{s.patrol ? " · 发布巡检" : ""}</summary>
						<p>{s.prompt}</p>
					</details>
				</div>
				<div className="acts">
					{s.enabled && b("立即运行", () => act(() => runSchedule(s.id).then(onOpenDev), "已开跑，结果在工作台"))}
					{b(
						s.enabled ? "暂停" : ended(s) ? "再开一轮" : "恢复",
						() => act(() => saveSchedule({ ...s, enabled: !s.enabled }), s.enabled ? "已暂停" : "已恢复"),
						"ghost",
					)}
					{b("编辑", () => setEdit({ id: s.id, name: s.name, cron: s.cron, agent: s.agent, prompt: s.prompt }), "ghost")}
					{b(
						"删除",
						async () => {
							if (await confirmDialog({ title: `删除定时任务「${s.name}」？`, confirmText: "删除", danger: true }))
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
			<div className="tools">
				<span className="meta">也可以私聊机器人一句话创建，审批卡片上确认后生效</span>
			</div>
			<div className="newbox">
				<label htmlFor="cron-line">说一句话：什么时候、让助手做什么</label>
				<textarea
					id="cron-line"
					value={line}
					onChange={(e) => {
						setLine(e.target.value);
						setParsed(undefined);
					}}
					placeholder="例如：每个工作日上午 10 点，查一下昨天合进 develop 但还没发布的 MR"
				/>
				{parsed === null && (
					<div className="bad">
						没认出时间。写成「每天 9 点」「每个工作日下午 3 点半」「每周五 17 点」「每 30 分钟」，或者用下面的编辑直接写 cron。
					</div>
				)}
				{parsed && (
					<div className="preview">
						<span>名称</span>
						<input
							id="cron-name"
							className="in wide"
							value={parsed.name}
							onChange={(e) => setParsed({ ...parsed, name: e.target.value })}
							aria-label="名称"
						/>
						<span>什么时候</span>
						<span>
							{humanCron(parsed.cron)} <span className="mono">{parsed.cron}</span>
						</span>
						<span>接下来</span>
						<span className="mono">{preview.map(when).join("　")}</span>
						<span>交给</span>
						<span>助手（只读，写操作照常走审批）；有结论进工作台「等我」</span>
					</div>
				)}
				<div className="oa">
					{parsed ? (
						<button
							className="btn pri sm"
							disabled={busy}
							onClick={async () => {
								const ok = await act(
									() =>
										saveSchedule({
											name: parsed.name,
											cron: parsed.cron,
											agent: choices.find((a) => a.name === "assistant")?.name ?? choices[0]?.name ?? "assistant",
											prompt: line.trim(),
										}),
									`已创建，下次 ${preview[0] ? when(preview[0]) : ""}`,
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
							解析
						</button>
					)}
					{parsed && (
						<button className="btn ghost sm" onClick={() => setParsed(undefined)}>
							重新写
						</button>
					)}
				</div>
			</div>
			{edit && (
				<div className="newbox">
					<label>编辑「{edit.name}」</label>
					<div className="oa">
						<input className="in wide" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} aria-label="名称" />
						<input
							className="in"
							value={edit.cron}
							onChange={(e) => setEdit({ ...edit, cron: e.target.value })}
							title="5 段 cron：分 时 日 月 周，本机时区"
							aria-label="cron"
						/>
						<span className="meta">{humanCron(edit.cron)}</span>
						<select value={edit.agent} onChange={(e) => setEdit({ ...edit, agent: e.target.value })} aria-label="交给">
							{choices.map((a) => (
								<option key={a.name} value={a.name}>
									{AGENT_NAME[a.name] ?? a.name}
								</option>
							))}
						</select>
					</div>
					<textarea value={edit.prompt} onChange={(e) => setEdit({ ...edit, prompt: e.target.value })} aria-label="提示词" />
					<div className="oa">
						<button
							className="btn pri sm"
							disabled={busy}
							onClick={async () => {
								if (await act(() => saveSchedule(edit), "已保存")) setEdit(null);
							}}
						>
							保存
						</button>
						<button className="btn ghost sm" onClick={() => setEdit(null)}>
							取消
						</button>
					</div>
				</div>
			)}
			<div className="legend">
				<span>
					<i className="c" />
					有结论
				</span>
				<span>
					<i className="n" />
					无变化
				</span>
				<span>
					<i className="f" />
					失败
				</span>
				<span>
					<i className="r" />
					运行中
				</span>
				<span>点格子打开那次运行</span>
			</div>
			{groups.map(([name, xs, hint], i) =>
				i === 2 ? (
					<details key={name} className="wgroup more">
						<summary className="gh">
							<h2>{name}</h2>
							<span className="c">{xs.length}</span>
							<span className="hint">{hint}</span>
						</summary>
						{xs.length ? <div className="list">{xs.map(row)}</div> : <div className="empty">没有</div>}
					</details>
				) : (
					<section key={name} className="wgroup">
						<div className="gh">
							<h2>{name}</h2>
							<span className="c">{xs.length}</span>
							{hint && <span className="hint">{hint}</span>}
						</div>
						{xs.length ? <div className="list">{xs.map(row)}</div> : <div className="empty">没有</div>}
					</section>
				),
			)}
		</>
	);
}
