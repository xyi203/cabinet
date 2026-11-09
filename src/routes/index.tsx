import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { AudiencePage } from "../components/Audience";
import { ChatPage } from "../components/ChatPage";
import { DevDrawer } from "../components/DevDrawer";
import { DispatchPage } from "../components/Dispatch";
import { JournalPage } from "../components/Journal";
import { MemoryBoard } from "../components/MemoryBoard";
import { PromptsPage } from "../components/Prompts";
import { RouteRulesPage } from "../components/RouteRules";
import { Schedules } from "../components/Schedules";
import { SkillsPage } from "../components/Skills";
import { StatsPage } from "../components/Stats";
import { StoryBoard } from "../components/StoryBoard";
import { TaskPanel } from "../components/TaskPanel";
import { ToastHost } from "../components/Toast";
import { RowActions } from "../components/Actions";
import { Workbench } from "../components/Workbench";
import { type DevTask, type State, fetchState, post } from "../lib/api";
import { ago, date, titleOf, waitingOn } from "../lib/format";
import { useLiveUpdates } from "../lib/live";
import { pct, span } from "../components/ui";
import type { QuotaWindow } from "../lib/api";

const TITLES = {
	work: "工作台",
	stories: "需求",
	cron: "定时",
	memory: "记忆",
	chat: "对话",
	ops: "运行",
	settings: "设置",
} as const;
type View = keyof typeof TITLES;
/** 改版前的入口：收藏的链接跳到新地方（docs/router-worker.md §5） */
const ALIASES: Record<string, View> = {
	home: "work",
	todo: "work",
	tasks: "work",
	agents: "work",
	drafts: "work",
	failed: "ops",
	dispatch: "ops",
	stats: "ops",
	journal: "ops",
	schedules: "cron",
	qa: "chat",
	prompts: "settings",
	skills: "settings",
	audience: "settings",
};
/** 侧栏悬停提示：这一页是干什么的 */
const HINTS: Record<View, string> = {
	work: "等你处理的、正在做的、今天做完的",
	stories: "飞书项目里你负责的需求，从开发到发布",
	cron: "到点让助手做的事",
	memory: "助手记住的你的习惯和偏好",
	chat: "直接和助手聊天",
	ops: "队列、失败、花费和每日小结",
	settings: "消息来源、分派规则、提示词、联系人",
};

export const Route = createFileRoute("/")({
	component: Dashboard,
	validateSearch: (search: Record<string, unknown>): { view?: View; story?: string; tab?: string } => ({
		view: typeof search.view !== "string" ? undefined : search.view in TITLES ? (search.view as View) : ALIASES[search.view],
		story: typeof search.story === "string" || typeof search.story === "number" ? String(search.story) : undefined,
		tab: typeof search.tab === "string" ? search.tab : undefined,
	}),
});

function Tabs<T extends string>({ tabs, value, onChange }: { tabs: readonly T[]; value: T; onChange: (t: T) => void }) {
	return (
		<div className="tools">
			<div className="seg" role="tablist">
				{tabs.map((t) => (
					<button key={t} role="tab" aria-selected={t === value} className={t === value ? "on" : ""} onClick={() => onChange(t)}>
						{t}
					</button>
				))}
			</div>
		</div>
	);
}

/** 多久没收取消息算卡住：和后端自检（server/watchdog.ts）的 10 分钟一致 */
const POLL_STALE = 600;
const OPS_TABS = ["队列", "失败", "统计", "日报", "自检"] as const;
const SET_TABS = ["消息来源", "分派规则", "提示词", "技能", "联系人"] as const;
/** 页签改名前的旧链接 */
const TAB_ALIASES: Record<string, string> = { 系统健康: "自检", 渠道: "消息来源", 路由规则: "分派规则", 受众: "联系人" };

