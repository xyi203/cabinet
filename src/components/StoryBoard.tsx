import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { type DevTask, type Schedule, type State, type Story, fetchRepos, fetchSchedules, post, runSchedule } from "../lib/api";
import { AGENT_NAME, ago, ticketUrl, time, waitingOn, when } from "../lib/format";
import { Drawer, type Msg, MsgLine } from "./Drawer";
import { humanCron } from "./Schedules";

/** 需求任务的四个阶段，加一个「不再跟进」收起来 */
const STAGES: Array<[string, string]> = [
	["dev", "开发中"],
	["test", "测试中"],
	["release", "发布中"],
	["done", "已发布"],
];
const DROPPED = "不再跟进";
const STAGE_NAME: Record<string, string> = { ...Object.fromEntries(STAGES), dropped: DROPPED };
const TYPE_NAME: Record<string, string> = { story: "需求", issue: "缺陷" };
const TASK_STATUS: Record<string, string> = {
	running: "进行中",
	review: "待查看",
	failed: "失败",
	pushing: "推送中",
	pushed: "已创建 MR",
	done: "已完成",
	discarded: "已放弃",
};
const TASK_STATUS_COLOR: Record<string, string> = { review: "text-accent", failed: "text-bad" };

/** 巡检每 30 分钟一轮，不进任务列表，在发布工单下面看 */
const tasksOf = (state: State, id: string) => state.devTasks.filter((t) => t.storyId === id && !t.patrol);
/** 解绑的留着记录（免得刷新时又自动挂回来），不显示 */
const ticketsOf = (s: Story) => s.tickets.filter((t) => !t.removed);
const SOURCE_NAME: Record<string, string> = { auto: "按飞书工单自动关联", manual: "手动绑定", created: "从这里提交的" };
/** 巡检正常时结论第一行就是这句（server/dev.ts 的 PATROL_OK） */
const PATROL_OK = "本轮巡查正常";
/** 和上一轮比没变化时第一行写这句（server/dev.ts 的 NO_CHANGE），也算正常，不能当成异常 */
const NO_CHANGE = "本轮无变化";
const roundState = (t: DevTask) =>
	// 审批结果回来接着跑的那轮，第一行先说审批，「本轮巡查正常」在后面；异常的结论不会带这句
	t.status === "running"
		? "进行中"
		: t.status === "failed"
			? "失败"
			: t.summary.includes(PATROL_OK)
				? "正常"
				: t.summary.trimStart().startsWith(NO_CHANGE)
					? "无变化"
					: "有异常";
/** 正常的不上色，只让异常和失败显眼 */
const ROUND_COLOR: Record<string, string> = { 有异常: "text-bad", 失败: "text-bad", 进行中: "text-accent" };
/** 观察文档的链接：写在生成文档那个任务的结论里 */
const DOC_URL_RE = /https:\/\/[\w.-]*feishu\.cn\/(?:docx|wiki|docs)\/[\w-]+/;

function StoryCard({ s, state, onOpen }: { s: Story; state: State; onOpen: (s: Story) => void }) {
	const tasks = tasksOf(state, s.id);
	const running = tasks.filter((t) => t.status === "running").length;
	const tickets = ticketsOf(s);
	// 挂在这条需求下、等你处理的事（工作台里同一批）
	const waiting = state.items.filter((t) => t.storyId === s.id && waitingOn(t)).length;
	const patrolling = tickets.some((t) => t.patrol && !t.patrol.stopped);
	return (
		<div
			className="tcard"
			role="button"
			tabIndex={0}
			onClick={() => onOpen(s)}
			onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && onOpen(s)}
		>
			<div className="head">
				<span className="tag">{TYPE_NAME[s.typeKey] ?? s.typeKey}</span>
				{s.url && (
					// 直接打开飞书工单，不弹抽屉
					<a
						href={s.url}
						target="_blank"
						rel="noreferrer"
						onClick={(e) => e.stopPropagation()}
						className="rounded-[4px] px-1.5 text-[12px] text-accent no-underline hover:bg-accent-soft"
						title="在飞书打开"
					>
						飞书 ↗
					</a>
				)}
			</div>
			<div className="t">{s.title}</div>
			<div className="foot2">
				<span>
					{tasks.length > 0 && `${tasks.length} 个任务${running ? `，${running} 个进行中` : ""}`}
					{waiting > 0 && (
						<b className="zhu">
							{tasks.length > 0 ? "，" : ""}
							{waiting} 件等你处理
						</b>
					)}
				</span>
				<span className="num" title={`最近更新：${time(s.updated)}`}>
					{ago(state.now, s.updated)}
				</span>
			</div>
			{(tickets.length > 0 || patrolling) && (
				<div className="foot2">
					<span className="num">{tickets.map((t) => t.key).join(" ")}</span>
					{patrolling && <span className="livedot">巡检中</span>}
				</div>
			)}
		</div>
	);
}

