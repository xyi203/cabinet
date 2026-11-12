// 工作台（docs/router-worker.md §5.1），照 Claude 桌面端排：左边是紧凑的索引——正在运行 / 等你 / 排队 / 今天完成，一行一件事，顶上按状态筛选；
// 右边是选中那件事的详情（时间线、草稿就地改）；底部是常驻输入框，上面浮着这件事的选项卡（Claude 式编号选项，Choices.tsx），
// 办完自动跳到下一件等你的事。卡片关掉或没选中事时，输入框里说的话会派给助手当新任务
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { type State, type TaskView, createAgentTask, fetchDispatch, fetchStickers, pollNow } from "../lib/api";
import { AGENT_NAME, ago, money, pillOf, titleOf, waitingOn } from "../lib/format";
import { type Actions, type PickItem, type Target, Choices, actionsOf, draftOf, matchText, targetsOf, useRunner } from "./Choices";
import { Docked, Embedded } from "./Drawer";
import { NewTask } from "./NewTask";
import { TaskPanel } from "./TaskPanel";
import { toast } from "./Toast";

/** 等你处理里先放要你动手的：审批、发送、拍板、失败，最后是看结论 */
const NEED_ORDER: Record<string, number> = { approve: 0, send: 1, decide: 2, retry: 3, read: 4 };

export interface Nav {
	onOpen: (id: string) => void;
	onStory: (id: string) => void;
	onMemory: () => void;
	onCron: (scheduleId?: string) => void;
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

type Filter = "all" | "wait" | "run" | "queue" | "done";
const FILTERS: Array<[Filter, string]> = [
	["all", "全部"],
	["wait", "等你"],
	["run", "进行中"],
	["queue", "排队"],
	["done", "完成"],
];
/** 今天完成默认只露这几条，和 Claude 侧栏一样不让历史把正在办的事挤下去 */
const DONE_SHOWN = 5;

const isTyping = (el: Element | null) =>
	!!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || (el as HTMLElement).isContentEditable);

