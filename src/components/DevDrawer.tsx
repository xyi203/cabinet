import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
	type DevTask,
	type Draft,
	type State,
	type Task,
	type TranscriptItem,
	fetchDevDiff,
	fetchDevTranscript,
	fetchRepos,
	post,
} from "../lib/api";
import { useLiveSteps } from "../lib/live";
import { AGENT_NAME, money, time } from "../lib/format";
import { Drawer, type Msg, MsgLine } from "./Drawer";
import { ModelPicker } from "./ModelPicker";

const STATUS: Record<string, string> = {
	running: "运行中",
	pushing: "推送中",
	review: "待你看",
	failed: "失败",
	pushed: "已提 MR",
	discarded: "已放弃",
	done: "已完成",
};

/** 草稿抽屉里的「指派 agent 实现」：选仓库、起分支名、补充说明 */
export function DispatchForm({ draft, onDone }: { draft: Draft; onDone: () => void }) {
	const qc = useQueryClient();
	const state = qc.getQueryData<State>(["state"]);
	const devConf = state?.agents.find((a) => a.name === "dev");
	const [pick, setPick] = useState<{ model: string; thinking: string } | null>(null);
	const model = pick?.model ?? devConf?.model ?? "";
	const thinking = pick?.thinking ?? devConf?.thinking ?? "high";
	const { data: repos } = useQuery({ queryKey: ["repos"], queryFn: fetchRepos });
	const [repo, setRepo] = useState("");
	const [branch, setBranch] = useState("feature/");
	const [instructions, setInstructions] = useState("");
	const [busy, setBusy] = useState(false);
	const [msg, setMsg] = useState<Msg>(null);
	async function submit() {
		setBusy(true);
		try {
			await post(`/api/drafts/${draft.id}/dispatch`, { repo: repo || repos?.[0], branch, instructions, model, thinking });
			setMsg({ text: "已指派，开发任务会出现在「工作中」；改完后在任务里审核 diff、推送建 MR" });
			qc.invalidateQueries({ queryKey: ["state"] });
			setTimeout(onDone, 1500);
		} catch (e) {
			setMsg({ text: (e as Error).message, bad: true });
			setBusy(false);
		}
	}
	return (
		<div className="panel dispatch">
			<div className="label">仓库（{"~/code"} 下，按最近修改排序）</div>
			<select value={repo || repos?.[0] || ""} onChange={(e) => setRepo(e.target.value)}>
				{repos?.map((r) => (
					<option key={r} value={r}>
						{r}
					</option>
				))}
			</select>
			<div className="label">分支（feature/ 或 fix/ 加一个单词，基于远端默认分支新建）</div>
			<input value={branch} onChange={(e) => setBranch(e.target.value.trim())} placeholder="feature/commentfilter" />
			<div className="label">模型与 effort</div>
			<div className="row-inline">
				<ModelPicker model={model} thinking={thinking} onChange={(m, t) => setPick({ model: m, thinking: t })} />
			</div>
			<div className="label">补充说明（可选，以这个为准）</div>
			<textarea
				value={instructions}
				onChange={(e) => setInstructions(e.target.value)}
				placeholder="例如：参照 v1/comment/list 的筛选参数，只改 admin 接口，不动 pb"
				style={{ minHeight: 80 }}
			/>
			<div className="actions-inline">
				<button className="btn primary" disabled={busy || !repos?.length} onClick={submit}>
					开始实现
				</button>
			</div>
			<MsgLine msg={msg} />
		</div>
	);
}

function ToolLine({ item }: { item: TranscriptItem }) {
	const [open, setOpen] = useState(false);
	const a = item.args ?? {};
	const brief = a.command ?? ([a.path, a.pattern].filter(Boolean).join("  ") || JSON.stringify(a));
	return (
		<div className={`chat-tool${item.error ? " err" : ""}${item.done ? "" : " live"}`} onClick={() => setOpen(!open)}>
			<span className="caret">{open ? "▾" : "▸"}</span>
			<b>{item.tool}</b> <code>{String(brief).slice(0, 160)}</code>
			<span className="foot">
				{" "}
				{item.done ? `${(item.done - item.t).toFixed(1)}s` : "进行中"}
				{item.error ? " · 被拦截/出错" : ""}
			</span>
			{open && item.result && <pre>{item.result}</pre>}
		</div>
	);
}

function UserBubble({ text, first }: { text: string; first: boolean }) {
	const [open, setOpen] = useState(!first);
	// 第一条是 cabinet 拼的任务说明，很长：默认折叠
	if (!open)
		return (
			<div className="chat-user collapsed" onClick={() => setOpen(true)}>
				任务说明（点击展开）
			</div>
		);
	return <div className="chat-user">{text.replace(/^Yi：/, "").replace(/\n\n（这是 Yi 的消息：[\s\S]*$/, "")}</div>;
}

/** 开发任务的对话：你说的话、agent 的回复、每一步工具调用；运行中实时追加 */
function Chat({ dev }: { dev: DevTask }) {
	const live = useLiveSteps(dev.status === "running" ? `dev-${dev.id}` : undefined);
	const { data: items } = useQuery({
		queryKey: ["devtranscript", dev.id, dev.updated, live?.length ?? 0, live?.filter((s) => s.done).length ?? 0],
		queryFn: () => fetchDevTranscript(dev.id),
		placeholderData: (prev) => prev,
	});
	const end = useRef<HTMLDivElement>(null);
	const count = items?.length ?? 0;
	// 有新内容时滚到底部
	useEffect(() => {
		if (count) end.current?.scrollIntoView({ block: "end" });
	}, [count]);
	if (!items?.length) return <div className="foot">{dev.status === "running" ? "已开始，等待第一步…" : "还没有对话记录"}</div>;
	const firstUser = items.findIndex((it) => it.kind === "user");
	return (
		<div className="chat">
			{items.map((it, i) =>
				it.kind === "user" ? (
					<UserBubble key={i} text={it.text ?? ""} first={i === firstUser} />
				) : it.kind === "assistant" ? (
					<div key={i} className="chat-agent">
						{it.text}
					</div>
				) : (
					<ToolLine key={i} item={it} />
				),
			)}
			{dev.status === "running" && <div className="foot">● agent 正在工作…</div>}
			<div ref={end} />
		</div>
	);
}