function Dashboard() {
	const search = Route.useSearch();
	const view: View = search.view ?? "work";
	const navigate = useNavigate();
	// 打开的任务详情；backStory：从哪条需求点进来的，能返回
	const [open, setOpen] = useState<{ id?: string; dev?: string; backStory?: string } | null>(null);
	const [storyReopen, setStoryReopen] = useState(0);
	const [connected, setConnected] = useState(true);
	const { data: state, error } = useQuery({ queryKey: ["state"], queryFn: fetchState, refetchInterval: connected ? 15_000 : 5_000 });
	useLiveUpdates(useCallback((c: boolean) => setConnected(c), []));

	const go = (v: View, extra: { story?: string; tab?: string } = {}) =>
		void navigate({ to: "/", search: v === "work" ? {} : { view: v, ...extra } });
	const tab = search.tab && (TAB_ALIASES[search.tab] ?? search.tab);
	/** agent 任务 id → 它所在的那件事；不在工作台窗口里的（老任务、对话）直接开任务抽屉 */
	const openDev = (devId: string, backStory?: string) => {
		const t = state?.items.find((x) => x.devTasks.includes(devId));
		setOpen(t ? { id: t.id, backStory } : { dev: devId, backStory });
	};
	const nav = {
		onOpen: (id: string) => setOpen({ id }),
		onStory: (id: string) => {
			setOpen(null);
			setStoryReopen((n) => n + 1);
			go("stories", { story: id });
		},
		onMemory: () => {
			setOpen(null);
			go("memory");
		},
		onCron: () => {
			setOpen(null);
			go("cron");
		},
	};
	const back = open?.backStory
		? () => {
				const id = open.backStory!;
				setOpen(null);
				setStoryReopen((n) => n + 1);
				go("stories", { story: id });
			}
		: undefined;
	const task = open?.id ? state?.items.find((x) => x.id === open.id) : undefined;
	const dev = open?.dev ? state?.devTasks.find((x) => x.id === open.dev) : undefined;
	const waiting = state?.items.filter(waitingOn).length ?? 0;

	return (
		<div className="app">
			<aside>
				<div className="brand">
					<div className="seal">阁</div>
					<span>Cabinet</span>
				</div>
				{(Object.keys(TITLES) as View[]).map((v) => (
					<button
						key={v}
						className={`nav${view === v ? " on" : ""}`}
						title={HINTS[v]}
						aria-current={view === v ? "page" : undefined}
						onClick={() => go(v)}
					>
						{TITLES[v]}
						{v === "work" && waiting > 0 && (
							<span className="n" aria-label={`${waiting} 件等你处理`}>
								{waiting}
							</span>
						)}
					</button>
				))}
				{state?.quota && (
					<div className="aside-foot">
						<div className="quota-h">Claude 用量</div>
						<MiniQuota label="5 小时内" w={state.quota.windows.five_hour} now={state.now} />
						<MiniQuota label="本周" w={state.quota.windows.seven_day} now={state.now} />
					</div>
				)}
			</aside>
			<main className={view === "chat" ? "full" : ""}>
				{error && !state && <div className="issue">连不上 Cabinet 服务，正在重试。确认服务已经启动。</div>}
				{state && !connected && <div className="issue">和 Cabinet 服务的连接断了，正在重连，页面上的内容可能不是最新的。</div>}
				{state && !state.auth.authorized && <AuthBanner />}
				{!state && !error && <div className="empty">加载中…</div>}
				{state && view === "work" && <Workbench s={state} nav={nav} open={open?.id} />}
				{state && view === "stories" && (
					<>
						<div className="phead">
							<h1>需求</h1>
						</div>
						<StoryBoard key={`${search.story ?? ""}:${storyReopen}`} state={state} initialOpen={search.story} onOpenDev={openDev} />
					</>
				)}
				{state && view === "cron" && (
					<>
						<div className="phead">
							<h1>定时</h1>
						</div>
						<Schedules
							agents={state.agents}
							stories={state.stories}
							items={state.items}
							now={state.now}
							onOpenTask={nav.onOpen}
							onOpenDev={(id) => openDev(id)}
							onOpenStory={nav.onStory}
						/>
					</>
				)}
				{view === "memory" && (
					<>
						<div className="phead">
							<h1>记忆</h1>
						</div>
						<MemoryBoard />
					</>
				)}
				{state && view === "chat" && (
					<>
						<div className="phead">
							<h1>对话</h1>
						</div>
						<ChatPage chats={state.chats ?? []} records={state.records.filter((r) => r.kind !== "draft")} now={state.now} />
					</>
				)}
				{state && view === "ops" && (
					<Ops s={state} tab={tab} setTab={(t) => go("ops", { tab: t })} onOpenDev={openDev} onOpen={nav.onOpen} />
				)}
				{state && view === "settings" && <Settings s={state} tab={tab} setTab={(t) => go("settings", { tab: t })} />}
			</main>
			{state && task && (
				<TaskPanel
					key={task.id}
					t={task}
					s={state}
					onClose={() => setOpen(null)}
					onStory={nav.onStory}
					onCron={nav.onCron}
					onMemory={nav.onMemory}
					onBack={back}
				/>
			)}
			{state && !task && dev && (
				<DevDrawer key={dev.id} dev={dev as DevTask} onClose={() => setOpen(null)} onBack={back} backLabel="返回需求" />
			)}
			<ToastHost />
		</div>
	);
}

