import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { type DevTask, type State, type Story, fetchRepos, post } from "../lib/api";
import { AGENT_NAME, ago, ticketUrl } from "../lib/format";
import { Drawer, type Msg, MsgLine } from "./Drawer";

/** 需求任务的四个阶段，加一个「不跟了」收起来 */
const STAGES: Array<[string, string]> = [
	["dev", "开发中"],
	["test", "测试中"],
	["release", "发布中"],
	["done", "发布完成"],
];
const STAGE_NAME: Record<string, string> = { ...Object.fromEntries(STAGES), dropped: "不跟了" };
const TYPE_NAME: Record<string, string> = { story: "需求", issue: "缺陷" };
const TASK_STATUS: Record<string, string> = {
	running: "进行中",
	review: "待看",
	failed: "失败",
	pushing: "推送中",
	pushed: "已提 MR",
	done: "已完成",
	discarded: "已放弃",
};

/** 巡检每 30 分钟一轮，不进任务列表，在发布工单那一行看最近一轮 */
const tasksOf = (state: State, id: string) => state.devTasks.filter((t) => t.storyId === id && !t.patrol);
/** 解绑的留着记录（免得刷新时又自动挂回来），不显示 */
const ticketsOf = (s: Story) => s.tickets.filter((t) => !t.removed);
const SOURCE_NAME: Record<string, string> = { auto: "自动", manual: "手动", created: "提单" };
/** 巡检正常时结论第一行就是这句（server/dev.ts 的 PATROL_OK） */
const PATROL_OK = "本轮巡查正常";
const hhmm = (ts: number) => new Date(ts * 1000).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
const roundState = (t: DevTask) =>
	t.status === "running" ? "进行中" : t.status === "failed" ? "失败" : t.summary.trim().startsWith(PATROL_OK) ? "正常" : "有异常";
/** 观察文档的链接：写在生成文档那个任务的结论里 */
const DOC_URL_RE = /https:\/\/[\w.-]*feishu\.cn\/(?:docx|wiki|docs)\/[\w-]+/;

function StoryCard({ s, state, onOpen }: { s: Story; state: State; onOpen: (s: Story) => void }) {
	const tasks = tasksOf(state, s.id);
	const running = tasks.filter((t) => t.status === "running").length;
	const tickets = ticketsOf(s);
	return (
		<div className="tcard" onClick={() => onOpen(s)}>
			<div className="head">
				<span className={`tag ${s.typeKey === "issue" ? "draft" : "dev"}`}>{TYPE_NAME[s.typeKey] ?? s.typeKey}</span>
				{s.url && (
					// 直接打开飞书工单，不弹抽屉
					<a
						href={s.url}
						target="_blank"
						rel="noreferrer"
						onClick={(e) => e.stopPropagation()}
						className="rounded px-1.5 text-[12px] text-accent no-underline hover:bg-accent-soft"
						title="在新标签页打开飞书工单"
					>
						飞书 ↗
					</a>
				)}
			</div>
			<div className="t">{s.title}</div>
			<div className="foot2">
				<span>
					{tasks.length ? `${tasks.length} 个任务${running ? `（${running} 个进行中）` : ""}` : "还没有任务"}
					{tickets.length ? ` · 发布工单 ${tickets.length}` : ""}
				</span>
				<span>{ago(state.now, s.updated)}</span>
			</div>
		</div>
	);
}

