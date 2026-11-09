// 工作台：所有「一件事」按 等我 / 进行中 / 排队 / 今天完成 分组（docs/router-worker.md §5.1）。
// 每行一个主操作就地办完；点整行打开任务详情（时间线）。也能切成五列看板
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { type Schedule, type State, type TaskView, fetchSchedules, pollNow } from "../lib/api";
import { AGENT_NAME, SOURCE, SOURCE_FILTER, money, pillOf, waitingOn } from "../lib/format";
import { RowActions } from "./Actions";
import { NewTask } from "./NewTask";
import { toast } from "./Toast";

/** 等我里先放要你动手的：审批、发送、拍板、失败，最后是看结论 */
const NEED_ORDER: Record<string, number> = { approve: 0, send: 1, decide: 2, retry: 3, read: 4 };

export interface Nav {
	onOpen: (id: string) => void;
	onStory: (id: string) => void;
	onMemory: () => void;
	onCron: () => void;
}

const short = (ts: number) => new Date(ts * 1000).toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" });
function age(now: number, ts: number) {
	const s = Math.max(0, now - ts);
	return s < 60 ? "刚刚" : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
}
export const workerName = (t: Pick<TaskView, "worker" | "tier">) =>
	t.worker ? `${AGENT_NAME[t.worker] ?? t.worker}${t.tier && t.tier !== "task" ? ` · ${t.tier}` : ""}` : "";

export function Pill({ t }: { t: TaskView }) {
	const [text, cls] = pillOf(t);
	return <span className={`pill ${cls}`}>{text}</span>;
}

export function StoryTag({ id, s, onStory }: { id?: string | null; s: State; onStory: (id: string) => void }) {
	const st = id ? s.stories.find((x) => x.id === id) : undefined;
	if (!st) return null;
	return (
		<button
			className="story"
			title={st.title}
			onClick={(e) => {
				e.stopPropagation();
				onStory(st.id);
			}}
		>
			{st.title.replace(/^【[^】]*】/, "").slice(0, 12)}
		</button>
	);
}

function Row({ t, s, nav, sel }: { t: TaskView; s: State; nav: Nav; sel: boolean }) {
	const sub =
		t.status === "in_progress" && t.live ? (
			<span className="livedot">{t.live}</span>
		) : t.hold ? (
			<span>你正在和他聊，{Math.max(0, Math.ceil(t.hold - s.now))} 秒后处理</span>
		) : t.error && t.need === "retry" ? (
			<span className="bad">{t.error.slice(0, 80)}</span>
		) : t.result ? (
			<span>{t.result}</span>
		) : null;
	return (
		<div
			className={`trow${sel ? " sel" : ""}`}
			tabIndex={0}
			onClick={() => nav.onOpen(t.id)}
			onKeyDown={(e) => e.key === "Enter" && nav.onOpen(t.id)}
		>
			<Pill t={t} />
			<div className="tb">
				<div className="title">{t.title || "（无内容）"}</div>
				<div className="meta">
					<span className="src">
						{SOURCE[t.source] ?? t.source}
						{t.label ? ` · ${t.label}` : ""}
					</span>
					<StoryTag id={t.storyId} s={s} onStory={nav.onStory} />
					{workerName(t) && <span>{workerName(t)}</span>}
					{sub}
				</div>
			</div>
			<div className="acts">
				<RowActions t={t} s={s} onOpen={() => nav.onOpen(t.id)} onMemory={nav.onMemory} />
				<span className="age">{waitingOn(t) || t.status !== "done" ? age(s.now, t.updated) : short(t.closed ?? t.updated)}</span>
			</div>
		</div>
	);
}