function Ops({
	s,
	tab,
	setTab,
	onOpenDev,
	onOpen,
}: {
	s: State;
	tab?: string;
	setTab: (t: string) => void;
	onOpenDev: (id: string) => void;
	onOpen: (id: string) => void;
}) {
	const cur = (OPS_TABS as readonly string[]).includes(tab ?? "") ? (tab as (typeof OPS_TABS)[number]) : "队列";
	const failed = s.items.filter((t) => t.need === "retry" && t.status === "blocked");
	return (
		<>
			<div className="phead">
				<h1>运行</h1>
				<div className="pulse">
					<span>
						进行中 <b>{s.running}</b>
					</span>
					<span>
						等待起草 <b>{s.inflight}</b>
					</span>
					<span className={failed.length ? "bad" : ""}>
						失败 <b>{failed.length}</b>
					</span>
					<span className={s.issues.length ? "bad" : ""}>
						自检 <b>{s.issues.length ? `${s.issues.length} 个问题` : "正常"}</b>
					</span>
				</div>
			</div>
			<Tabs tabs={OPS_TABS} value={cur} onChange={setTab} />
			{cur === "队列" && <DispatchPage state={s} onOpenDev={onOpenDev} />}
			{cur === "失败" &&
				(failed.length ? (
					<div className="list">
						{failed.map((t) => (
							<div
								key={t.id}
								className="trow"
								tabIndex={0}
								onClick={() => onOpen(t.id)}
								onKeyDown={(e) => e.key === "Enter" && onOpen(t.id)}
							>
								<span className="pill p-fail">失败</span>
								<div className="tb">
									<div className="title">{titleOf(t)}</div>
									<div className="meta">
										{t.label && <span>{t.label}</span>}
										{t.error && <span className="bad clamp">{t.error}</span>}
									</div>
								</div>
								<RowActions t={t} s={s} onOpen={() => onOpen(t.id)} onMemory={() => {}} />
							</div>
						))}
					</div>
				) : (
					<p className="calm">没有失败的任务。</p>
				))}
			{cur === "统计" && <StatsPage />}
			{cur === "日报" && <JournalPage />}
			{cur === "自检" && (
				<>
					<p className="meta note">每 5 分钟自检一次。发现新问题会在飞书私聊你，恢复后自动消失。</p>
					<div className="list">
						<div className="chk">
							<span className={`dot${s.auth.authorized ? "" : " b"}`} />
							<div className="tb">
								<div className="title">飞书授权</div>
								<div className="meta">
									{s.auth.authorized
										? s.auth.refreshExpiresAt
											? `正常，会在到期（${date(s.auth.refreshExpiresAt, s.now)}）前自动续期`
											: "正常"
										: "还没有授权，在页面顶部授权"}
								</div>
							</div>
						</div>
						<div className="chk">
							<span className={`dot${!s.pollSince || s.now - s.pollSince > POLL_STALE ? " w" : ""}`} />
							<div className="tb">
								<div className="title">收取消息</div>
								<div className="meta">
									{!s.pollSince
										? "还没开始收取"
										: s.now - s.pollSince > POLL_STALE
											? `${ago(s.now, s.pollSince)}收取过，之后一直没有收取，可能卡住了`
											: `${ago(s.now, s.pollSince)}收取过`}
								</div>
							</div>
						</div>
						{s.issues.length ? (
							s.issues.map((i) => (
								<div key={i.key} className="chk">
									<span className="dot w" />
									<div className="tb">
										<div className="title">{i.title}</div>
										<div className="meta">{i.detail}</div>
									</div>
								</div>
							))
						) : (
							<div className="chk">
								<span className="dot" />
								<div className="tb">
									<div className="title">其他检查</div>
									<div className="meta">起草、任务、告警分析都没有卡住</div>
								</div>
							</div>
						)}
					</div>
				</>
			)}
		</>
	);
}

