import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { AgentBoard } from "../components/AgentBoard";
import { Board } from "../components/Board";
import { DevDrawer } from "../components/DevDrawer";
import { DraftDrawer, TaskDrawer } from "../components/Drawers";
import { DraftList, Memory, RecordList } from "../components/Lists";
import { type DevTask, type Draft, type Task, fetchState, post } from "../lib/api";
import { isLive, money } from "../lib/format";
import { useLiveUpdates } from "../lib/live";

const TITLES = { tasks: "我的任务", agents: "Agent", todo: "待办", drafts: "草稿", qa: "对话", failed: "失败", memory: "记忆" } as const;
type View = keyof typeof TITLES;

// 当前视图放在地址栏（?view=todo），刷新和收藏都能回到原处
export const Route = createFileRoute("/")({
	component: Dashboard,
	validateSearch: (search: Record<string, unknown>): { view?: View } => ({
		view: typeof search.view === "string" && search.view in TITLES ? (search.view as View) : undefined,
	}),
});

function Nav({ v, current, badge, hot }: { v: View; current: View; badge?: number; hot?: boolean }) {
	return (
		<Link to="/" search={v === "tasks" ? {} : { view: v }} className={`nav${current === v ? " on" : ""}`}>
			{TITLES[v]} {badge != null && <span className={`badge${hot ? " hot" : ""}`}>{badge}</span>}
		</Link>
	);
}

function Dashboard() {
	const view = Route.useSearch().view ?? "tasks";
	const [open, setOpen] = useState<{ draft?: Draft; task?: Task; dev?: string } | null>(null);
	const [connected, setConnected] = useState(true);
	// 有实时推送时轮询只作兜底；断线时加快
	const { data: state, error } = useQuery({ queryKey: ["state"], queryFn: fetchState, refetchInterval: connected ? 15_000 : 5_000 });
	useLiveUpdates(useCallback((c: boolean) => setConnected(c), []));

	const openTask = (t: Task) => {
		if (t.dev) return setOpen({ dev: t.dev, task: t });
		const d = t.draft ? state?.drafts.find((x) => x.id === t.draft) : undefined;
		setOpen(d && isLive(d) ? { draft: d, task: t } : { task: t, draft: d });
	};
	const openDraft = (d: Draft) => setOpen({ draft: d, task: state?.tasks.find((t) => t.draft === d.id) });

	const s = state?.stats;
	const attn = state?.tasks.filter((t) => t.status === "in_review" || t.status === "blocked").length ?? 0;
	const lag = state?.pollSince ? `${Math.round(state.now - state.pollSince)}s 前` : "未开始";

	return (
		<div className="app">
			<aside>
				<div className="brand">
					<div className="logo">阁</div>Cabinet
				</div>
				<div className="group">概览</div>
				<Nav current={view} v="tasks" badge={attn} hot={attn > 0} />
				<Nav
					current={view}
					v="agents"
					badge={state?.devTasks.filter((t) => t.status === "running" || t.status === "review").length ?? 0}
					hot={state?.devTasks.some((t) => t.status === "review") ?? false}
				/>
				<Nav current={view} v="todo" badge={s?.pending ?? 0} hot={(s?.pending ?? 0) > 0} />
				<div className="group">会话与消息</div>
				<Nav current={view} v="drafts" />
				<Nav current={view} v="qa" />
				<Nav current={view} v="failed" badge={s?.failed ?? 0} />
				<div className="group">知识</div>
				<Nav current={view} v="memory" />
			</aside>
			<main>
				<div className="top">
					<h1>{TITLES[view]}</h1>
					<span className="sub">
						{error && !state ? (
							"连接不上 cabinet 进程"
						) : state && s ? (
							<>
								进行中 <b>{state.running + state.inflight}</b> · 待确认 <b>{s.pending}</b> · 今日请求 <b>{s.requests}</b> · 今日花费{" "}
								<b>{money(s.usage.cost)}</b> · 轮询 {lag}
								{!connected && " · 实时推送断开"}
							</>
						) : (
							"加载中…"
						)}
					</span>
				</div>
				{state && !state.auth.authorized && <AuthBanner />}
				{state && view === "tasks" && <Board state={state} onOpen={openTask} />}
				{state && view === "agents" && <AgentBoard state={state} onOpen={(id) => setOpen({ dev: id })} />}
				{state && view === "todo" && <DraftList drafts={state.drafts.filter(isLive)} onOpen={openDraft} />}
				{state && view === "drafts" && <DraftList drafts={state.drafts} onOpen={openDraft} />}
				{state && view === "qa" && <RecordList records={state.records.filter((r) => r.kind !== "draft")} />}
				{state && view === "failed" && <RecordList records={state.records.filter((r) => r.status === "failed")} />}
				{view === "memory" && <Memory />}
			</main>
			{open?.dev && state?.devTasks.find((x) => x.id === open.dev) ? (
				<DevDrawer
					key={open.dev}
					dev={state.devTasks.find((x) => x.id === open.dev) as DevTask}
					task={state.tasks.find((t) => t.dev === open.dev)}
					onClose={() => setOpen(null)}
				/>
			) : open?.draft && isLive(open.draft) ? (
				<DraftDrawer key={open.draft.id} draft={open.draft} task={open.task} onClose={() => setOpen(null)} />
			) : open?.task ? (
				<TaskDrawer key={open.task.id} task={open.task} draft={open.draft} onClose={() => setOpen(null)} />
			) : null}
		</div>
	);
}

function AuthBanner() {
	const [err, setErr] = useState("");
	async function start() {
		try {
			const { url } = await post<{ url: string }>("/api/oauth/start");
			window.location.href = url;
		} catch (e) {
			setErr((e as Error).message);
		}
	}
	return (
		<div className="auth">
			还没有授权飞书用户身份：读不到你的私聊和 @你 的消息，也不能以你的身份发出草稿。
			<button className="btn primary" onClick={start}>
				授权飞书
			</button>
			{err && <span>{err}</span>}
		</div>
	);
}
