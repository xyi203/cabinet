import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { AgentsPage } from "../components/Agents";
import { AudiencePage } from "../components/Audience";
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
import { Rail } from "../components/Rail";
import { Workbench } from "../components/Workbench";
import { type DevTask, type State, fetchMemory, fetchSchedules, fetchState, post } from "../lib/api";
import { ago, date, titleOf, waitingOn, when } from "../lib/format";
import { PageHead } from "../components/ui";
import { useLiveUpdates, useReloadOnNewBuild } from "../lib/live";

const TITLES = {
	work: "工作台",
	stories: "需求",
	cron: "定时",
	memory: "记忆",
	agents: "智能体",
	ops: "运行",
	settings: "设置",
} as const;
type View = keyof typeof TITLES;
/** 改版前的入口：收藏的链接跳到新地方（docs/router-worker.md §5） */
const ALIASES: Record<string, View> = {
	home: "work",
	todo: "work",
	tasks: "work",
	drafts: "work",
	failed: "ops",
	dispatch: "ops",
	stats: "ops",
	journal: "ops",
	schedules: "cron",
	// 对话页已并进工作台：在工作台底部输入框说就行
	qa: "work",
	chat: "work",
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
	agents: "有哪些助手、各自在做什么，模型、档位和提示词",
	ops: "队列、失败、花费和每日小结",
	settings: "消息来源、分派规则、提示词、联系人",
};