/** 需求：飞书工单（我的待办里的需求、缺陷）按阶段排成四列，阶段由你推，不回写飞书项目 */
export function StoryBoard({
	state,
	initialOpen,
	onOpenDev,
}: {
	state: State;
	initialOpen?: string;
	/** storyId：从哪条需求点开的，任务抽屉里能返回 */
	onOpenDev: (id: string, storyId?: string) => void;
}) {
	const qc = useQueryClient();
	const navigate = useNavigate();
	const [open, setOpen] = useState<string | null>(initialOpen ?? null);
	const [showDropped, setShowDropped] = useState(false);
	const [msg, setMsg] = useState<Msg>(null);
	const [busy, setBusy] = useState<"" | "sync" | "add">("");
	const [adding, setAdding] = useState("");
	const stories = state.stories ?? [];
	const current = stories.find((s) => s.id === open);
	async function sync() {
		setBusy("sync");
		try {
			const r = await post<{ added: number }>("/api/stories/sync");
			await post("/api/stories/tickets");
			setMsg({ text: r.added ? `同步完成，新增 ${r.added} 条` : "已是最新" });
			qc.invalidateQueries({ queryKey: ["state"] });
		} catch (e) {
			setMsg({ text: (e as Error).message, bad: true });
		} finally {
			setBusy("");
		}
	}
	async function add() {
		setBusy("add");
		try {
			const r = await post<{ story: Story }>("/api/stories/add", { text: adding });
			setAdding("");
			setMsg({ text: `已添加：${r.story.title}` });
			qc.invalidateQueries({ queryKey: ["state"] });
			setOpen(r.story.id);
		} catch (e) {
			setMsg({ text: (e as Error).message, bad: true });
		} finally {
			setBusy("");
		}
	}
	const dropped = stories.filter((s) => s.stage === "dropped");
	return (
		<>
			<div className="filters">
				<button disabled={!!busy} onClick={sync} title="拉取飞书项目里你名下的需求和缺陷，并刷新发布工单的状态">
					{busy === "sync" ? "正在同步…" : "从飞书同步"}
				</button>
				{/* 没有不再跟进的就不占位置；正在看的时候留着，好切回去 */}
				{(dropped.length > 0 || showDropped) && (
					<button className={showDropped ? "on" : undefined} onClick={() => setShowDropped(!showDropped)}>
						{DROPPED} <span className="num">{dropped.length}</span>
					</button>
				)}
				<input
					className="story-add"
					value={adding}
					placeholder="添加飞书工单：贴链接或 ID"
					aria-label="添加飞书工单"
					onChange={(e) => setAdding(e.target.value)}
					onKeyDown={(e) => e.key === "Enter" && adding.trim() && !busy && add()}
				/>
				<button disabled={!!busy || !adding.trim()} onClick={add}>
					添加
				</button>
				<MsgLine msg={msg} />
			</div>
			<div className="board">
				{(showDropped ? [["dropped", DROPPED] as [string, string]] : STAGES).map(([key, name]) => {
					const items = stories.filter((s) => s.stage === key);
					return (
						<div className="col" key={key}>
							<h2>
								{name}
								<span className="num">{items.length}</span>
							</h2>
							<div className="lane">
								{items.map((s) => (
									<StoryCard key={s.id} s={s} state={state} onOpen={(x) => setOpen(x.id)} />
								))}
							</div>
						</div>
					);
				})}
			</div>
			{current && (
				<StoryDrawer
					key={current.id}
					s={current}
					now={state.now}
					tasks={tasksOf(state, current.id)}
					allTasks={state.devTasks}
					onClose={() => {
						setOpen(null);
						// 从定时任务页点进来的：关掉时把地址栏的 story 去掉，刷新不再弹出
						if (initialOpen) void navigate({ to: "/", search: { view: "stories" } });
					}}
					onOpenDev={(id) => {
						setOpen(null);
						onOpenDev(id, current.id);
					}}
				/>
			)}
		</>
	);
}