function Card({ t, s, nav }: { t: TaskView; s: State; nav: Nav }) {
	return (
		<div className="kcard" tabIndex={0} onClick={() => nav.onOpen(t.id)} onKeyDown={(e) => e.key === "Enter" && nav.onOpen(t.id)}>
			<Pill t={t} />
			<div className="title">{t.title || "（无内容）"}</div>
			<div className="meta">
				<span className="src">
					{SOURCE[t.source] ?? t.source}
					{t.label ? ` · ${t.label}` : ""}
				</span>
			</div>
			<div className="meta">
				<StoryTag id={t.storyId} s={s} onStory={nav.onStory} />
				{workerName(t) && <span>{workerName(t)}</span>}
				<span className="mono">{age(s.now, t.updated)}</span>
			</div>
			<RowActions t={t} s={s} onOpen={() => nav.onOpen(t.id)} onMemory={nav.onMemory} />
		</div>
	);
}

function Group({
	name,
	hint,
	items,
	s,
	nav,
	open,
	wait,
}: {
	name: string;
	hint: string;
	items: TaskView[];
	s: State;
	nav: Nav;
	open?: string;
	wait?: boolean;
}) {
	return (
		<section className="wgroup">
			<div className={`gh${wait ? " wait" : ""}`}>
				<h2>{name}</h2>
				<span className="c">{items.length}</span>
				<span className="hint">{hint}</span>
			</div>
			{items.length ? (
				<div className="list">
					{items.map((t) => (
						<Row key={t.id} t={t} s={s} nav={nav} sel={open === t.id} />
					))}
				</div>
			) : (
				<div className="empty">没有</div>
			)}
		</section>
	);
}

/** 今天还会触发的定时任务 */
function Upcoming({ s, onCron }: { s: State; onCron: () => void }) {
	const { data } = useQuery({ queryKey: ["schedules"], queryFn: fetchSchedules, refetchInterval: 60_000 });
	const end = new Date(new Date(s.now * 1000).toLocaleDateString("sv-SE") + "T23:59:59").getTime() / 1000;
	const next = (data ?? [])
		.filter((x: Schedule) => x.enabled && x.nextRun && x.nextRun <= end)
		.toSorted((a, b) => a.nextRun! - b.nextRun!)
		.slice(0, 4);
	return (
		<div className="upnext">
			<span>接下来</span>
			{next.length ? (
				next.map((x) => (
					<span key={x.id}>
						<b>{short(x.nextRun!)}</b> {x.name}
					</span>
				))
			) : (
				<span>今天没有要触发的定时任务</span>
			)}
			<button className="link" onClick={onCron}>
				全部定时任务
			</button>
		</div>
	);
}