export function DevDrawer({ dev: d, onClose }: { dev: DevTask; task?: Task; onClose: () => void }) {
	const qc = useQueryClient();
	const running = d.status === "running";
	const isDev = d.agent === "dev";
	const ended = d.status === "discarded" || d.status === "done";
	const { data: diff } = useQuery({
		queryKey: ["devdiff", d.id, d.updated],
		queryFn: () => fetchDevDiff(d.id),
		enabled: isDev && !ended && !running,
	});
	const [text, setText] = useState("");
	const [showDiff, setShowDiff] = useState(false);
	const [busy, setBusy] = useState(false);
	const [msg, setMsg] = useState<Msg>(null);
	async function act(action: "message" | "stop" | "push" | "discard" | "close") {
		if (action === "push" && !confirm(`推送 ${d.branch}${d.mrUrl ? "（MR 已存在，只推新提交）" : ` 并建 MR 到 ${d.base}`}？`)) return;
		if (action === "discard" && !confirm(`放弃这个开发任务？会删除 worktree 和本地分支 ${d.branch}`)) return;
		if (action === "message" && !text.trim()) return;
		setBusy(true);
		try {
			const r = await post(`/api/dev/${d.id}/${action}`, { text });
			setMsg(
				action === "push"
					? { text: `已推送：${r.url || "MR 已更新"}` }
					: action === "message"
						? { text: r.mode === "steered" ? "已插入当前运行，下一个工具步骤后生效" : "已发送，agent 开始新一轮" }
						: action === "stop"
							? { text: "已停止" }
							: action === "close"
								? { text: "已归档" }
								: { text: "已放弃" },
			);
			if (action === "message") setText("");
			qc.invalidateQueries({ queryKey: ["state"] });
			if (action === "discard" || action === "close") setTimeout(onClose, 800);
		} catch (e) {
			setMsg({ text: (e as Error).message, bad: true });
		} finally {
			setBusy(false);
		}
	}
	const canPush = (d.status === "review" || d.status === "pushed") && Boolean(diff?.commits);
	return (
		<Drawer
			title={
				isDev
					? `开发 · ${d.repo.split("/").pop()} · ${d.branch}`
					: `${AGENT_NAME[d.agent] ?? d.agent} · ${d.repo ? d.repo.split("/").pop() : "~/code"}`
			}
			onClose={onClose}
			actions={
				ended ? undefined : (
					<div className="chat-input">
						<textarea
							value={text}
							disabled={d.status === "pushing"}
							placeholder={
								running
									? "插话：会在 agent 下一个工具步骤后生效，例如「先别动 pb」（⌘↩ 发送）"
									: "给 agent 发消息：提问、补充要求、让它继续改（⌘↩ 发送）"
							}
							onChange={(e) => setText(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void act("message");
							}}
						/>
						<div className="row">
							<button className="btn primary" disabled={busy || !text.trim()} onClick={() => act("message")}>
								{running ? "插话" : "发送"}
							</button>
							{running && (
								<button className="btn" disabled={busy} onClick={() => act("stop")}>
									停止
								</button>
							)}
							{canPush && (
								<button className="btn" disabled={busy} onClick={() => act("push")}>
									{d.mrUrl ? "推送新提交" : "推送并建 MR"}
								</button>
							)}
							{!running && !isDev && (
								<button className="btn" disabled={busy} title="看完了，归档" onClick={() => act("close")}>
									完成
								</button>
							)}
							{!running && isDev && (
								<button className="btn danger" disabled={busy} onClick={() => act("discard")}>
									放弃
								</button>
							)}
						</div>
						<MsgLine msg={msg} />
					</div>
				)
			}
		>
			<div className="meta">
				<span className={`pill ${d.status === "failed" ? "failed" : d.status === "pushed" ? "sent" : "pending"}`}>
					{STATUS[d.status] ?? d.status}
				</span>
				<span>{time(d.created)}</span>
				{isDev && <span>基于 origin/{d.base}</span>}
				{d.model && <span>{`${d.model.split("/").pop()} · effort ${d.thinking ?? "默认"}`}</span>}
				{d.runs > 0 && <span>{`第 ${d.runs} 轮 · ${money(d.usage?.cost)}`}</span>}
				{d.mrUrl && (
					<a href={d.mrUrl} target="_blank" rel="noreferrer">
						打开 MR
					</a>
				)}
			</div>
			<div className="label">{isDev ? "需求" : "任务"}</div>
			<blockquote>{d.request}</blockquote>
			{d.error && <div className="err">{d.error}</div>}
			{diff && (
				<>
					<div className="label">
						改动：{diff.commits ? `${diff.commits.split("\n").length} 个提交` : "还没有提交"}
						<button className="linkbtn" onClick={() => setShowDiff(!showDiff)}>
							{showDiff ? "收起" : "展开 diff"}
						</button>
					</div>
					{diff.uncommitted && <div className="err">还有未提交的改动：{diff.uncommitted}</div>}
					{showDiff && (
						<>
							<pre className="diff">{diff.commits}</pre>
							<pre className="diff">{diff.diff || "（无改动）"}</pre>
						</>
					)}
				</>
			)}
			<div className="label">对话</div>
			<Chat dev={d} />
		</Drawer>
	);
}