/** 一轮结论的第一行（正常时就是「本轮巡查正常」，异常时是异常和证据） */
const firstLine = (x: DevTask) => (x.summary.trim().split("\n")[0] || x.error || "").slice(0, 80);

/** 一张工单的巡检记录：首次观察和每一轮的结果，折叠着，展开后一轮一行，新的在上 */
function PatrolLog({
	schedule,
	observe,
	rounds,
	now,
	onOpenDev,
}: {
	schedule?: Schedule;
	observe?: DevTask;
	rounds: DevTask[];
	now: number;
	onOpenDev: (id: string) => void;
}) {
	const last = rounds[0];
	const lastState = last && roundState(last);
	const row = (t: DevTask, label: string, color: string, text: string) => (
		<button key={t.id} type="button" className="story-patrol-row" onClick={() => onOpenDev(t.id)} title={time(t.created)}>
			<span className="w-[8em] shrink-0 tabular-nums">{when(t.created, now)}</span>
			<span className={`w-[4em] shrink-0 font-semibold ${color}`}>{label}</span>
			<span className="min-w-0 flex-1 truncate">{text}</span>
		</button>
	);
	return (
		<details className="story-patrol">
			<summary title={schedule?.model ? `模型：${schedule.model.split("/").pop()}` : undefined}>
				巡检记录 <span className="num">{rounds.length}</span> 轮
				{last && (
					<span className="ml-3 tabular-nums">
						最近一轮 {when(last.created, now)} <span className={ROUND_COLOR[lastState] ?? "text-text-2"}>{lastState}</span>
					</span>
				)}
			</summary>
			<div className="story-patrol-body">
				{rounds.map((r) => {
					const st = roundState(r);
					return row(r, st, ROUND_COLOR[st] ?? "text-text-2", firstLine(r));
				})}
				{observe && row(observe, "首次观察", "text-text-2", firstLine(observe) || TASK_STATUS[observe.status] || "")}
				{!rounds.length && !observe && <div className="px-1 py-1">还没有记录</div>}
			</div>
		</details>
	);
}

/** 抽屉里的一个区块：标题、数量、右侧操作，下面是内容 */
function Section({
	title,
	count,
	hint,
	extra,
	children,
}: {
	title: string;
	count?: number;
	hint?: string;
	extra?: ReactNode;
	children: ReactNode;
}) {
	return (
		<section className="mt-6">
			<div className="mb-2 flex items-baseline gap-2">
				<h3 className="m-0 text-[14px] font-semibold text-text">{title}</h3>
				{count !== undefined && count > 0 && <span className="text-[12px] text-muted tabular-nums">{count}</span>}
				{hint && <span className="text-[12px] text-muted">{hint}</span>}
				{extra && <span className="ml-auto">{extra}</span>}
			</div>
			{children}
		</section>
	);
}

type Kind = "dev" | "ask" | "release";
const KIND_HINT: Record<Kind, string> = {
	dev: "要改什么？留空就照工单描述来做。改动放在新分支上，你看过之后再推送、创建 MR",
	ask: "要查什么？只查不改",
	release: "提哪种发布工单？比如 stg 灰度、线上 AB、全量。留空的话助手会先问你，提交前也会请你批准",
};
const KIND_START: Record<Kind, string> = { dev: "开始实现", ask: "开始查询", release: "开始提单" };

