import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { AgentBoard } from "../components/AgentBoard";
import { Board } from "../components/Board";
import { DevDrawer } from "../components/DevDrawer";
import { DraftDrawer, TaskDrawer } from "../components/Drawers";
import { Inbox } from "../components/Inbox";
import { DraftList, RecordList } from "../components/Lists";
import { MemoryBoard } from "../components/MemoryBoard";
import { type DevTask, type Draft, type InboxItem, type Task, fetchState, post } from "../lib/api";
import { isLive, money } from "../lib/format";
import { useLiveUpdates } from "../lib/live";
import { ChatPage } from "../components/ChatPage";
import { StoryBoard } from "../components/StoryBoard";
import { Overview } from "../components/Overview";
import { StatsPage } from "../components/Stats";
import { ToastHost } from "../components/Toast";

const TITLES = {
	home: "概览",
	todo: "待办",
	stats: "统计",
	tasks: "我的任务",
	stories: "需求",
	agents: "Agent",
	drafts: "草稿",
	qa: "对话",
	failed: "失败",
	memory: "记忆",
} as const;

/** 悬停在导航上看到的说明：这个入口管什么 */
const HINTS: Record<View, string> = {
	home: "额度、今日消耗、等你处理的事和最近动态",
	todo: "所有等你处理的事：审批、待确认草稿、失败、待看任务、有冲突的记忆",
	stats: "消耗趋势（按小时 / 天），按 agent、档位、模型拆分，草稿结果分布",
	tasks: "草稿、问答、agent 任务按进度排成的看板",
	stories: "飞书工单（需求、缺陷）按开发 → 测试 → 发布推进，发布工单、观察文档、巡检",
	agents: "agent 任务看板、新建任务、定时任务",
	drafts: "替你起草的回复：待确认、已发、你自己回了的",
	qa: "直接和助手聊天；私聊机器人的问答记录",
	failed: "失败的起草和问答，可以重试或忽略",
	memory: "长期记忆：约定和线索，确认、改分类、遗忘",
};
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
		<Link to="/" search={v === "home" ? {} : { view: v }} className={`nav${current === v ? " on" : ""}`} title={HINTS[v]}>
			{TITLES[v]} {badge != null && <span className={`badge${hot ? " hot" : ""}`}>{badge}</span>}
		</Link>
	);
}

function Dashboard() {
	const view = Route.useSearch().view ?? "home";
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
	const navigate = useNavigate();
	const openInbox = (it: InboxItem) => {
		// 审批和系统问题要在待办里就地处理（从概览点过来时跳过去）
		if (it.kind === "watch" || it.kind === "approval") return void navigate({ to: "/", search: { view: "todo" } });
		if (it.kind === "dev") return setOpen({ dev: it.ref });
		if (it.kind === "memory") return void navigate({ to: "/", search: { view: "memory" } });
		if (it.kind === "draft") {
			const d = state?.drafts.find((x) => x.id === it.ref);
			if (d) openDraft(d);
			return;
		}
		const t = state?.tasks.find((x) => x.id === it.ref);
		if (t) openTask(t);
	};
	// 后端还没重启到带 inbox 的版本时按空处理
	const inbox = state?.inbox ?? [];
	const inboxNow = inbox.filter((it) => it.level === "now").length;

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
				<Nav current={view} v="home" />
				<Nav current={view} v="todo" badge={inbox.length} hot={inboxNow > 0} />
				<Nav current={view} v="stats" />
				<div className="group">会话与消息</div>
				<Nav current={view} v="drafts" />
				<Nav current={view} v="qa" />
				<Nav current={view} v="failed" badge={s?.failed ?? 0} />
				<div className="group">自动化</div>
				<Nav current={view} v="stories" badge={state?.stories?.filter((x) => x.stage !== "done" && x.stage !== "dropped").length ?? 0} />
				<Nav current={view} v="tasks" badge={attn} hot={attn > 0} />
				<Nav
					current={view}
					v="agents"
					badge={state?.devTasks.filter((t) => t.status === "running" || t.status === "review").length ?? 0}
					hot={state?.devTasks.some((t) => t.status === "review") ?? false}
				/>
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
				{state && view === "home" && <Overview state={state} onOpenInbox={openInbox} onOpenTask={openTask} />}
				{view === "stats" && <StatsPage />}
				{state && view === "tasks" && <Board state={state} onOpen={openTask} />}
				{state && view === "stories" && <StoryBoard state={state} onOpenDev={(id) => setOpen({ dev: id })} />}
				{state && view === "agents" && <AgentBoard state={state} onOpen={(id) => setOpen({ dev: id })} />}
				{state && view === "todo" && <Inbox items={inbox} drafts={state.drafts} now={state.now} onOpen={openInbox} />}
				{state && view === "drafts" && <DraftList drafts={state.drafts} onOpen={openDraft} />}
				{state && view === "qa" && (
					<ChatPage chats={state.chats ?? []} records={state.records.filter((r) => r.kind !== "draft")} now={state.now} />
				)}
				{state && view === "failed" && <RecordList records={state.records.filter((r) => r.status === "failed")} />}
				{view === "memory" && <MemoryBoard />}
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
			<ToastHost />
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