export function Workbench({
	s,
	nav,
	open,
	onSelect,
}: {
	s: State;
	nav: Nav;
	/** URL 里的 task：右边显示的那件事 */
	open?: string;
	/** 换一件看：只替换 URL，不压历史 */
	onSelect: (id?: string) => void;
}) {
	const { data: dispatch } = useQuery({ queryKey: ["dispatch"], queryFn: fetchDispatch, refetchInterval: 15_000 });
	const { data: stickers } = useQuery({ queryKey: ["stickers"], queryFn: fetchStickers });
	const today = new Date(s.now * 1000);
	const dayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() / 1000;
	const all = s.items;
	const run = all.filter((t) => t.status === "in_progress");
	const wait = all
		.filter(waitingOn)
		.toSorted((a, b) => (NEED_ORDER[a.need ?? ""] ?? 9) - (NEED_ORDER[b.need ?? ""] ?? 9) || b.updated - a.updated);
	const sections: Array<[Filter, string, TaskView[]]> = [
		["run", dispatch ? `正在运行 ${dispatch.queue.capacity - dispatch.queue.free} / ${dispatch.queue.capacity}` : "正在运行", run],
		["wait", "等你", wait],
		["queue", "排队", all.filter((t) => t.status === "todo").toSorted((a, b) => a.created - b.created)],
		[
			"done",
			"今天完成",
			all
				.filter((t) => (t.status === "done" || t.status === "cancelled") && (t.closed ?? t.updated) >= dayStart)
				.toSorted((a, b) => (b.closed ?? b.updated) - (a.closed ?? a.updated)),
		],
	];
	const [filter, setFilter] = useState<Filter>("all");
	const [moreDone, setMoreDone] = useState(false);
	const shown = sections.filter(([k]) => filter === "all" || filter === k);
	const flat = shown.flatMap(([k, , xs]) => (k === "done" && filter === "all" && !moreDone ? xs.slice(0, DONE_SHOWN) : xs));
	const cur = open ? all.find((t) => t.id === open) : undefined;
	// 打开工作台时没指定哪件：先看最急的那件等你的事
	const firstWait = wait[0]?.id;
	useEffect(() => {
		if (!open && firstWait) onSelect(firstWait);
		// 只在第一次进来时自动选；之后「＋ 新建」清空选中不能又被选回去
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);
	const [creating, setCreating] = useState(false);
	const inputRef = useRef<HTMLTextAreaElement | null>(null);
	const nextWaiting = () => wait.find((t) => t.id !== cur?.id)?.id;
	const next = () => onSelect(nextWaiting() ?? cur?.id);
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (isTyping(document.activeElement) || e.metaKey || e.ctrlKey || e.altKey) return;
			const i = flat.findIndex((t) => t.id === cur?.id);
			if (e.key === "j") onSelect(flat[Math.min(flat.length - 1, i + 1)]?.id);
			else if (e.key === "k") onSelect(flat[Math.max(0, i - 1)]?.id);
			else if (e.key === "/") {
				e.preventDefault();
				inputRef.current?.focus();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	});
	// 草稿框里改的字、每件事选的「发到哪」：只在这个页面里记着，发出去才算数
	const [edits, setEdits] = useState<Record<string, string>>({});
	const [targets, setTargets] = useState<Record<string, Target>>({});
	const docked = useMemo(
		() => ({ edit: (id: string) => edits[id], setEdit: (id: string, text: string) => setEdits((m) => ({ ...m, [id]: text })) }),
		[edits],
	);
	const picks: PickItem[] = [
		...(stickers?.emoji ?? []).map((k) => ({ key: k, kind: "reaction" as const })),
		...(stickers?.stickers ?? []).map((k) => ({ key: k, kind: "sticker" as const })),
	];
	const draft = cur ? draftOf(cur, s) : undefined;
	const actions = actionsOf(cur, {
		s,
		text: draft ? edits[draft.id] : undefined,
		to: (cur && targets[cur.id]) ?? (draft && targetsOf(draft)[0]?.key) ?? "reply",
		setTo: (to) => cur && setTargets((m) => ({ ...m, [cur.id]: to })),
		picks,
		onMemory: nav.onMemory,
	});
	const count = (k: Filter) => (k === "all" ? 0 : (sections.find(([x]) => x === k)?.[2].length ?? 0));
	return (
		<div className="-mx-7 -mt-[22px] -mb-[60px] grid h-screen grid-cols-[300px_minmax(0,1fr)] overflow-hidden">
			<aside className="flex min-h-0 flex-col border-r border-line bg-panel">
				<div className="flex items-center gap-2 px-3 pt-4 pb-1">
					<h1 className="m-0 text-[16px] font-semibold">工作台</h1>
					<span className="flex-1" />
					<button
						className="btn sm ghost"
						title="选助手、仓库、模型派一件事；也可以直接在下面的输入框说"
						onClick={() => {
							onSelect(undefined);
							setCreating(true);
							inputRef.current?.focus();
						}}
					>
						＋ 新建
					</button>
				</div>
				<div className="flex flex-wrap items-center gap-x-3 px-3 pb-2 text-[12px] text-muted">
					<span>今天花费 {money(s.stats.usage.cost)}</span>
					<button
						className="link text-[12px]"
						title={s.pollSince ? `${ago(s.now, s.pollSince)}收取过消息` : "还没开始收取消息"}
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
				<div className="chips px-3 pb-2" role="group" aria-label="按状态筛选">
					{FILTERS.map(([k, name]) => (
						<button key={k} className={`chip${filter === k ? " on" : ""}`} aria-pressed={filter === k} onClick={() => setFilter(k)}>
							{name}
							{count(k) > 0 && <b className="ml-1 tabular-nums">{count(k)}</b>}
						</button>
					))}
				</div>
				<div className="min-h-0 flex-1 overflow-auto px-2 pb-6">
					{shown.map(([k, title, xs]) => {
						const list = k === "done" && filter === "all" && !moreDone ? xs.slice(0, DONE_SHOWN) : xs;
						return (
							<section key={k} className="mb-3">
								<div className="px-2 pt-2 pb-1 text-[12px] font-semibold text-muted">
									{filter === "all" ? title : `${title}（${xs.length}）`}
								</div>
								{list.map((t) => (
									<Item key={t.id} t={t} on={t.id === cur?.id} onClick={() => onSelect(t.id)} />
								))}
								{!xs.length && <div className="px-2 text-[12px] text-muted">{k === "wait" ? "都处理完了" : "没有"}</div>}
								{list.length < xs.length && (
									<button className="link px-2 text-[12px]" onClick={() => setMoreDone(true)}>
										还有 {xs.length - list.length} 件
									</button>
								)}
							</section>
						);
					})}
				</div>
			</aside>
			<div className="flex min-h-0 flex-col bg-bg">
				<div className="min-h-0 flex-1 overflow-auto px-8 pt-6 pb-4">
					{s.issues.length > 0 && (
						<div className="issue">
							<b>自检发现 {s.issues.length} 个问题：</b>
							{s.issues.map((i) => i.title).join("；")}
						</div>
					)}
					{cur ? (
						<div className="dock mx-auto max-w-[860px]">
							<Embedded.Provider value>
								<Docked.Provider value={docked}>
									<TaskPanel
										key={cur.id}
										t={cur}
										s={s}
										onClose={() => onSelect(undefined)}
										onStory={nav.onStory}
										onCron={nav.onCron}
										onMemory={nav.onMemory}
									/>
								</Docked.Provider>
							</Embedded.Provider>
						</div>
					) : creating ? (
						<div className="mx-auto max-w-[760px]">
							<NewTask
								agents={s.agents}
								onCreated={() => {
									setCreating(false);
									toast("已交给助手，可以在「正在运行」看进度");
								}}
							/>
						</div>
					) : (
						<div className="mx-auto mt-[20vh] max-w-[760px] text-center">
							<div className="text-[20px] font-semibold">{open ? "这件事已经不在工作台里了" : "要助手做点什么？"}</div>
							<div className="mt-1 text-[14px] text-muted">
								在下面说一句，会新建一件事交给助手。要选开发助手、仓库或模型，点
								<button className="link" onClick={() => setCreating(true)}>
									详细设置
								</button>
								。
							</div>
						</div>
					)}
				</div>
				<Dock
					cur={cur}
					s={s}
					actions={actions}
					inputRef={inputRef}
					onAdvance={next}
					onNext={() => {
						const n = nextWaiting();
						if (n) onSelect(n);
					}}
				/>
			</div>
		</div>
	);
}

