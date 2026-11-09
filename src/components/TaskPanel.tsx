// 任务详情：一件事的来龙去脉排成一条时间线（docs/router-worker.md §5.2）——进来的消息、路由判定、每版草稿、审批、agent 任务、结果。
// 当前那份产出（待确认的草稿、agent 任务）嵌在时间线末尾，直接复用原来的草稿抽屉和任务抽屉：改稿、发送、对话、看改动、推送都在那里
import type { ReactNode } from "react";
import type { Draft, State, Task, TaskEvent, TaskView } from "../lib/api";
import { AGENT_NAME, SOURCE, STATUS, describeDraft, isLive } from "../lib/format";
import { ApprovalActions, RowActions } from "./Actions";
import { DevDrawer } from "./DevDrawer";
import { Drawer, Embedded } from "./Drawer";
import { DraftDrawer } from "./Drawers";
import { Pill, StoryTag, workerName } from "./Workbench";

const hm = (ts: number) => new Date(ts * 1000).toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" });
const OUTCOME: Record<string, string> = {
	sent: "已以你的身份发出",
	discarded: "不发",
	completed: "标记完成",
	expired: "你已亲自回复",
	replied: "机器人已回复",
	remembered: "已记住",
	pushed: "已推送建 MR",
	done: "已完成",
	failed: "失败",
};

type Item = { at: number; key: string; node: ReactNode };

function Ev({ at, children }: { at: number; children: ReactNode }) {
	return (
		<div className="ev">
			<div className="tm">{hm(at)}</div>
			<div>{children}</div>
		</div>
	);
}

function eventNode(e: TaskEvent): ReactNode {
	if (e.k === "msg")
		return (
			<>
				<div className="who">
					<b>{e.owner ? "你" : e.who || "对方"}</b>
				</div>
				<div className={`bubble${e.owner ? " yi" : ""}`}>{e.text}</div>
			</>
		);
	if (e.k === "route")
		return (
			<div className="sys">
				{e.kind === "command" ? "操作" : "路由"}：{e.rule}
				{e.agent && e.kind !== "command" && (
					<em>
						{" "}
						· 交给 {AGENT_NAME[e.agent] ?? e.agent}
						{e.tier ? ` · ${e.tier}` : ""}
					</em>
				)}
			</div>
		);
	return (
		<div className="sys">
			<em>
				{OUTCOME[e.outcome] ?? e.outcome}
				{e.detail ? `：${e.detail}` : ""}
			</em>
		</div>
	);
}

/** 草稿起草那次运行的步骤：DraftDrawer 按这个拉执行日志 */
function logOf(d: Draft, t: TaskView): Task {
	const route = t.events.filter((e) => e.k === "route" && e.at <= d.created).at(-1);
	return {
		id: d.id,
		type: "draft",
		status: d.status,
		sub: "",
		title: d.text,
		label: "",
		created: d.created,
		session: d.session,
		start: route?.at,
		end: d.created,
	};
}

