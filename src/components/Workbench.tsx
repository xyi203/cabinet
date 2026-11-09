// 工作台：所有「一件事」按 等你处理 / 进行中 / 排队中 / 今天完成 分组（docs/router-worker.md §5.1）。
// 每行一个主操作就地办完；点整行打开任务详情（时间线）。也能切成分栏看
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { type Schedule, type State, type TaskView, fetchSchedules, pollNow } from "../lib/api";
import { AGENT_NAME, SOURCE, SOURCE_FILTER, ago, describeDraft, hm, money, pillOf, titleOf, waitingOn } from "../lib/format";
import { RowActions, liveDraft } from "./Actions";
import { NewTask } from "./NewTask";
import { toast } from "./Toast";

/** 等你处理里先放要你动手的：审批、发送、拍板、失败，最后是看结论 */
const NEED_ORDER: Record<string, number> = { approve: 0, send: 1, decide: 2, retry: 3, read: 4 };

export interface Nav {
	onOpen: (id: string) => void;
	onStory: (id: string) => void;
	onMemory: () => void;
	onCron: () => void;
}

/** 谁在做：默认的助手不写（几乎每行都是它），只标出开发助手、告警分析这类 */
export const workerName = (t: Pick<TaskView, "worker" | "tier">) =>
	t.worker && t.worker !== "assistant" ? (AGENT_NAME[t.worker] ?? t.worker) : "";

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
			title={`需求：${st.title}`}
			onClick={(e) => {
				e.stopPropagation();
				onStory(st.id);
			}}
		>
			{st.title.replace(/^【[^】]*】/, "")}
		</button>
	);
}

/** 来源一行：飞书「发布群」张三；label 已经说清来源时不重复 */
function Source({ t }: { t: TaskView }) {
	const src = SOURCE[t.source] ?? t.source;
	return <span className="src">{t.label ? (t.label.includes(src) ? t.label : `${src}：${t.label}`) : src}</span>;
}

function Row({ t, s, nav, sel }: { t: TaskView; s: State; nav: Nav; sel: boolean }) {
	const draft = t.need === "send" ? liveDraft(t, s) : undefined;
	const sub =
		draft?.status === "pending" && !draft.mr ? (
			<span className="reply clamp">回复：{describeDraft(draft)}</span>
		) : t.status === "in_progress" && t.live ? (
			<span className="livedot">{t.live}</span>
		) : t.hold ? (
			<span>你们正在聊，{Math.max(0, Math.ceil(t.hold - s.now))} 秒后开始起草</span>
		) : t.error && t.need === "retry" ? (
			<span className="bad clamp">{t.error}</span>
		) : t.result ? (
			<span>{t.result}</span>
		) : null;
	const closed = t.status === "done" || t.status === "cancelled";
	return (
		<div
			className={`trow${sel ? " sel" : ""}`}
			tabIndex={0}
			onClick={() => nav.onOpen(t.id)}
			onKeyDown={(e) => e.key === "Enter" && nav.onOpen(t.id)}
		>
			<Pill t={t} />
			<div className="tb">
				<div className="title">{titleOf(t)}</div>
				<div className="meta">
					<Source t={t} />
					<StoryTag id={t.storyId} s={s} onStory={nav.onStory} />
					{workerName(t) && <span>{workerName(t)}</span>}
					{sub}
				</div>
			</div>
			<div className="acts">
				<RowActions t={t} s={s} onOpen={() => nav.onOpen(t.id)} onMemory={nav.onMemory} />
				<span className="age num">{closed ? hm(t.closed ?? t.updated) : ago(s.now, t.updated)}</span>
			</div>
		</div>
	);
}

function Card({ t, s, nav }: { t: TaskView; s: State; nav: Nav }) {
	return (
		<div className="kcard" tabIndex={0} onClick={() => nav.onOpen(t.id)} onKeyDown={(e) => e.key === "Enter" && nav.onOpen(t.id)}>
			<Pill t={t} />
			<div className="title">{titleOf(t)}</div>
			<div className="meta">
				<Source t={t} />
				<StoryTag id={t.storyId} s={s} onStory={nav.onStory} />
				{workerName(t) && <span>{workerName(t)}</span>}
				<span className="num">{ago(s.now, t.updated)}</span>
			</div>
			<RowActions t={t} s={s} onOpen={() => nav.onOpen(t.id)} onMemory={nav.onMemory} />
		</div>
	);
}

function Group({
	name,
	items,
	s,
	nav,
	open,
	empty,
}: {
	name: string;
	items: TaskView[];
	s: State;
	nav: Nav;
	open?: string;
	/** 空的时候说什么；不给就整组不显示 */
	empty?: string;
}) {
	if (!items.length && !empty) return null;
	return (
		<section className="wgroup">
			<div className="gh">
				<h2>{name}</h2>
				{items.length > 0 && <span className="c num">{items.length}</span>}
			</div>
			{items.length ? (
				<div className="list">
					{items.map((t) => (
						<Row key={t.id} t={t} s={s} nav={nav} sel={open === t.id} />
					))}
				</div>
			) : (
				<p className="calm">{empty}</p>
			)}
		</section>
	);
}