export const Route = createFileRoute("/")({
	component: Dashboard,
	validateSearch: (
		search: Record<string, unknown>,
	): { view?: View; story?: string; tab?: string; sched?: string; task?: string; dev?: string; agent?: string } => ({
		view: typeof search.view !== "string" ? undefined : search.view in TITLES ? (search.view as View) : ALIASES[search.view],
		story: typeof search.story === "string" || typeof search.story === "number" ? String(search.story) : undefined,
		tab: typeof search.tab === "string" ? search.tab : undefined,
		sched: typeof search.sched === "string" ? search.sched : undefined,
		// 任务详情抽屉：task 是看板上的一件事（tsk-xxx、apv:、q:、fail-、qa-、mem:），dev 是没挂在任何事上的 agent 任务
		task: typeof search.task === "string" || typeof search.task === "number" ? String(search.task) : undefined,
		dev: typeof search.dev === "string" || typeof search.dev === "number" ? String(search.dev) : undefined,
		// 智能体页打开的那个助手（_config 是配置文件）
		agent: typeof search.agent === "string" ? search.agent : undefined,
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
	const [storyReopen, setStoryReopen] = useState(0);
	const [connected, setConnected] = useState(true);
	const { data: state, error } = useQuery({ queryKey: ["state"], queryFn: fetchState, refetchInterval: connected ? 15_000 : 5_000 });
	useLiveUpdates(useCallback((c: boolean) => setConnected(c), []));
	// 页头现状句用的数据；和页面里同一个 queryKey，共用缓存，不多发请求
	const { data: scheds } = useQuery({
		queryKey: ["schedules"],
		queryFn: fetchSchedules,
		refetchInterval: 30_000,
		enabled: view === "cron",
	});
	const { data: mem } = useQuery({ queryKey: ["memory"], queryFn: fetchMemory, enabled: view === "memory" });
	const tab0 = search.tab && (TAB_ALIASES[search.tab] ?? search.tab);
	useReloadOnNewBuild(state?.build, `${view}:${tab0 ?? ""}`, view === "work");

	const go = (v: View, extra: { story?: string; tab?: string; sched?: string; agent?: string } = {}) =>
		void navigate({ to: "/", search: v === "work" ? {} : { view: v, ...extra } });
	const tab = search.tab && (TAB_ALIASES[search.tab] ?? search.tab);
	type Detail = { task?: string; dev?: string; story?: string; sched?: string };
	/** 打开任务详情：写进 URL（压入历史），当前页面和其余参数保持不变；story / sched 记着从哪点进来的，用来返回 */
	const openDetail = (d: Detail) => void navigate({ to: "/", search: (prev) => ({ ...prev, task: undefined, dev: undefined, ...d }) });
	/** agent 任务 id → 它所在的那件事；不在工作台窗口里的（老任务、对话）直接开任务抽屉 */
	const openDev = (devId: string, backStory?: string) => {
		const t = state?.items.find((x) => x.devTasks.includes(devId));
		openDetail({ ...(t ? { task: t.id } : { dev: devId }), ...(backStory ? { story: backStory } : {}) });
	};
	const nav = {
		onOpen: (id: string) => openDetail({ task: id }),
		onStory: (id: string) => {
			setStoryReopen((n) => n + 1);
			go("stories", { story: id });
		},
		/** 去定时页；带 id 时直接打开那个定时任务的执行记录 */
		onCron: (id?: string) => go("cron", id ? { sched: id } : {}),
	};
	const task = search.task ? state?.items.find((x) => x.id === search.task) : undefined;
	const dev = !task && search.dev ? state?.devTasks.find((x) => x.id === search.dev) : undefined;
	/** 抽屉开着的时候，底下的需求 / 定时抽屉不渲染；返回就是去掉 task / dev，它们自然回来 */
	const detail = !!(task || dev);
	const closeDetail = () =>
		void navigate({ to: "/", search: (prev) => ({ ...prev, task: undefined, dev: undefined, story: undefined, sched: undefined }) });
	const backCron = view === "cron" ? search.sched : undefined;
	const backStory = view === "stories" ? search.story : undefined;
	const back =
		backCron || backStory ? () => void navigate({ to: "/", search: (prev) => ({ ...prev, task: undefined, dev: undefined }) }) : undefined;
	const backLabel = backCron ? "返回定时任务" : "返回需求";
	const waiting = state?.items.filter(waitingOn).length ?? 0;

	return (
		<div className="app">
			<Rail
				items={(Object.keys(TITLES) as View[]).map((v) => ({
					key: v,
					label: TITLES[v],
					hint: HINTS[v],
					...(v === "work" && waiting > 0 ? { badge: waiting, badgeLabel: `${waiting} 件等你处理` } : {}),
				}))}
				current={view}
				onGo={(v) => go(v as View)}
				quota={state?.quota?.windows}
				now={state?.now ?? 0}
			/>
			<main>
				{error && !state && <div className="issue">连不上 Cabinet 服务，正在重试。确认服务已经启动。</div>}
				{state && !connected && <div className="issue">和 Cabinet 服务的连接断了，正在重连，页面上的内容可能不是最新的。</div>}
				{state && (!state.auth.authorized || Boolean(state.auth.missingScopes?.length)) && (
					<AuthBanner missing={state.auth.authorized ? state.auth.missingScopes : undefined} />
				)}
				{!state && !error && <div className="empty">加载中…</div>}
				{state && view === "work" && (
					<Workbench
						s={state}
						nav={nav}
						open={search.task}
						onSelect={(id) => void navigate({ to: "/", search: (prev) => ({ ...prev, task: id }), replace: true })}
					/>
				)}
				{state && view === "stories" && (
					<>
						<PageHead title="需求" finding={storiesFinding(state)} />
						<StoryBoard
							key={`${search.story ?? ""}:${detail}:${storyReopen}`}
							state={state}
							initialOpen={detail ? undefined : search.story}
							onOpenDev={openDev}
						/>
					</>
				)}
				{state && view === "cron" && (
					<>
						<PageHead title="定时" finding={scheds && cronFinding(scheds, state.now)} />
						<Schedules
							agents={state.agents}
							stories={state.stories}
							items={state.items}
							now={state.now}
							onOpenTask={(id, fromSched) => {
								openDetail({ task: id, ...(fromSched ? { sched: fromSched } : {}) });
							}}
							onOpenStory={nav.onStory}
							openId={detail ? undefined : search.sched}
							onOpenSched={(id) => go("cron", id ? { sched: id } : {})}
						/>
					</>
				)}
				{view === "memory" && (
					<>
						<PageHead
							title="记忆"
							finding={
								mem &&
								(mem.down.length || mem.error
									? `Hindsight「${mem.bank}」现在连不上，助手暂时用不上记忆。`
									: `${mem.conventions.length} 条约定每次都带；经验与事实存在 Hindsight「${mem.bank}」，起草和问答时按需召回。`)
							}
						/>
						<MemoryBoard />
					</>
				)}
				{state && view === "agents" && (
					<AgentsPage
						agents={state.agents}
						now={state.now}
						open={search.agent}
						onOpen={(name) => go("agents", name ? { agent: name } : {})}
					/>
				)}
				{state && view === "ops" && (
					<Ops s={state} tab={tab} setTab={(t) => go("ops", { tab: t })} onOpenDev={openDev} onOpen={nav.onOpen} />
				)}
				{state && view === "settings" && <Settings s={state} tab={tab} setTab={(t) => go("settings", { tab: t })} />}
			</main>
			{/* 工作台的详情在页面右边，不再盖抽屉 */}
			{state && task && view !== "work" && (
				<TaskPanel
					key={task.id}
					t={task}
					s={state}
					onClose={closeDetail}
					onStory={nav.onStory}
					onCron={nav.onCron}
					onBack={back}
					backLabel={backLabel}
				/>
			)}
			{state && !task && dev && <DevDrawer key={dev.id} dev={dev as DevTask} onClose={closeDetail} onBack={back} backLabel={backLabel} />}
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
			<PageHead
				title="运行"
				finding={
					<>
						{s.running ? `${s.running} 件在跑` : "没有在跑的"}
						{s.inflight > 0 && `，${s.inflight} 条等待起草`}
						{failed.length > 0 && <span className="text-bad">，{failed.length} 件失败</span>}
						{s.issues.length ? <span className="text-bad">，自检发现 {s.issues.length} 个问题</span> : "，自检正常"}。
					</>
				}
			/>
			<Tabs tabs={OPS_TABS} value={cur} onChange={setTab} />
			{cur === "队列" && <DispatchPage onOpenDev={onOpenDev} />}
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
								<RowActions t={t} s={s} onOpen={() => onOpen(t.id)} />
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
									{s.auth.authorized && s.auth.missingScopes?.length
										? `缺少权限 ${s.auth.missingScopes.join("、")}，在页面顶部重新授权`
										: s.auth.authorized
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
			<PageHead
				title="设置"
				finding={`飞书${s.auth.authorized ? "已授权" : "还没授权"}，${channels.filter((c) => c[2]).length} / ${channels.length} 个消息来源在收取。`}
			/>
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

/** 需求页的现状：几个还没发布、几个任务在跑 */
function storiesFinding(s: State) {
	const open = s.stories.filter((x) => x.stage !== "done" && x.stage !== "dropped").length;
	if (!open) return "没有还在推进的需求。";
	const running = s.devTasks.filter((t) => t.storyId && !t.patrol && t.status === "running").length;
	return `${open} 个需求还没发布${running ? `，${running} 个任务在跑` : ""}。`;
}

/** 定时页的现状：启用了几个、下一个什么时候跑 */
function cronFinding(list: Array<{ name: string; enabled: boolean; nextRun: number | null }>, now: number) {
	const on = list.filter((x) => x.enabled);
	if (!on.length) return list.length ? `没有启用的定时任务，${list.length} 个已暂停或结束。` : "还没有定时任务。";
	const next = on.filter((x) => x.nextRun).toSorted((x, y) => (x.nextRun ?? 0) - (y.nextRun ?? 0))[0];
	return `${on.length} 个定时任务已启用${next?.nextRun ? `，下一个是「${next.name}」，${when(next.nextRun, now)}` : ""}。`;
}

/** 没授权；或者授权过、但缺了代码后来加的权限（missing），要重新授权一次 */
function AuthBanner({ missing }: { missing?: string[] }) {
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
			{missing?.length
				? `飞书授权缺少权限 ${missing.join("、")}，重新授权一次才能用上（先在开发者后台开通）。`
				: "授权飞书账号后，Cabinet 才能读到私聊和 @你 的消息，并替你发出回复。"}
			<button className="btn pri sm" onClick={start}>
				{missing?.length ? "重新授权" : "授权飞书"}
			</button>
			{err && <span>{err}</span>}
		</div>
	);
}