export function TaskPanel({
	t,
	s,
	onClose,
	onStory,
	onCron,
	onMemory,
	onBack,
}: {
	t: TaskView;
	s: State;
	onClose: () => void;
	onStory: (id: string) => void;
	onCron: () => void;
	onMemory: () => void;
	onBack?: () => void;
}) {
	const drafts = t.drafts.map((id) => s.drafts.find((d) => d.id === id)).filter((d): d is Draft => d != null);
	const devs = t.devTasks.map((id) => s.devTasks.find((d) => d.id === id)).filter((d) => d != null);
	const lastDraft = drafts.at(-1);
	const lastDev = devs.at(-1);
	// 嵌在末尾的那份：最近一次产出是 agent 任务就是它，否则是最新一版草稿
	const liveDev = lastDev && (!lastDraft || lastDev.created >= lastDraft.created) ? lastDev : undefined;
	const liveDraft = !liveDev && lastDraft && (isLive(lastDraft) || lastDraft.status === "revising") ? lastDraft : undefined;
	// 派活的原文就是 agent 任务的「任务」，下面嵌着的任务里已经有了，时间线上不再重复
	const items: Item[] = t.events
		.map((e, i) => ({ e, i }))
		.filter(({ e }) => !(e.k === "msg" && devs.some((d) => d.request === e.text)))
		.map(({ e, i }) => ({ at: e.at, key: `e${i}`, node: eventNode(e) }));
	for (const d of drafts) {
		if (d === liveDraft) continue;
		items.push({
			at: d.created,
			key: d.id,
			node: (
				<div className="out">
					<div className="oh">
						<span>草稿 · {STATUS[d.status] ?? d.status}</span>
					</div>
					<div className="ob">
						<div className="quote">{describeDraft(d)}</div>
						{d.note && <div className="meta">{d.note}</div>}
					</div>
				</div>
			),
		});
	}
	for (const d of devs)
		if (d !== liveDev)
			items.push({
				at: d.created,
				key: d.id,
				node: (
					<div className="out">
						<div className="oh">
							<span>
								{AGENT_NAME[d.agent] ?? d.agent} 任务 · {d.title}
							</span>
						</div>
						<div className="ob">
							<div className="quote">{d.summary || d.error || d.request}</div>
						</div>
					</div>
				),
			});
	for (const a of s.approvals.filter((x) => t.approvals.includes(x.id)))
		items.push({
			at: a.created,
			key: a.id,
			node: (
				<div className="out need">
					<div className="oh">
						<span>写操作审批</span>
						<span>24 小时内有效</span>
					</div>
					<div className="ob">
						<pre className="cmd">{a.command}</pre>
						<div className="kv">
							<span>说明</span>
							<div>{a.reason}</div>
						</div>
						<div className="kv">
							<span>来源</span>
							<div>{a.origin}</div>
						</div>
						<ApprovalActions a={a} />
					</div>
				</div>
			),
		});
	items.sort((a, b) => a.at - b.at);
	const story = t.storyId ? s.stories.find((x) => x.id === t.storyId) : undefined;
	return (
		<Drawer title={t.title || "（无内容）"} onClose={onClose} onBack={onBack} backLabel="返回需求">
			<div className="taskhead">
				<Pill t={t} />
				<div className="props">
					<span>
						来源 <b>{SOURCE[t.source] ?? t.source}</b>
						{t.label ? <b> · {t.label}</b> : null}
					</span>
					{workerName(t) && (
						<span>
							交给 <b>{workerName(t)}</b>
						</span>
					)}
					{story && (
						<span>
							需求 <StoryTag id={story.id} s={s} onStory={onStory} />
						</span>
					)}
					{t.scheduleId && (
						<span>
							定时{" "}
							<button className="link" onClick={onCron}>
								看定时任务
							</button>
						</span>
					)}
					{t.live && <span className="livedot">{t.live}</span>}
				</div>
			</div>
			<div className="tl">
				{items.map((it) => (
					<Ev key={it.key} at={it.at}>
						{it.node}
					</Ev>
				))}
				{t.memories && (
					<Ev at={t.updated}>
						<div className="out need">
							<div className="oh">
								<span>要你拍板</span>
							</div>
							<div className="ob">
								<div>{t.title}</div>
								<div className="oa">
									<button className="btn pri sm" onClick={onMemory}>
										去记忆页裁定
									</button>
								</div>
							</div>
						</div>
					</Ev>
				)}
				{t.need === "retry" && !liveDev && (
					<Ev at={t.updated}>
						<div className="out need">
							<div className="oh">
								<span>失败</span>
							</div>
							<div className="ob">
								<div>{t.error || "这次处理失败了"}</div>
								<RowActions t={t} s={s} onOpen={() => {}} onMemory={onMemory} />
							</div>
						</div>
					</Ev>
				)}
				{t.id.startsWith("q:") && <RowActions t={t} s={s} onOpen={() => {}} onMemory={onMemory} />}
			</div>
			<Embedded.Provider value>
				{liveDraft && <DraftDrawer key={liveDraft.id} draft={liveDraft} task={logOf(liveDraft, t)} onClose={() => {}} />}
				{liveDev && <DevDrawer key={liveDev.id} dev={liveDev} onClose={() => {}} />}
			</Embedded.Provider>
		</Drawer>
	);
}
