import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type AgentStat, type Schedule, type Story, deleteSchedule, fetchSchedules, runSchedule, saveSchedule } from "../lib/api";
import { AGENT_NAME, time } from "../lib/format";
import { type Msg, MsgLine } from "./Drawer";
import { confirmDialog } from "./Confirm";

const EXAMPLES = [
	["0 9 * * 1-5", "工作日 9:00"],
	["0 */2 * * *", "每 2 小时"],
	["30 18 * * 5", "周五 18:30"],
];

type Draft = Pick<Schedule, "name" | "cron" | "agent" | "prompt"> & { id?: string };

/** 定时任务：到点交给只读 agent 跑一次，结论私聊给你（server/schedules.ts） */
export function Schedules({
	agents,
	stories,
	onOpen,
	onOpenStory,
}: {
	agents: AgentStat[];
	stories: Story[];
	onOpen: (taskId: string) => void;
	onOpenStory: (storyId: string) => void;
}) {
	// 巡检定时任务挂在哪条需求的哪张工单上（需求的 tickets[].patrol.scheduleId）
	const patrolOf = (id: string) => {
		for (const st of stories) {
			const t = st.tickets.find((x) => x.patrol?.scheduleId === id && !x.removed);
			if (t) return { story: st, key: t.key };
		}
	};
	const qc = useQueryClient();
	const { data: items = [] } = useQuery({ queryKey: ["schedules"], queryFn: fetchSchedules, refetchInterval: 30_000 });
	const [edit, setEdit] = useState<Draft | null>(null);
	const [msg, setMsg] = useState<Msg>(null);
	const [busy, setBusy] = useState(false);
	// 开发任务要仓库和分支，简单回应不干活：都不能定时跑
	const choices = agents.filter((a) => a.name !== "dev");
	const refresh = () => qc.invalidateQueries({ queryKey: ["schedules"] });

	async function act(fn: () => Promise<unknown>, ok: string) {
		setBusy(true);
		try {
			await fn();
			setMsg({ text: ok });
			await refresh();
			qc.invalidateQueries({ queryKey: ["state"] });
			return true;
		} catch (e) {
			setMsg({ text: (e as Error).message, bad: true });
			return false;
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="panel schedules">
			<h3>
				定时任务
				{edit && (
					<button className="btn" onClick={() => setEdit(null)}>
						收起
					</button>
				)}
			</h3>
			{/* 新建改成一句话：私聊机器人说要定期做什么，助手出审批卡片，批准后生效；这里只管看、改、停、删 */}
			<div className="foot">私聊机器人一句话新建，例如「每个工作日 9 点查一下昨晚指派给我的告警」，确认审批卡片后生效。</div>
			{edit && (
				<div className="newtask">
					<div className="row">
						<input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="名字，例如：每日告警回顾" />
						<input
							className="cron"
							value={edit.cron}
							onChange={(e) => setEdit({ ...edit, cron: e.target.value })}
							placeholder="分 时 日 月 周"
							title="5 段 cron：分 时 日 月 周，本机时区"
						/>
						<select value={edit.agent} onChange={(e) => setEdit({ ...edit, agent: e.target.value })}>
							{choices.map((a) => (
								<option key={a.name} value={a.name}>
									{AGENT_NAME[a.name] ?? a.name}
								</option>
							))}
						</select>
						{EXAMPLES.map(([c, label]) => (
							<button key={c} className="chip" onClick={() => setEdit({ ...edit, cron: c })}>
								{label}
							</button>
						))}
					</div>
					<textarea
						value={edit.prompt}
						onChange={(e) => setEdit({ ...edit, prompt: e.target.value })}
						placeholder="要它做什么，例如：看一下过去 24 小时 order 服务的告警和 5xx，按影响排个序，只列需要我跟进的"
					/>
					<div className="row">
						<button
							className="btn primary"
							disabled={busy}
							onClick={async () => {
								if (await act(() => saveSchedule(edit), edit.id ? "已保存" : "已创建")) setEdit(null);
							}}
						>
							{edit.id ? "保存" : "创建"}
						</button>
						<span className="foot">每次结论都会私聊你一张卡片；上一次还在跑就跳过这一次。</span>
					</div>
				</div>
			)}
			<MsgLine msg={msg} />
			{!items.length && !edit && <div className="foot">还没有定时任务</div>}
			{items.map((s) => (
				<div key={s.id} className={`sched${s.enabled ? "" : " off"}`}>
					<div className="head">
						{s.patrol && <span className="tag">巡检</span>}
						<b>{s.name}</b>
						<code>{s.cron}</code>
						<span>{AGENT_NAME[s.agent] ?? s.agent}</span>
						<span className="foot">
							{s.enabled ? (s.nextRun ? `下次 ${time(s.nextRun)}` : "不再触发") : "已停用"}
							{s.lastRun ? ` · 上次 ${time(s.lastRun)}` : ""}
						</span>
					</div>
					{s.patrol &&
						(() => {
							const p = patrolOf(s.id);
							return p ? (
								<div className="foot">
									工单 {p.key} · 需求「{p.story.title}」{s.until ? ` · ${time(s.until)} 自动停` : ""}{" "}
									<button className="linkbtn" onClick={() => onOpenStory(p.story.id)}>
										在需求里看全部巡检 ↗
									</button>
								</div>
							) : null;
						})()}
					<div className="desc">{s.prompt}</div>
					<div className="row-inline">
						<button className="btn" disabled={busy} onClick={() => act(() => runSchedule(s.id).then(onOpen), "已开跑")}>
							立即运行
						</button>
						<button
							className="btn"
							disabled={busy}
							onClick={() => act(() => saveSchedule({ ...s, enabled: !s.enabled }), s.enabled ? "已停用" : "已启用")}
						>
							{s.enabled ? "停用" : "启用"}
						</button>
						<button className="btn" onClick={() => setEdit({ id: s.id, name: s.name, cron: s.cron, agent: s.agent, prompt: s.prompt })}>
							编辑
						</button>
						{s.lastTask && (
							<button className="btn" onClick={() => onOpen(s.lastTask!)}>
								上次结果
							</button>
						)}
						<button
							className="btn"
							disabled={busy}
							onClick={async () => {
								if (await confirmDialog({ title: `删除定时任务「${s.name}」？`, confirmText: "删除", danger: true }))
									void act(() => deleteSchedule(s.id), "已删除");
							}}
						>
							删除
						</button>
					</div>
				</div>
			))}
		</div>
	);
}