/** 需求：飞书工单（我的待办里的需求、缺陷）按阶段排成四列，阶段由你推，不回写飞书项目 */
export function StoryBoard({ state, onOpenDev }: { state: State; onOpenDev: (id: string) => void }) {
	const qc = useQueryClient();
	const [open, setOpen] = useState<string | null>(null);
	const [showDropped, setShowDropped] = useState(false);
	const [msg, setMsg] = useState<Msg>(null);
	const [busy, setBusy] = useState(false);
	const [adding, setAdding] = useState("");
	const stories = state.stories ?? [];
	const current = stories.find((s) => s.id === open);
	async function sync() {
		setBusy(true);
		try {
			const r = await post<{ added: number }>("/api/stories/sync");
			await post("/api/stories/tickets");
			setMsg({ text: r.added ? `新增 ${r.added} 条` : "已是最新" });
			qc.invalidateQueries({ queryKey: ["state"] });
		} catch (e) {
			setMsg({ text: (e as Error).message, bad: true });
		} finally {
			setBusy(false);
		}
	}
	async function add() {
		setBusy(true);
		try {
			const r = await post<{ story: Story }>("/api/stories/add", { text: adding });
			setAdding("");
			setMsg({ text: `已添加：${r.story.title}` });
			qc.invalidateQueries({ queryKey: ["state"] });
			setOpen(r.story.id);
		} catch (e) {
			setMsg({ text: (e as Error).message, bad: true });
		} finally {
			setBusy(false);
		}
	}
	const dropped = stories.filter((s) => s.stage === "dropped");
	return (
		<>
			<div className="filters">
				<button disabled={busy} onClick={sync}>
					{busy ? "同步中…" : "从飞书同步"}
				</button>
				<button className={showDropped ? "on" : undefined} onClick={() => setShowDropped(!showDropped)}>
					不跟了 {dropped.length}
				</button>
				<input
					className="story-add"
					value={adding}
					placeholder="添加飞书工单：贴链接或 ID"
					onChange={(e) => setAdding(e.target.value)}
					onKeyDown={(e) => e.key === "Enter" && adding.trim() && !busy && add()}
				/>
				<button disabled={busy || !adding.trim()} onClick={add}>
					添加
				</button>
				<MsgLine msg={msg} />
			</div>
			<div className="board">
				{(showDropped ? [["dropped", "不跟了"] as [string, string]] : STAGES).map(([key, name]) => {
					const items = stories.filter((s) => s.stage === key);
					return (
						<div className="col" key={key}>
							<h2>
								{name}
								<span>{items.length}</span>
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
					tasks={tasksOf(state, current.id)}
					allTasks={state.devTasks}
					onClose={() => setOpen(null)}
					onOpenDev={(id) => {
						setOpen(null);
						onOpenDev(id);
					}}
				/>
			)}
		</>
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
		<section className="mt-5">
			<div className="mb-2 flex items-center gap-2">
				<h3 className="m-0 text-[13px] font-semibold text-text">{title}</h3>
				{count !== undefined && count > 0 && <span className="rounded bg-soft px-1.5 text-[11px] text-muted tabular-nums">{count}</span>}
				{hint && <span className="text-[12px] text-muted">{hint}</span>}
				{extra && <span className="ml-auto">{extra}</span>}
			</div>
			{children}
		</section>
	);
}

const Empty = ({ children }: { children: ReactNode }) => (
	<div className="mb-2 rounded-lg border border-dashed border-line px-3 py-3 text-[12px] text-muted">{children}</div>
);

type Kind = "dev" | "ask" | "release";
const KIND_HINT: Record<Kind, string> = {
	dev: "要实现什么（可选，不写就让 agent 读工单描述）；会在新分支上改，你审核后推送建 MR",
	ask: "要查什么：只读地查，不建分支",
	release: "要提哪种发布工单，例如「stg 灰度」「线上 AB」「全量」；不写就让助手先问你。提交前会给你看预览，提交走审批",
};

function StoryDrawer({
	s,
	tasks,
	allTasks,
	onClose,
	onOpenDev,
}: {
	s: Story;
	tasks: DevTask[];
	allTasks: DevTask[];
	onClose: () => void;
	onOpenDev: (id: string) => void;
}) {
	const qc = useQueryClient();
	const { data: repos } = useQuery({ queryKey: ["repos"], queryFn: fetchRepos });
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
			if (r.failed.length) throw new Error(`已绑 ${r.bound.join("、")}；查不到 ${r.failed.join("、")}`);
		}, "已绑定");
	const unbind = (key: string) => act(() => post(`/api/stories/${s.id}/unbind`, { key }), `已解绑 ${key}`);
	const taskOf = (id?: string) => (id ? allTasks.find((t) => t.id === id) : undefined);
	const makeDoc = (key: string) =>
		act(() => post(`/api/stories/${s.id}/doc`, { key }), `已派出：给 ${key} 写观察文档，写飞书前会发审批卡片`);
	const patrol = (key: string) =>
		act(() => post(`/api/stories/${s.id}/patrol`, { key }), `已开始：先做首次观察，之后每 30 分钟巡检一轮，正常不打扰`);
	const rerunObserve = (id: string) =>
		act(
			() =>
				post(`/api/dev/${id}/message`, {
					text: "上次没跑完就中断了。接着把首次观察做完，结尾照要求写「【巡检范围与基线】」，之后每轮巡检靠它做对比。",
				}),
			"已重跑首次观察，跑完后巡检就有基线可比",
		);
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
			title={`${TYPE_NAME[s.typeKey] ?? "工单"} · ${STAGE_NAME[s.stage] ?? s.stage}`}
			onClose={onClose}
			actions={
				<div className="chat-input">
					{kind && (
						<>
							{kind !== "release" && (
								<div className="row">
									<select value={repo || (kind === "dev" ? repos?.[0] : "") || ""} onChange={(e) => setRepo(e.target.value)}>
										{kind === "ask" && <option value="">不限仓库（~/code）</option>}
										{repos?.map((r) => (
											<option key={r} value={r}>
												{r}
											</option>
										))}
									</select>
									{kind === "dev" && (
										<input value={branch} onChange={(e) => setBranch(e.target.value.trim())} placeholder="分支：留空由 agent 起名" />
									)}
								</div>
							)}
							<textarea value={text} placeholder={KIND_HINT[kind]} onChange={(e) => setText(e.target.value)} />
						</>
					)}
					<div className="row">
						{kind ? (
							<>
								<button className="btn primary" disabled={busy || (kind === "ask" && !text.trim())} onClick={start}>
									{kind === "dev" ? "开始实现" : kind === "ask" ? "开始查" : "开始提单"}
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
			<div className="flex items-center gap-2 text-[12px] text-muted">
				<span className={`rounded px-1.5 py-0.5 ${s.typeKey === "issue" ? "bg-warn-soft text-warn" : "bg-accent-soft text-accent"}`}>
					{TYPE_NAME[s.typeKey] ?? "工单"}
				</span>
				<span className="tabular-nums">ID {s.id}</span>
				{s.url && (
					<a
						href={s.url}
						target="_blank"
						rel="noreferrer"
						className="ml-auto rounded-md border border-line px-2 py-0.5 text-accent no-underline hover:bg-accent-soft"
					>
						在飞书打开 ↗
					</a>
				)}
			</div>
			<div className="mt-2 text-[17px] leading-snug font-semibold break-words text-text">{s.title}</div>

			<Section title="阶段" hint="以这边为准，不改飞书项目的节点">
				<div className="flex flex-wrap items-center gap-3">
					<div className="inline-flex rounded-lg border border-line bg-bg p-0.5">
						{STAGES.map(([k, name], i) => {
							const cur = STAGES.findIndex(([x]) => x === s.stage);
							const on = k === s.stage;
							return (
								<button
									key={k}
									type="button"
									disabled={busy || on}
									onClick={() => stage(k)}
									className={`cursor-pointer rounded-md border-0 px-3 py-1 text-[13px] disabled:cursor-default ${
										on
											? "bg-accent font-semibold text-white"
											: i < cur
												? "bg-transparent text-text hover:bg-soft"
												: "bg-transparent text-muted hover:bg-soft hover:text-text"
									}`}
								>
									{i < cur ? `✓ ${name}` : name}
								</button>
							);
						})}
					</div>
					{s.stage === "dropped" ? (
						<span className="text-[12px] text-muted">已不跟，点上面的阶段可以恢复</span>
					) : (
						<button
							type="button"
							className="ml-auto cursor-pointer border-0 bg-transparent p-0 text-[12px] text-muted hover:text-bad disabled:opacity-50"
							disabled={busy}
							onClick={() => stage("dropped")}
						>
							不跟了
						</button>
					)}
				</div>
			</Section>

			<Section title="任务" count={tasks.length}>
				{tasks.length ? (
					<div className="story-list">
						{tasks.map((t) => (
							<div key={t.id} className="story-item" onClick={() => onOpenDev(t.id)}>
								<span className="shrink-0 rounded bg-ok-soft px-1.5 text-[12px] text-ok">
									{t.agent === "dev" ? "开发" : (AGENT_NAME[t.agent] ?? t.agent)}
								</span>
								<span className="t">{t.title}</span>
								<span className="m">
									{TASK_STATUS[t.status] ?? t.status}
									{t.branch ? ` · ${t.branch}` : ""}
								</span>
							</div>
						))}
					</div>
				) : (
					<Empty>还没有任务，用底部的按钮派开发、查询或提发布工单</Empty>
				)}
			</Section>

			<Section
				title="发布工单"
				count={tickets.length}
				extra={
					<button className="linkbtn" disabled={busy} onClick={() => act(() => post("/api/stories/tickets"), "已刷新")}>
						刷新状态
					</button>
				}
			>
				{tickets.length ? (
					<div className="story-list">
						{tickets.map((t) => {
							const docTask = taskOf(t.doc?.taskId);
							const docUrl = docTask?.summary.match(DOC_URL_RE)?.[0];
							const patrolling = Boolean(t.patrol && !t.patrol.stopped);
							const observe = taskOf(t.patrol?.observeTaskId);
							// 失败的，或者出错后被归档、没有结论的：都要重跑，不然巡检没有基线
							const observeBroken = Boolean(
								observe && (observe.status === "failed" || (observe.status === "done" && observe.error && !observe.summary.trim())),
							);
							const rounds = allTasks
								.filter((x) => x.patrol && x.title.includes(`巡检 ${t.key} `))
								.toSorted((a, b) => b.created - a.created);
							const last = rounds[0];
							return (
								<div key={t.key} className="story-ticket">
									<div className="story-item" title={`来源：${SOURCE_NAME[t.source ?? "auto"]}`}>
										<a
											href={ticketUrl(t.key)}
											target="_blank"
											rel="noreferrer"
											className="shrink-0 rounded bg-accent-soft px-1.5 font-medium text-accent no-underline hover:underline"
											title="在发布系统打开这张工单"
										>
											{t.key} ↗
										</a>
										<span className="t">{t.title || "（标题待刷新）"}</span>
										<span className="m">
											{t.status || "—"} · {SOURCE_NAME[t.source ?? "auto"]}
										</span>
										<button className="linkbtn" disabled={busy} onClick={() => unbind(t.key)}>
											解绑
										</button>
									</div>
									<div className="story-ticket-ops">
										<span>观察文档：</span>
										{docUrl ? (
											<a href={docUrl} target="_blank" rel="noreferrer">
												打开
											</a>
										) : docTask ? (
											<button className="linkbtn" onClick={() => onOpenDev(docTask.id)}>
												{docTask.status === "running" ? "生成中…" : "看任务"}
											</button>
										) : null}
										<button className="linkbtn" disabled={busy || docTask?.status === "running"} onClick={() => makeDoc(t.key)}>
											{docTask ? "重新生成" : "生成"}
										</button>
										<span className="sep">巡检：</span>
										{patrolling ? (
											<>
												<span>每 30 分钟一轮</span>
												{last && (
													<button className="linkbtn" title={`共 ${rounds.length} 轮`} onClick={() => onOpenDev(last.id)}>
														最近 {hhmm(last.created)} {roundState(last)}
													</button>
												)}
												<button className="linkbtn" onClick={() => onOpenDev(t.patrol!.observeTaskId)}>
													{observeBroken ? "首次观察（没跑完）" : observe?.status === "running" ? "首次观察中…" : "首次观察"}
												</button>
												{observe && observeBroken && (
													<button className="linkbtn" disabled={busy} onClick={() => rerunObserve(observe.id)}>
														重跑
													</button>
												)}
												<button className="linkbtn" disabled={busy} onClick={() => unpatrol(t.key)}>
													停止
												</button>
											</>
										) : (
											<>
												{t.patrol?.stopped && <span className="muted">已停（{t.patrol.stopped}）</span>}
												<button className="linkbtn" disabled={busy || t.ended} onClick={() => patrol(t.key)}>
													{t.ended ? "工单已结束" : t.patrol ? "重新开始" : "开始"}
												</button>
											</>
										)}
									</div>
								</div>
							);
						})}
					</div>
				) : (
					<Empty>还没有关联的发布工单。填工单号绑定，或者点「提发布工单」，提交后自动挂上</Empty>
				)}
				<div className="story-bind">
					<input
						value={ticketText}
						placeholder="GD-12345，多张用空格隔开，也可以贴工单页链接"
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