/** 左栏一行：状态标签 + 标题，在跑的下面一行写它正在做哪一步 */
function Item({ t, on, onClick }: { t: TaskView; on: boolean; onClick: () => void }) {
	const [label, cls] = pillOf(t);
	return (
		<button
			onClick={onClick}
			title={t.label || undefined}
			aria-current={on || undefined}
			className={`flex w-full flex-col gap-0.5 rounded-[6px] border-0 px-2 py-1.5 text-left ${on ? "bg-accent-soft" : "bg-transparent hover:bg-soft"}`}
		>
			<span className="flex w-full min-w-0 items-center gap-2">
				<span className={`pill shrink-0 ${cls}`}>{label}</span>
				<span className="truncate text-[14px] text-text">{titleOf(t)}</span>
			</span>
			{t.status === "in_progress" && t.live && <span className="livedot truncate pl-1 text-[12px]">{t.live}</span>}
		</button>
	);
}

/**
 * 底部输入区，照 Claude 桌面端：选中的事有要你选的，就在常驻输入框上方浮一张选项卡（可以关掉，先不选）；
 * 输入框一直在。这件事接受打字时（草稿、审批、agent 任务），输入框发出的话就是对它的回答；
 * 卡片关着或没选中事时，发出的话是派给助手的新活
 */
