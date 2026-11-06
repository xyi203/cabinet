import { useState } from "react";
import type { DevTask, State, Task } from "../lib/api";
import { AGENT_NAME, describeDraft, money } from "../lib/format";
import { NewTask } from "./NewTask";
import { Segmented, span } from "./ui";

/** 来源：和以前的看板筛选一样，草稿按会话类型分，问答和 agent 任务各一类 */
type Source = "all" | "p2p" | "group" | "meego" | "qa" | "dev";
const SOURCES: Array<{ value: Source; label: string; match: (t: Task) => boolean }> = [
	{ value: "all", label: "全部", match: () => true },
	{ value: "p2p", label: "私聊我的", match: (t) => t.type === "draft" && t.chatMode === "p2p" },
	{ value: "group", label: "群里 @我", match: (t) => t.type === "draft" && t.chatMode === "group" },
	{ value: "meego", label: "飞书项目", match: (t) => t.type === "draft" && t.chatMode === "meego" },
	{ value: "qa", label: "问答", match: (t) => t.type === "qa" },
	{ value: "dev", label: "agent 任务", match: (t) => t.type === "dev" },
];
const TYPE: Record<Task["type"], string> = { draft: "草稿", qa: "问答", dev: "任务" };

/** 按「需要谁动」分三段：已结束默认折叠 */
const SECTIONS: Array<{ key: string; name: string; hint: string; match: (t: Task) => boolean }> = [
	{ key: "doing", name: "进行中", hint: "排队起草、起草中、agent 在跑", match: (t) => t.status === "todo" || t.status === "in_progress" },
	{ key: "you", name: "等你处理", hint: "草稿待确认、任务待看、失败", match: (t) => t.status === "in_review" || t.status === "blocked" },
	{ key: "done", name: "已结束", hint: "最近 7 天", match: (t) => t.status === "done" || t.status === "cancelled" },
];
const FOLD = 15;

function Row({ t, state, onOpen }: { t: Task; state: State; onOpen: (t: Task) => void }) {
	const d = t.draft ? state.drafts.find((x) => x.id === t.draft) : undefined;
	const cost = (t.usage as { cost?: number } | null | undefined)?.cost;
	const label = t.type === "dev" && t.agent ? `${AGENT_NAME[t.agent] ?? t.agent} · ${t.label.replace(/^\w+ · /, "")}` : t.label;
	return (
		<button
			type="button"
			onClick={() => onOpen(t)}
			className="flex w-full cursor-pointer items-start gap-3 border-0 border-t border-line bg-transparent px-4 py-2.5 text-left first:border-t-0 hover:bg-soft"
		>
			<span className="mt-0.5 shrink-0 rounded bg-soft px-1.5 py-0.5 text-[11px] text-muted">{TYPE[t.type]}</span>
			<span className="min-w-0 flex-1">
				<span className="block truncate text-[13px] text-text">{t.title.replace(/\n/g, " ") || "（没有内容）"}</span>
				<span className="mt-0.5 block truncate text-[12px] text-muted">
					{label}
					{d?.draft ? ` · 草稿：${describeDraft(d)}` : ""}
					{t.error ? ` · ${t.error.slice(0, 80)}` : ""}
				</span>
			</span>
			<span
				className={`mt-0.5 shrink-0 text-[12px] ${t.status === "blocked" ? "text-bad" : t.status === "in_review" ? "text-accent" : "text-muted"}`}
			>
				{t.sub}
			</span>
			<span className="mt-0.5 w-32 shrink-0 text-right text-[12px] whitespace-nowrap text-muted tabular-nums">
				{span(state.now - (t.end ?? t.start ?? t.created))}前{cost ? ` · ${money(cost)}` : ""}
			</span>
		</button>
	);
}

/** 任务：草稿、问答、agent 任务合在一处，按来源筛、能搜，等你处理的排在前面 */
export function TasksPage({ state, onOpen, onOpenDev }: { state: State; onOpen: (t: Task) => void; onOpenDev: (id: string) => void }) {
	const [source, setSource] = useState<Source>("all");
	const [q, setQ] = useState("");
	const [creating, setCreating] = useState(false);
	const [showDone, setShowDone] = useState(false);
	const [more, setMore] = useState(false);
	const drafts = new Map(state.drafts.map((d) => [d.id, d]));
	const kw = q.trim().toLowerCase();
	const match = SOURCES.find((s) => s.value === source)!.match;
	const list = state.tasks.filter(
		(t) =>
			match(t) &&
			(!kw ||
				[t.title, t.label, t.sub, t.agent ?? "", t.draft ? (drafts.get(t.draft)?.draft ?? "") : ""].some((x) =>
					x.toLowerCase().includes(kw),
				)),
	);
	const counts = new Map(SOURCES.map((s) => [s.value, state.tasks.filter(s.match).length]));
	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-wrap items-center gap-3">
				<Segmented
					value={source}
					options={SOURCES.map((s) => ({ value: s.value, label: `${s.label} ${counts.get(s.value) ?? 0}` }))}
					onChange={setSource}
				/>
				<input
					value={q}
					onChange={(e) => setQ(e.target.value)}
					placeholder="搜标题、来源、草稿内容"
					className="w-56 rounded-lg border border-line bg-panel px-3 py-1.5 text-[13px] text-text"
				/>
				<button
					type="button"
					onClick={() => setCreating(!creating)}
					className={`ml-auto cursor-pointer rounded-lg border px-3 py-1.5 text-[13px] ${
						creating ? "border-accent bg-accent-soft text-accent" : "border-accent bg-accent text-white"
					}`}
				>
					{creating ? "收起" : "＋ 新建任务"}
				</button>
			</div>
			{creating && (
				<NewTask
					agents={state.agents}
					onCreated={(t: DevTask) => {
						setCreating(false);
						onOpenDev(t.id);
					}}
				/>
			)}
			{SECTIONS.map((sec) => {
				const rows = list.filter(sec.match);
				const folded = sec.key === "done" && !showDone && !kw;
				const shown = sec.key === "done" && !more && !kw ? rows.slice(0, FOLD) : rows;
				return (
					<section key={sec.key} className="rounded-xl border border-line bg-panel">
						<button
							type="button"
							disabled={sec.key !== "done"}
							onClick={() => setShowDone(!showDone)}
							className={`flex w-full items-center gap-2 border-0 bg-transparent px-4 py-2.5 text-left ${sec.key === "done" ? "cursor-pointer" : "cursor-default"}`}
						>
							{sec.key === "done" && <span className="text-[11px] text-muted">{folded ? "▸" : "▾"}</span>}
							<span className="text-[14px] font-semibold text-text">{sec.name}</span>
							<span className="text-[12px] text-muted tabular-nums">{rows.length}</span>
							<span className="text-[12px] text-muted">{sec.hint}</span>
						</button>
						{!folded && (
							<div className="border-t border-line">
								{shown.map((t) => (
									<Row key={t.id} t={t} state={state} onOpen={onOpen} />
								))}
								{!rows.length && <div className="px-4 py-4 text-[13px] text-muted">{kw ? "没有搜到" : "没有"}</div>}
								{rows.length > shown.length && (
									<button
										type="button"
										onClick={() => setMore(true)}
										className="w-full cursor-pointer border-0 border-t border-line bg-transparent py-2 text-[12px] text-accent hover:bg-soft"
									>
										再显示 {rows.length - shown.length} 条
									</button>
								)}
							</div>
						)}
					</section>
				);
			})}
		</div>
	);
}