export function Workbench({ s, nav, open }: { s: State; nav: Nav; open?: string }) {
	const [mode, setMode] = useState<"list" | "board">(() => {
		try {
			return localStorage.getItem("cabinet.workMode") === "board" ? "board" : "list";
		} catch {
			return "list";
		}
	});
	const [src, setSrc] = useState("全部");
	const [q, setQ] = useState("");
	const [creating, setCreating] = useState(false);
	const setModeSaved = (m: "list" | "board") => {
		setMode(m);
		try {
			localStorage.setItem("cabinet.workMode", m);
		} catch {
			// 无痕窗口拿不到 localStorage：只是记不住选择
		}
	};
	const sources = SOURCE_FILTER.find(([n]) => n === src)?.[1] ?? [];
	const kw = q.trim().toLowerCase();
	const list = s.items.filter(
		(t) => (!sources.length || sources.includes(t.source)) && (!kw || `${t.title} ${t.label}`.toLowerCase().includes(kw)),
	);
	const dayStart = new Date(new Date(s.now * 1000).toLocaleDateString("sv-SE") + "T00:00:00").getTime() / 1000;
	const wait = list
		.filter(waitingOn)
		.toSorted((a, b) => (NEED_ORDER[a.need ?? ""] ?? 9) - (NEED_ORDER[b.need ?? ""] ?? 9) || b.updated - a.updated);
	const prog = list.filter((t) => t.status === "in_progress");
	const queue = list.filter((t) => t.status === "todo").toSorted((a, b) => a.created - b.created);
	const done = list.filter((t) => (t.status === "done" || t.status === "cancelled") && (t.closed ?? t.updated) >= dayStart);
	const all = s.items;
	const lag = s.pollSince ? `${Math.round(s.now - s.pollSince)}s 前` : "未开始";
	return (
		<>
			<div className="phead">
				<h1>工作台</h1>
				<div className="pulse">
					<span className="hot">
						等我 <b>{all.filter(waitingOn).length}</b>
					</span>
					<span>
						进行中 <b>{all.filter((t) => t.status === "in_progress").length}</b>
					</span>
					<span>
						排队 <b>{all.filter((t) => t.status === "todo").length}</b>
					</span>
					<span>
						今日花费 <b>{money(s.stats.usage.cost)}</b>
					</span>
					<span>
						轮询 <b>{lag}</b>
					</span>
					<button
						className="link"
						onClick={() =>
							pollNow().then(
								() => toast("已开始拉取新消息"),
								(e) => toast((e as Error).message, true),
							)
						}
					>
						立即拉取
					</button>
				</div>
			</div>
			{s.issues.length > 0 && (
				<div className="issue">
					<b>系统有 {s.issues.length} 个问题：</b>
					{s.issues.map((i) => i.title).join("；")}
				</div>
			)}
			<div className="tools">
				<div className="seg" role="group" aria-label="视图">
					<button className={mode === "list" ? "on" : ""} onClick={() => setModeSaved("list")}>
						列表
					</button>
					<button className={mode === "board" ? "on" : ""} onClick={() => setModeSaved("board")}>
						看板
					</button>
				</div>
				<div className="chips">
					{SOURCE_FILTER.map(([n]) => (
						<button key={n} className={`chip${src === n ? " on" : ""}`} onClick={() => setSrc(n)}>
							{n}
						</button>
					))}
				</div>
				<input
					id="work-search"
					className="in"
					value={q}
					onChange={(e) => setQ(e.target.value)}
					placeholder="搜标题、来源"
					aria-label="搜索任务"
				/>
				<span className="spacer" />
				<button className="btn" onClick={() => setCreating(!creating)}>
					{creating ? "收起" : "+ 新任务"}
				</button>
			</div>
			{creating && (
				<NewTask
					agents={s.agents}
					onCreated={() => {
						setCreating(false);
						toast("已派出，进度在「进行中」");
					}}
				/>
			)}
			{mode === "board" ? (
				<div className="kboard">
					{(
						[
							["排队", queue, false],
							["进行中", prog, false],
							["等我看", list.filter((t) => t.status === "in_review"), true],
							["等我批", list.filter((t) => t.status === "blocked"), true],
							["今天完成", done, false],
						] as Array<[string, TaskView[], boolean]>
					).map(([name, xs, w]) => (
						<div key={name} className={`kcol${w ? " wait" : ""}`}>
							<h3>
								{name}
								<span className="mono">{xs.length}</span>
							</h3>
							{xs.map((t) => (
								<Card key={t.id} t={t} s={s} nav={nav} />
							))}
						</div>
					))}
				</div>
			) : (
				<>
					<Group name="等我" hint="要你发送、审批、拍板或看一眼的" items={wait} s={s} nav={nav} open={open} wait />
					<Group name="进行中" hint="Worker 正在跑" items={prog} s={s} nav={nav} open={open} />
					<Group name="排队" hint="还没开始处理" items={queue} s={s} nav={nav} open={open} />
					<Upcoming s={s} onCron={nav.onCron} />
					<details className="wgroup more">
						<summary className="gh">
							<h2>今天完成</h2>
							<span className="c">{done.length}</span>
							<span className="hint">含建议不回、你已亲自回复、没变化的巡检</span>
						</summary>
						{done.length ? (
							<div className="list">
								{done.map((t) => (
									<Row key={t.id} t={t} s={s} nav={nav} sel={open === t.id} />
								))}
							</div>
						) : (
							<div className="empty">今天还没有完成的</div>
						)}
					</details>
				</>
			)}
		</>
	);
}
