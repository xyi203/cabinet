import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
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

const tasksOf = (state: State, id: string) => state.devTasks.filter((t) => t.storyId === id);
/** 解绑的留着记录（免得刷新时又自动挂回来），不显示 */
const ticketsOf = (s: Story) => s.tickets.filter((t) => !t.removed);
const SOURCE_NAME: Record<string, string> = { auto: "自动", manual: "手动", created: "提单" };
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
			<div className="meta">
				<span className="pill pending">{STAGE_NAME[s.stage] ?? s.stage}</span>
				{s.url && (
					<a href={s.url} target="_blank" rel="noreferrer">
						在飞书打开 ↗
					</a>
				)}
				<span className="text-[12px] text-muted">ID {s.id}</span>
			</div>
			<div className="label">{TYPE_NAME[s.typeKey] ?? "工单"}</div>
			<blockquote>
				{s.url ? (
					<a href={s.url} target="_blank" rel="noreferrer" className="text-text no-underline hover:underline" title="在飞书打开">
						{s.title}
					</a>
				) : (
					s.title
				)}
			</blockquote>
			<div className="label">阶段（以这边为准，不看也不改飞书项目的节点）</div>
			<div className="row-inline">
				{[...STAGES, ["dropped", "不跟了"] as [string, string]].map(([k, name]) => (
					<button key={k} className={`btn${k === s.stage ? " primary" : ""}`} disabled={busy || k === s.stage} onClick={() => stage(k)}>
						{name}
					</button>
				))}
			</div>
			<div className="label">任务</div>
			{tasks.length ? (
				<div className="story-list">
					{tasks.map((t) => (
						<div key={t.id} className="story-item" onClick={() => onOpenDev(t.id)}>
							<span className="tag agent">{t.agent === "dev" ? "开发" : (AGENT_NAME[t.agent] ?? t.agent)}</span>
							<span className="t">{t.title}</span>
							<span className="m">
								{TASK_STATUS[t.status] ?? t.status}
								{t.branch ? ` · ${t.branch}` : ""}
							</span>
						</div>
					))}
				</div>
			) : (
				<div className="foot">还没有任务</div>
			)}
			<div className="label">
				发布工单
				<button className="linkbtn" disabled={busy} onClick={() => act(() => post("/api/stories/tickets"), "已刷新")}>
					刷新
				</button>
			</div>
			{tickets.length ? (
				<div className="story-list">
					{tickets.map((t) => {
						const docTask = taskOf(t.doc?.taskId);
						const docUrl = docTask?.summary.match(DOC_URL_RE)?.[0];
						const patrolling = Boolean(t.patrol && !t.patrol.stopped);
						return (
							<div key={t.key} className="story-ticket">
								<div className="story-item" title={`来源：${SOURCE_NAME[t.source ?? "auto"]}`}>
									<a
										href={ticketUrl(t.key)}
										target="_blank"
										rel="noreferrer"
										className="tag dev no-underline hover:underline"
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
											<button className="linkbtn" onClick={() => onOpenDev(t.patrol!.observeTaskId)}>
												首次观察
											</button>
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
				<div className="foot">还没有关联的发布工单：填工单号绑定，或者点「提发布工单」，提交后会自动挂上</div>
			)}
			<div className="story-bind">
				<input
					value={ticketText}
					placeholder="绑定发布工单：GD-12345，多张用空格隔开，也可以贴工单页链接"
					onChange={(e) => setTicketText(e.target.value)}
					onKeyDown={(e) => e.key === "Enter" && ticketText.trim() && !busy && bind()}
				/>
				<button className="btn" disabled={busy || !ticketText.trim()} onClick={bind}>
					绑定
				</button>
			</div>
		</Drawer>
	);
}
