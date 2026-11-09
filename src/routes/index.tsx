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
import { Workbench } from "../components/Workbench";
import { type DevTask, type State, fetchState, post } from "../lib/api";
import { waitingOn } from "../lib/format";
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
const HINTS: Record<View, string> = {
	work: "所有的事：等你处理的、在跑的、排队的、今天做完的",
	stories: "飞书工单按 开发 → 测试 → 发布 推进，挂着哪些任务、发布工单、巡检",
	cron: "到点派给助手的事：周期提醒、发布巡检",
	memory: "助手按什么口径做事：约定和线索，冲突在这里裁定",
	chat: "直接和助手聊；私聊机器人的问答也在这里",
	ops: "系统怎么在跑：队列、失败、统计、日报、健康",
	settings: "改了才来：渠道、Worker、受众",
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

const OPS_TABS = ["队列", "失败", "统计", "日报", "系统健康"] as const;
const SET_TABS = ["渠道", "路由规则", "提示词", "技能", "受众"] as const;

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
	const tab = search.tab;
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
					<button key={v} className={`nav${view === v ? " on" : ""}`} title={HINTS[v]} onClick={() => go(v)}>
						{TITLES[v]}
						{v === "work" && waiting > 0 && <span className="n">{waiting}</span>}
					</button>
				))}
				{state?.quota && (
					<div className="aside-foot">
						<MiniQuota label="Claude 5 小时" w={state.quota.windows.five_hour} now={state.now} />
						<MiniQuota label="7 天" w={state.quota.windows.seven_day} now={state.now} />
					</div>
				)}
			</aside>
			<main className={view === "chat" ? "full" : ""}>
				{error && !state && <div className="issue">连接不上 cabinet 进程</div>}
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
							<div className="pulse">
								<span>到点派给助手的事；每次运行都是工作台里的一件事</span>
							</div>
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
							<div className="pulse">
								<span>直接和助手聊；飞书私聊机器人的问答也在这里</span>
							</div>
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
						运行中 <b>{s.running}</b>
					</span>
					<span>
						待起草 <b>{s.inflight}</b>
					</span>
					<span className={failed.length ? "hot" : ""}>
						失败 <b>{failed.length}</b>
					</span>
					<span className={s.issues.length ? "hot" : ""}>
						看门狗 <b>{s.issues.length ? `${s.issues.length} 个问题` : "正常"}</b>
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
									<div className="title">{t.title}</div>
									<div className="meta">
										<span>{t.label}</span>
										<span className="bad">{(t.error ?? "").slice(0, 120)}</span>
									</div>
								</div>
								<div className="acts" />
							</div>
						))}
					</div>
				) : (
					<div className="empty">没有没处理的失败</div>
				))}
			{cur === "统计" && <StatsPage />}
			{cur === "日报" && <JournalPage />}
			{cur === "系统健康" && (
				<>
					<p className="meta note">看门狗每 5 分钟按固定规则查一遍，新问题私聊你一次，恢复后自动清掉。</p>
					<div className="list">
						<div className="chk">
							<span className={`dot${s.auth.authorized ? "" : " b"}`} />
							<div className="tb">
								<div className="title">飞书授权</div>
								<div className="meta">
									{s.auth.authorized
										? s.auth.refreshExpiresAt
											? `正常，${new Date(s.auth.refreshExpiresAt * 1000).toLocaleDateString("zh-CN")} 到期，到期前自动刷新`
											: "正常"
										: "没有授权"}
								</div>
							</div>
						</div>
						<div className="chk">
							<span className="dot" />
							<div className="tb">
								<div className="title">轮询</div>
								<div className="meta">{s.pollSince ? `${Math.round(s.now - s.pollSince)} 秒前拉过一次` : "还没开始"}</div>
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
									<div className="title">看门狗</div>
									<div className="meta">没有发现问题：起草、任务、告警攒批都没有卡住，失败没有扎堆</div>
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
	const cur = (SET_TABS as readonly string[]).includes(tab ?? "") ? (tab as (typeof SET_TABS)[number]) : "渠道";
	const channels: Array<[string, string, string]> = [
		["飞书", "用你的身份轮询私聊和群里 @你；机器人 @你的当告警攒批", s.auth.authorized ? "已授权" : "没有授权"],
		["飞书项目", "评论里 @你（meegle）", "轮询"],
		["机器人", "私聊机器人、卡片按钮（长连接）", "长连接"],
		["定时", "定时页里的任务到点产生事件", "内置"],
		["看板", "新任务、草稿转任务、需求页派活", "内置"],
	];
	return (
		<>
			<div className="phead">
				<h1>设置</h1>
			</div>
			<Tabs tabs={SET_TABS} value={cur} onChange={setTab} />
			{cur === "渠道" && (
				<>
					<div className="list">
						{channels.map(([n, d, st]) => (
							<div key={n} className="chk">
								<span className={`dot${n === "飞书" && !s.auth.authorized ? " b" : ""}`} />
								<div className="tb">
									<div className="title">{n}</div>
									<div className="meta">{d}</div>
								</div>
								<span className="meta">{st}</span>
							</div>
						))}
					</div>
					<p className="meta note">Webhook（Sentry、GitLab、CI 推送）在 P5 接入：需要先定对外暴露方式。</p>
				</>
			)}
			{cur === "路由规则" && <RouteRulesPage />}
			{cur === "提示词" && <PromptsPage />}
			{cur === "技能" && <SkillsPage />}
			{cur === "受众" && <AudiencePage />}
		</>
	);
}

/** 侧栏底部的额度条：数字 + 细条，悬停看重置时间 */
function MiniQuota({ label, w, now }: { label: string; w?: QuotaWindow; now: number }) {
	if (!w) return null;
	const hot = w.utilization >= 0.8;
	return (
		<div className="quota" title={w.resetsAt ? `${span(w.resetsAt - now)} 后重置` : "重置时间未知"}>
			<span>
				{label} <b className={hot ? "bad" : ""}>{pct(w.utilization)}</b>
			</span>
			<div className="bar">
				<i className={hot ? "hot" : ""} style={{ width: `${Math.min(100, w.utilization * 100)}%` }} />
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
			还没有授权飞书用户身份：读不到你的私聊和 @你 的消息，也不能以你的身份发出草稿。
			<button className="btn pri sm" onClick={start}>
				授权飞书
			</button>
			{err && <span>{err}</span>}
		</div>
	);
}
