// 任务详情：一件事的来龙去脉排成一条时间线（docs/router-worker.md §5.2）——进来的消息、路由判定、每版草稿、审批、agent 任务、结果。
// 当前那份产出（待确认的草稿、agent 任务）嵌在时间线末尾，直接复用原来的草稿抽屉和任务抽屉：改稿、发送、对话、看改动、推送都在那里
import type { ReactNode } from "react";
import type { Draft, State, Task, TaskEvent, TaskView } from "../lib/api";
import { AGENT_NAME, SOURCE, STATUS, describeDraft, hm, isLive, time, titleOf } from "../lib/format";
import { ApprovalActions, RowActions, useAct } from "./Actions";
import { DevDrawer } from "./DevDrawer";
import { Conclusion } from "./AgentUi";
import { Drawer, Embedded } from "./Drawer";
import { DraftDrawer } from "./Drawers";
import { MsgText } from "./MsgText";
import { Pill, StoryTag, workerName } from "./Workbench";

const OUTCOME: Record<string, string> = {
	sent: "已以你的身份发送",
	discarded: "不回复",
	completed: "已完成",
	expired: "你已亲自回复",
	replied: "机器人已回复",
	remembered: "已记住",
	pushed: "已推送并创建 MR",
	merged: "已并入新草稿",
	dismissed: "已忽略",
	done: "已完成",
	failed: "失败",
};

type Item = { at: number; key: string; node: ReactNode };

/**
 * 分派依据是后端给自己看的（「兜底」「分诊 deep：…」「ack 档…升到 answer」），
 * 时间线上换成一句人话；档位名（ack / answer / deep / mr）不出现
 */
export function ruleText(rule: string) {
	const r = rule.trim();
	if (!r || r === "兜底" || r === "唯一的 agent") return "";
	const fixed: Record<string, string> = {
		"MR 链接": "消息里有 MR 链接，先做代码评审",
		"@机器人问答": "有人 @机器人 提问",
		"回复 agent 任务": "你在追问助手的任务",
		记住: "你让它记住一件事",
		看板派活: "你在看板上派的",
	};
	if (fixed[r]) return fixed[r];
	let m = r.match(/^分诊 \w+：(.*)$/s);
	if (m) return m[1].trim();
	m = r.match(/^告警(续)?批（(\d+) 条）$/);
	if (m) return m[1] ? `又来了 ${m[2]} 条告警，并进上一批一起分析` : `攒了 ${m[2]} 条告警一起分析`;
	m = r.match(/^定时任务：(.*)$/);
	if (m) return `定时任务「${m[1]}」到点了`;
	m = r.match(/^草稿指令：(.*)$/);
	if (m) return `你在卡片上回复「${m[1]}」`;
	return r
		.replace(/（[^）]*(档|升到)[^）]*）/g, "")
		.replace(/；接续 \S+/, "")
		.trim();
}

function Ev({ at, children }: { at: number; children: ReactNode }) {
	return (
		<div className="ev">
			<div className="tm num">{hm(at)}</div>
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
				<div className={`bubble${e.owner ? " yi" : ""}`}>
					<MsgText text={e.text} mid={e.mid} />
				</div>
			</>
		);
	if (e.k === "route")
		return (
			<div className="sys">
				{e.kind === "command" ? (
					`你的操作：${e.rule}`
				) : (
					<>
						{ruleText(e.rule) && `${ruleText(e.rule)}，`}
						{e.agent ? `交给${AGENT_NAME[e.agent] ?? e.agent}` : "已分派"}
					</>
				)}
			</div>
		);
	return (
		<div className="sys dim">
			{OUTCOME[e.outcome] ?? e.outcome}
			{e.detail ? `：${e.detail}` : ""}
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
	backLabel = "返回需求",
}: {
	t: TaskView;
	s: State;
	onClose: () => void;
	onStory: (id: string) => void;
	onCron: (scheduleId?: string) => void;
	onMemory: () => void;
	onBack?: () => void;
	backLabel?: string;
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
						<span>草稿</span>
						<span>{STATUS[d.status] ?? d.status}</span>
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
							<span>{d.title}</span>
							<span>{AGENT_NAME[d.agent] ?? d.agent}</span>
						</div>
						<div className="ob">
							{d.summary ? <Conclusion text={d.summary} ui={d.ui} devId={d.id} /> : <div className="quote">{d.error || d.request}</div>}
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
						<span>需要你批准</span>
						<span>24 小时内有效</span>
					</div>
					<div className="ob">
						<pre className="cmd">{a.command}</pre>
						<div className="kv">
							<span>为什么</span>
							<div>{a.reason}</div>
						</div>
						<div className="kv">
							<span>谁要做</span>
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
		<Drawer title={titleOf(t)} onClose={onClose} onBack={onBack} backLabel={backLabel}>
			<div className="taskhead">
				<Pill t={t} />
				<div className="props">
					<span>
						来源{" "}
						<b>
							{t.label && !t.label.includes(SOURCE[t.source] ?? t.source)
								? `${SOURCE[t.source] ?? t.source}：${t.label}`
								: t.label || (SOURCE[t.source] ?? t.source)}
						</b>
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
							<button className="link" onClick={() => onCron(t.scheduleId ?? undefined)}>
								查看定时任务
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
								<span>需要你决定</span>
							</div>
							<div className="ob">
								<div>{t.title}</div>
								<div className="oa">
									<button className="btn pri sm" onClick={onMemory}>
										去记忆页处理
									</button>
								</div>
							</div>
						</div>
					</Ev>
				)}
				{!!t.followups?.length && <Followups t={t} />}
				{t.need === "retry" && !liveDev && (
					<Ev at={t.updated}>
						<div className="out need">
							<div className="oh">
								<span>失败</span>
							</div>
							<div className="ob">
								<div className="err">{t.error || "这次处理失败了"}</div>
								<RowActions t={t} s={s} onOpen={() => {}} onMemory={onMemory} />
							</div>
						</div>
					</Ev>
				)}
				{(t.id.startsWith("q:") || ((t.status === "todo" || t.status === "in_progress") && !liveDraft && !liveDev)) && (
					<RowActions t={t} s={s} onOpen={() => {}} onMemory={onMemory} />
				)}
			</div>
			<Embedded.Provider value>
				{liveDraft && <DraftDrawer key={liveDraft.id} draft={liveDraft} task={logOf(liveDraft, t)} onClose={() => {}} />}
				{liveDev && <DevDrawer key={liveDev.id} dev={liveDev} onClose={() => {}} />}
			</Embedded.Provider>
		</Drawer>
	);
}

/** agent 约好、还没到期的复查：到点它会在原会话里接着做；不需要了可以取消 */
function Followups({ t }: { t: TaskView }) {
	const { busy, act } = useAct();
	return (
		<div className="out">
			<div className="oh">
				<span>约好的复查</span>
			</div>
			<div className="ob">
				{t.followups!.map((f) => (
					<div key={f.key} className="row-inline">
						<span className="num">{time(f.at)}</span>
						<span className="flex-1">{f.about}</span>
						<button
							className="btn ghost sm"
							disabled={busy}
							onClick={() => act(`/api/tasks/${t.id}/followups/${encodeURIComponent(f.key)}/cancel`, {}, "已取消这次复查")}
						>
							取消
						</button>
					</div>
				))}
			</div>
		</div>
	);
}