function Dock({
	cur,
	s,
	actions,
	inputRef,
	onAdvance,
	onNext,
}: {
	cur?: TaskView;
	s: State;
	actions: Actions;
	inputRef: React.MutableRefObject<HTMLTextAreaElement | null>;
	onAdvance: () => void;
	onNext: () => void;
}) {
	const { busy, exec } = useRunner();
	const [text, setText] = useState("");
	const [hint, setHint] = useState<string>();
	// 关掉的卡片：记的是哪件事的哪个状态，状态变了（比如出了新草稿）卡片会重新出来
	const [closed, setClosed] = useState<string>();
	const stamp = cur ? `${cur.id}:${cur.status}:${cur.need}:${cur.drafts.at(-1) ?? ""}:${cur.approvals.length}` : "";
	const open = !!cur && closed !== stamp;
	const card = open && actions.options.length > 0;
	const answering = open && (!!actions.typeIn || actions.slash.length > 0);
	const assistant = s.agents.find((a) => a.name === "assistant")?.name ?? s.agents[0]?.name ?? "assistant";
	const placeholder = answering
		? `${actions.typeIn?.hint.replace(/^或者/, "") ?? ""}${actions.slash.length ? "；/改写 让助手重写" : ""}`
		: `派一件事给${AGENT_NAME[assistant] ?? "助手"}`;
	const submit = async () => {
		const v = text.trim();
		if (!v || busy) return;
		if (answering) {
			const r = matchText(actions, v);
			if (!r.run) return setHint(r.hint);
			if (!(await exec(r.run))) return;
			setText("");
			if (r.advance) onAdvance();
			return;
		}
		if (await exec(() => createAgentTask({ agent: assistant, request: v }).then(() => "已交给助手，在「正在运行」看进度"))) setText("");
	};
	return (
		<div className="px-8 pb-6">
			<div className="mx-auto flex max-w-[860px] flex-col gap-2">
				{card && cur && (
					<div className="relative rounded-[10px] border border-line bg-panel px-2 py-2 shadow-[0_4px_20px_var(--shade)]">
						<button
							className="absolute -top-2.5 -right-2.5 flex h-6 w-6 items-center justify-center rounded-full border border-line bg-soft text-[12px] text-text-2 hover:bg-panel"
							aria-label="先不选，关掉"
							title="先不选，关掉"
							onClick={() => setClosed(stamp)}
						>
							✕
						</button>
						<div className="truncate px-2 pb-1 text-[12px] text-muted">{titleOf(cur)}</div>
						<Choices key={stamp} actions={actions} onAdvance={onAdvance} />
					</div>
				)}
				<div className="flex items-end gap-2 rounded-[10px] border border-line bg-panel px-3 py-2 focus-within:border-accent">
					<textarea
						ref={inputRef}
						rows={1}
						className="block max-h-40 min-h-[24px] flex-1 resize-none border-0 bg-transparent py-1 font-[inherit] text-[14px] text-text outline-none"
						placeholder={placeholder}
						value={text}
						disabled={busy}
						onChange={(e) => {
							setText(e.target.value);
							setHint(undefined);
						}}
						onKeyDown={(e) => {
							// 输入框里的按键不能再触发卡片上的 1 / 2 / 3、回车、Esc
							e.stopPropagation();
							if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
								e.preventDefault();
								void submit();
							}
							if (e.key === "Tab" && !text) {
								e.preventDefault();
								onNext();
							}
							if (e.key === "Escape") (e.target as HTMLTextAreaElement).blur();
						}}
					/>
					<button className="btn sm pri" disabled={busy || !text.trim()} onClick={() => void submit()} aria-label="发出">
						↑
					</button>
				</div>
				<div className="px-1 text-[12px] text-muted">
					{hint ??
						(answering
							? "回车发出就是回答这件事；Esc 回到选项，Tab 下一件"
							: card
								? "数字键选上面的选项；回车把这句话交给助手，Tab 下一件"
								: "回车交给助手，Tab 跳到下一件等你的事，j / k 上下切换")}
				</div>
			</div>
		</div>
	);
}