function Settings({ s, tab, setTab }: { s: State; tab?: string; setTab: (t: string) => void }) {
	const cur = (SET_TABS as readonly string[]).includes(tab ?? "") ? (tab as (typeof SET_TABS)[number]) : "消息来源";
	// 状态只有两种：能用 / 不能用。只有飞书需要你授权，其余跟着服务一起启动
	const channels: Array<[string, string, boolean]> = [
		["飞书", "私聊你的消息、群里 @你 的消息。机器人发的告警会攒一批再分析。", s.auth.authorized],
		["飞书项目", "工作项评论里 @你 的消息", true],
		["机器人", "你私聊机器人的消息，以及卡片上的按钮", true],
		["定时", "定时页里的任务，到点开始做", true],
		["你派的", "在看板上新建的任务、从草稿转成的任务", true],
	];
	return (
		<>
			<div className="phead">
				<h1>设置</h1>
			</div>
			<Tabs tabs={SET_TABS} value={cur} onChange={setTab} />
			{cur === "消息来源" && (
				<div className="list">
					{channels.map(([n, d, ok]) => (
						<div key={n} className="chk">
							<span className={`dot${ok ? "" : " b"}`} />
							<div className="tb">
								<div className="title">{n}</div>
								<div className="meta">{d}</div>
							</div>
							<span className="meta">{ok ? "已开启" : "未授权"}</span>
						</div>
					))}
				</div>
			)}
			{cur === "分派规则" && <RouteRulesPage />}
			{cur === "提示词" && <PromptsPage />}
			{cur === "技能" && <SkillsPage />}
			{cur === "联系人" && <AudiencePage />}
		</>
	);
}

/** 侧栏底部的额度条：已用多少 + 细条，悬停看多久后重置 */
function MiniQuota({ label, w, now }: { label: string; w?: QuotaWindow; now: number }) {
	if (!w) return null;
	const u = Math.min(1, Math.max(0, w.utilization));
	const hot = u >= 0.8;
	return (
		<div className="quota" title={w.resetsAt ? `${span(w.resetsAt - now)}后重置` : "不知道什么时候重置"}>
			<span>
				{label} 已用 <b className={hot ? "warn" : ""}>{pct(u)}</b>
			</span>
			<div
				className="bar"
				role="meter"
				aria-label={`${label}已用`}
				aria-valuenow={Math.round(u * 100)}
				aria-valuemin={0}
				aria-valuemax={100}
			>
				<i className={hot ? "hot" : ""} style={{ width: `${u * 100}%` }} />
			</div>
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
		<div className="issue">
			授权飞书账号后，Cabinet 才能读到私聊和 @你 的消息，并替你发出回复。
			<button className="btn pri sm" onClick={start}>
				授权飞书
			</button>
			{err && <span>{err}</span>}
		</div>
	);
}