/** 今天还会运行的定时任务 */
function Upcoming({ s, onCron }: { s: State; onCron: () => void }) {
	const { data } = useQuery({ queryKey: ["schedules"], queryFn: fetchSchedules, refetchInterval: 60_000 });
	const n = new Date(s.now * 1000);
	const end = new Date(n.getFullYear(), n.getMonth(), n.getDate(), 23, 59, 59).getTime() / 1000;
	const next = (data ?? [])
		.filter((x: Schedule) => x.enabled && x.nextRun && x.nextRun <= end)
		.toSorted((a, b) => a.nextRun! - b.nextRun!)
		.slice(0, 4);
	return (
		<div className="upnext">
			<span>{next.length ? "今天还会运行" : "今天没有要运行的定时任务了"}</span>
			{next.map((x) => (
				<span key={x.id}>
					<b className="num">{hm(x.nextRun!)}</b> {x.name}
				</span>
			))}
			<button className="link" onClick={onCron}>
				查看定时任务
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
	const today = new Date(s.now * 1000);
	const dayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() / 1000;
	const wait = list
		.filter(waitingOn)
		.toSorted((a, b) => (NEED_ORDER[a.need ?? ""] ?? 9) - (NEED_ORDER[b.need ?? ""] ?? 9) || b.updated - a.updated);
	const prog = list.filter((t) => t.status === "in_progress");
	const queue = list.filter((t) => t.status === "todo").toSorted((a, b) => a.created - b.created);
	const done = list.filter((t) => (t.status === "done" || t.status === "cancelled") && (t.closed ?? t.updated) >= dayStart);
	const filtered = Boolean(sources.length || kw);
	return (
		<>
			<div className="phead">
				<h1>工作台</h1>
				<div className="pulse">
					<span>
						今天花费 <b>{money(s.stats.usage.cost)}</b>
					</span>
					<span>{s.pollSince ? `${ago(s.now, s.pollSince)}收取过消息` : "还没开始收取消息"}</span>
					<button
						className="link"
						onClick={() =>
							pollNow().then(
								() => toast("正在收取新消息"),
								(e) => toast((e as Error).message, true),
							)
						}
					>
						收取新消息
					</button>
				</div>
			</div>
			{s.issues.length > 0 && (
				<div className="issue">
					<b>自检发现 {s.issues.length} 个问题：</b>
					{s.issues.map((i) => i.title).join("；")}
				</div>
			)}
			<div className="tools">
				<div className="chips" role="group" aria-label="按来源筛选">
					{SOURCE_FILTER.map(([n]) => (
						<button key={n} className={`chip${src === n ? " on" : ""}`} aria-pressed={src === n} onClick={() => setSrc(n)}>
							{n}
						</button>
					))}
				</div>
				<input
					id="work-search"
					type="search"
					className="in"
					value={q}
					onChange={(e) => setQ(e.target.value)}
					placeholder="搜索"
					aria-label="搜索标题或来源"
				/>
				<span className="spacer" />
				<div className="seg" role="group" aria-label="显示方式">
					<button className={mode === "list" ? "on" : ""} aria-pressed={mode === "list"} onClick={() => setModeSaved("list")}>
						列表
					</button>
					<button className={mode === "board" ? "on" : ""} aria-pressed={mode === "board"} onClick={() => setModeSaved("board")}>
						分栏
					</button>
				</div>
				<button className="btn" aria-expanded={creating} onClick={() => setCreating(!creating)}>
					{creating ? "收起" : "新建任务"}
				</button>
			</div>
			{creating && (
				<NewTask
					agents={s.agents}
					onCreated={() => {
						setCreating(false);
						toast("已交给助手，可以在「进行中」看进度");
					}}
				/>
			)}
			{mode === "board" ? (
				<div className="kboard">
					{(
						[
							["等你处理", wait],
							["进行中", prog],
							["排队中", queue],
							["今天完成", done],
						] as Array<[string, TaskView[]]>
					).map(([name, xs]) => (
						<div key={name} className="kcol">
							<h3>
								{name}
								<span className="num">{xs.length}</span>
							</h3>
							{xs.map((t) => (
								<Card key={t.id} t={t} s={s} nav={nav} />
							))}
						</div>
					))}
				</div>
			) : (
				<>
					<Group
						name="等你处理"
						items={wait}
						s={s}
						nav={nav}
						open={open}
						empty={filtered ? "没有符合条件的" : "都处理完了。新消息进来，起草好的回复会出现在这里。"}
					/>
					<Group name="进行中" items={prog} s={s} nav={nav} open={open} />
					<Group name="排队中" items={queue} s={s} nav={nav} open={open} />
					{!filtered && <Upcoming s={s} onCron={nav.onCron} />}
					{done.length > 0 && (
						<details className="wgroup more">
							<summary className="gh">
								<h2>今天完成</h2>
								<span className="c num">{done.length}</span>
							</summary>
							<div className="list">
								{done.map((t) => (
									<Row key={t.id} t={t} s={s} nav={nav} sel={open === t.id} />
								))}
							</div>
						</details>
					)}
				</>
			)}
		</>
	);
}