function StoryDrawer({
	s,
	now,
	tasks,
	allTasks,
	onClose,
	onOpenDev,
}: {
	s: Story;
	now: number;
	tasks: DevTask[];
	allTasks: DevTask[];
	onClose: () => void;
	onOpenDev: (id: string) => void;
}) {
	const qc = useQueryClient();
	const { data: repos } = useQuery({ queryKey: ["repos"], queryFn: fetchRepos });
	const { data: schedules = [] } = useQuery({ queryKey: ["schedules"], queryFn: fetchSchedules, refetchInterval: 30_000 });
	const [kind, setKind] = useState<Kind | null>(null);
	const [text, setText] = useState("");
	const [repo, setRepo] = useState("");
	const [branch, setBranch] = useState("");
	const [ticketText, setTicketText] = useState("");
	const [busy, setBusy] = useState(false);
	const [msg, setMsg] = useState<Msg>(null);
	async function act(fn: () => Promise<unknown>, done: string) {
		setBusy(true);
		try {
			await fn();
			setMsg({ text: done });
			qc.invalidateQueries({ queryKey: ["state"] });
			void qc.invalidateQueries({ queryKey: ["schedules"] });
		} catch (e) {
			setMsg({ text: (e as Error).message, bad: true });
		} finally {
			setBusy(false);
		}
	}
	const tickets = ticketsOf(s);
	const bind = () =>
		act(async () => {
			const r = await post<{ bound: string[]; failed: string[] }>(`/api/stories/${s.id}/bind`, { text: ticketText });
			setTicketText("");
			if (r.failed.length)
				throw new Error(r.bound.length ? `已绑定 ${r.bound.join("、")}，没找到 ${r.failed.join("、")}` : `没找到 ${r.failed.join("、")}`);
		}, "已绑定");
	const unbind = (key: string) => act(() => post(`/api/stories/${s.id}/unbind`, { key }), `已解绑 ${key}`);
	const taskOf = (id?: string) => (id ? allTasks.find((t) => t.id === id) : undefined);
	const makeDoc = (key: string) => act(() => post(`/api/stories/${s.id}/doc`, { key }), `正在生成 ${key} 的观察文档，写入飞书前会请你批准`);
	const patrol = (key: string) =>
		act(() => post(`/api/stories/${s.id}/patrol`, { key }), "已开始巡检：先做一次首次观察，之后定时检查，没问题不打扰你");
	const retryObserve = (id: string) =>
		act(
			() =>
				post(`/api/dev/${id}/message`, {
					text: "上次没跑完就中断了。接着把首次观察做完，结尾照要求写「【巡检范围与基线】」，之后每轮巡检靠它做对比。",
				}),
			"已重试首次观察",
		);
	const runPatrol = (scheduleId: string) =>
		act(async () => {
			const id = await runSchedule(scheduleId);
			if (id) onOpenDev(id);
		}, "已开始巡检一轮");
	const unpatrol = (key: string) => act(() => post(`/api/stories/${s.id}/unpatrol`, { key }), `已停止巡检 ${key}`);
	const stage = (st: string) => act(() => post(`/api/stories/${s.id}/stage`, { stage: st }), `已移到「${STAGE_NAME[st]}」`);
	const start = () =>
		act(async () => {
			const r = await post<{ task: DevTask }>(`/api/stories/${s.id}/task`, {
				kind,
				text,
				repo: repo || (kind === "dev" ? repos?.[0] : undefined),
				branch: kind === "dev" ? branch : undefined,
			});
			setKind(null);
			setText("");
			onOpenDev(r.task.id);
		}, "已派出");
	return (
		<Drawer
			title={s.title}
			onClose={onClose}
			actions={
				<div className="chat-input">
					{kind && (
						<>
							{kind !== "release" && (
								<div className="row">
									<select
										value={repo || (kind === "dev" ? repos?.[0] : "") || ""}
										onChange={(e) => setRepo(e.target.value)}
										aria-label="仓库"
										title="仓库"
									>
										{kind === "ask" && <option value="">不限仓库</option>}
										{repos?.map((r) => (
											<option key={r} value={r}>
												{r}
											</option>
										))}
									</select>
									{kind === "dev" && (
										<input
											value={branch}
											onChange={(e) => setBranch(e.target.value.trim())}
											placeholder="分支名，留空自动起名"
											aria-label="分支名"
										/>
									)}
								</div>
							)}
							<textarea value={text} placeholder={KIND_HINT[kind]} onChange={(e) => setText(e.target.value)} autoFocus />
						</>
					)}
					<div className="row">
						{kind ? (
							<>
								<button className="btn primary" disabled={busy || (kind === "ask" && !text.trim())} onClick={start}>
									{KIND_START[kind]}
								</button>
								<button className="btn" disabled={busy} onClick={() => setKind(null)}>
									取消
								</button>
							</>
						) : (
							<>
								<button className="btn primary" onClick={() => setKind("dev")}>
									派开发任务
								</button>
								<button className="btn" onClick={() => setKind("ask")}>
									查询
								</button>
								<button className="btn" onClick={() => setKind("release")}>
									提发布工单
								</button>
							</>
						)}
					</div>
					<MsgLine msg={msg} />
				</div>
			}
		>
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted">
				<span className="rounded-[4px] bg-soft px-1.5 text-text-2">{TYPE_NAME[s.typeKey] ?? "工单"}</span>
				<span className="tabular-nums" title="飞书工单 ID">
					ID {s.id}
				</span>
				{s.url && (
					<a href={s.url} target="_blank" rel="noreferrer" className="ml-auto text-accent no-underline hover:underline">
						在飞书打开 ↗
					</a>
				)}
			</div>

			<Section title="阶段" hint="只记在这里，不改飞书上的状态">
				<div className="flex flex-wrap items-center gap-3">
					<div className="inline-flex rounded-[6px] border border-line bg-bg p-0.5">
						{STAGES.map(([k, name]) => {
							const on = k === s.stage;
							return (
								<button
									key={k}
									type="button"
									disabled={busy || on}
									aria-pressed={on}
									onClick={() => stage(k)}
									className={`cursor-pointer rounded-[4px] border-0 px-3 py-1 text-[14px] disabled:cursor-default ${
										on ? "bg-accent-soft font-semibold text-accent" : "bg-transparent text-text-2 hover:bg-soft hover:text-text"
									}`}
								>
									{name}
								</button>
							);
						})}
					</div>
					{s.stage === "dropped" ? (
						<span className="text-[12px] text-muted">已不再跟进，选一个阶段就能恢复</span>
					) : (
						<button type="button" className="btn ghost sm ml-auto" disabled={busy} onClick={() => stage("dropped")}>
							{DROPPED}
						</button>
					)}
				</div>
			</Section>

			<Section title="任务" count={tasks.length}>
				{tasks.length ? (
					<div className="story-list">
						{tasks.map((t) => (
							<div key={t.id} className="story-item" onClick={() => onOpenDev(t.id)} title={t.branch ? `分支 ${t.branch}` : undefined}>
								<span className="shrink-0 rounded-[4px] bg-soft px-1.5 text-[12px] text-text-2">
									{t.agent === "dev" ? "开发助手" : (AGENT_NAME[t.agent] ?? t.agent)}
								</span>
								<span className="t">{t.title}</span>
								<span className={`m ${TASK_STATUS_COLOR[t.status] ?? ""}`}>{TASK_STATUS[t.status] ?? t.status}</span>
							</div>
						))}
					</div>
				) : (
					<p className="m-0 text-[14px] text-muted">还没有任务</p>
				)}
			</Section>

			<Section
				title="发布工单"
				count={tickets.length}
				extra={
					tickets.length > 0 && (
						<button className="linkbtn" disabled={busy} onClick={() => act(() => post("/api/stories/tickets"), "已刷新")}>
							刷新状态
						</button>
					)
				}
			>
				{tickets.length > 0 && (
					<div className="story-list">
						{tickets.map((t) => {
							const docTask = taskOf(t.doc?.taskId);
							const docUrl = docTask?.summary.match(DOC_URL_RE)?.[0];
							const patrolling = Boolean(t.patrol && !t.patrol.stopped);
							const schedule = schedules.find((x) => x.id === t.patrol?.scheduleId);
							const observe = taskOf(t.patrol?.observeTaskId);
							// 失败的，或者出错后被归档、没有结论的：都要重试，不然巡检没有基线
							const observeBroken = Boolean(
								observe && (observe.status === "failed" || (observe.status === "done" && observe.error && !observe.summary.trim())),
							);
							const rounds = allTasks
								.filter((x) => x.patrol && x.title.includes(`巡检 ${t.key} `))
								.toSorted((a, b) => b.created - a.created);
							return (
								<div key={t.key} className="story-ticket">
									<div className="story-item" title={SOURCE_NAME[t.source ?? "auto"]}>
										<a
											href={ticketUrl(t.key)}
											target="_blank"
											rel="noreferrer"
											className="shrink-0 font-semibold text-accent no-underline tabular-nums hover:underline"
											title="在发布系统打开"
										>
											{t.key} ↗
										</a>
										<span className="t">{t.title || "标题待刷新"}</span>
										{t.status && <span className="m">{t.status}</span>}
										<button className="linkbtn" disabled={busy} onClick={() => unbind(t.key)}>
											解绑
										</button>
									</div>
									<div className="story-ticket-ops">
										<div>
											<span className="lab">观察文档</span>
											{docUrl ? (
												<a href={docUrl} target="_blank" rel="noreferrer">
													查看 ↗
												</a>
											) : docTask?.status === "running" ? (
												<>
													<span>正在生成</span>
													<button className="linkbtn" onClick={() => onOpenDev(docTask.id)}>
														查看进度
													</button>
												</>
											) : docTask ? (
												<button className="linkbtn" onClick={() => onOpenDev(docTask.id)}>
													查看任务
												</button>
											) : null}
											{docTask?.status !== "running" && (
												<button className="linkbtn" disabled={busy} onClick={() => makeDoc(t.key)}>
													{docTask ? "重新生成" : "生成"}
												</button>
											)}
										</div>
										<div>
											<span className="lab">巡检</span>
											{patrolling ? (
												<>
													<span>{schedule ? humanCron(schedule.cron) : "每 30 分钟"}</span>
													{schedule?.enabled && schedule.nextRun && <span className="num">下次 {when(schedule.nextRun, now)}</span>}
													{schedule?.until && <span className="num">{when(schedule.until, now)} 自动停止</span>}
													{schedule && (
														<button className="linkbtn" disabled={busy} onClick={() => runPatrol(schedule.id)}>
															运行一次
														</button>
													)}
													<button className="linkbtn" disabled={busy} onClick={() => unpatrol(t.key)}>
														停止
													</button>
												</>
											) : (
												<>
													{t.patrol?.stopped && <span>已停止：{t.patrol.stopped}</span>}
													{t.ended ? (
														<span>工单已结束，不再巡检</span>
													) : (
														<button
															className="linkbtn"
															disabled={busy}
															onClick={() => patrol(t.key)}
															title="先做一次首次观察，之后定时检查，没问题不打扰你"
														>
															{t.patrol ? "重新开始巡检" : "开始巡检"}
														</button>
													)}
												</>
											)}
										</div>
										{patrolling && observe?.status === "running" && (
											<div>
												<span className="lab" />
												<span>正在做首次观察，做完后每轮巡检都和它对比</span>
												<button className="linkbtn" onClick={() => onOpenDev(observe.id)}>
													查看进度
												</button>
											</div>
										)}
										{patrolling && observe && observeBroken && (
											<div>
												<span className="lab" />
												<span className="text-bad">首次观察没做完，巡检缺少对比的基线</span>
												<button className="linkbtn" disabled={busy} onClick={() => retryObserve(observe.id)}>
													重试
												</button>
											</div>
										)}
									</div>
									{(t.patrol || rounds.length > 0) && (
										<PatrolLog schedule={schedule} observe={observe} rounds={rounds} now={now} onOpenDev={onOpenDev} />
									)}
								</div>
							);
						})}
					</div>
				)}
				<div className="story-bind">
					<input
						value={ticketText}
						placeholder="GD-12345 或工单链接，可填多张"
						aria-label="绑定发布工单"
						onChange={(e) => setTicketText(e.target.value)}
						onKeyDown={(e) => e.key === "Enter" && ticketText.trim() && !busy && bind()}
					/>
					<button className="btn" disabled={busy || !ticketText.trim()} onClick={bind}>
						绑定
					</button>
				</div>
			</Section>
		</Drawer>
	);
}
