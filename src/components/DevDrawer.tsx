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
import { EFFORT } from "./ModelPicker";
import { dur } from "./ui";
import { Drawer, type Msg, MsgLine } from "./Drawer";
import { Conclusion } from "./AgentUi";
import { Markdown } from "./Markdown";
import { ModelPicker } from "./ModelPicker";
import { confirmDialog } from "./Confirm";

const STATUS: Record<string, string> = {
	running: "进行中",
	pushing: "推送中",
	review: "待查看",
	failed: "失败",
	pushed: "已创建 MR",
	discarded: "已放弃",
	done: "已完成",
};

/**
 * 草稿抽屉里的「转成任务」：查询交给助手，在仓库目录里只读地查，不建分支；
 * 要改代码才交给 dev，在独立 worktree 的新分支上实现
 */
export function DispatchForm({ draft, onDone }: { draft: Draft; onDone: () => void }) {
	const qc = useQueryClient();
	const state = qc.getQueryData<State>(["state"]);
	const [agent, setAgent] = useState<"assistant" | "dev">("assistant");
	const dev = agent === "dev";
	const conf = state?.agents.find((a) => a.name === agent);
	// 换 agent 时模型跟着换，除非已经手动改过
	const [pick, setPick] = useState<{ agent: string; model: string; thinking: string } | null>(null);
	const model = pick?.agent === agent ? pick.model : (conf?.model ?? "");
	const thinking = pick?.agent === agent ? pick.thinking : (conf?.thinking ?? "high");
	const { data: repos } = useQuery({ queryKey: ["repos"], queryFn: fetchRepos });
	const [repo, setRepo] = useState("");
	const [branch, setBranch] = useState("");
	const [instructions, setInstructions] = useState("");
	const [busy, setBusy] = useState(false);
	const [msg, setMsg] = useState<Msg>(null);
	async function submit() {
		setBusy(true);
		try {
			await post(`/api/drafts/${draft.id}/dispatch`, {
				agent,
				repo: repo || (dev ? repos?.[0] : ""),
				branch: dev ? branch : "",
				instructions,
				model,
				thinking,
			});
			setMsg({
				text: dev
					? "已交给开发助手，可以在「进行中」看进度；改完后在任务里查看改动、推送并创建 MR"
					: "已交给助手，查完会出现在「等你处理」",
			});
			qc.invalidateQueries({ queryKey: ["state"] });
			setTimeout(onDone, 1500);
		} catch (e) {
			setMsg({ text: (e as Error).message, bad: true });
			setBusy(false);
		}
	}
	return (
		<div className="panel dispatch">
			<div className="label">要做什么</div>
			<select value={agent} onChange={(e) => setAgent(e.target.value as "assistant" | "dev")}>
				<option value="assistant">查一查（只看不改）</option>
				<option value="dev">改代码（在新分支上改，你确认后再推送）</option>
			</select>
			<div className="label">仓库</div>
			<select value={repo || (dev ? repos?.[0] : "") || ""} onChange={(e) => setRepo(e.target.value)}>
				{!dev && <option value="">不指定仓库</option>}
				{repos?.map((r) => (
					<option key={r} value={r}>
						{r}
					</option>
				))}
			</select>
			{dev && (
				<>
					<div className="label">分支</div>
					<input
						value={branch}
						onChange={(e) => setBranch(e.target.value.trim())}
						placeholder="留空会自动起名，例如 feature/commentfilter"
					/>
				</>
			)}
			<div className="label">模型</div>
			<div className="row-inline">
				<ModelPicker model={model} thinking={thinking} onChange={(m, t) => setPick({ agent, model: m, thinking: t })} />
			</div>
			<div className="label">补充说明（选填）</div>
			<textarea
				value={instructions}
				onChange={(e) => setInstructions(e.target.value)}
				placeholder="例如：参照 v1/comment/list 的筛选参数，只改 admin 接口，不动 pb"
				style={{ minHeight: 80 }}
			/>
			<div className="actions-inline">
				<button className="btn primary" disabled={busy || (dev && !repos?.length)} onClick={submit}>
					{dev ? "交给开发助手" : "交给助手"}
				</button>
			</div>
			<MsgLine msg={msg} />
		</div>
	);
}

/** 图片缩略图，点开看大图。截图过期被清理后取不到的直接不显示 */
function Thumbs({ images }: { images?: string[] }) {
	const [big, setBig] = useState<string | null>(null);
	const [broken, setBroken] = useState<string[]>([]);
	const shown = (images ?? []).filter((src) => !broken.includes(src));
	if (!shown.length) return null;
	return (
		<div className="chat-images" onClick={(e) => e.stopPropagation()}>
			{shown.map((src) => (
				<img key={src} src={src} alt="" loading="lazy" onClick={() => setBig(src)} onError={() => setBroken((b) => [...b, src])} />
			))}
			{big && (
				<div className="lightbox" onClick={() => setBig(null)}>
					<img src={big} alt="" />
				</div>
			)}
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
			<span className="foot num">
				{" "}
				{item.done ? dur(item.done - item.t) : "进行中"}
				{item.error ? "，被拦下或出错" : ""}
			</span>
			{open && item.result && <pre>{item.result}</pre>}
			<Thumbs images={item.images} />
		</div>
	);
}

function UserBubble({ text, first, images, shown }: { text: string; first: boolean; images?: string[]; shown?: string }) {
	const [open, setOpen] = useState(!first);
	// 对话页：第一条显示 Yi 自己写的话，cabinet 拼的任务说明不展示
	if (first && shown !== undefined)
		return (
			<>
				<div className="chat-user">{shown}</div>
				<div className="chat-user-images">
					<Thumbs images={images} />
				</div>
			</>
		);
	// 第一条是 cabinet 拼的任务说明，很长：默认折叠；里面的截图折叠时也露出来
	return (
		<>
			{open ? (
				<div className="chat-user">{text.replace(/^Yi：/, "").replace(/\n\n（这是 Yi 的消息：[\s\S]*$/, "")}</div>
			) : (
				<div className="chat-user collapsed" onClick={() => setOpen(true)}>
					任务说明（展开）
				</div>
			)}
			<div className="chat-user-images">
				<Thumbs images={images} />
			</div>
		</>
	);
}

/** 开发任务的对话：你说的话、agent 的回复、每一步工具调用；运行中实时追加。chatMode：对话页里第一条显示原话 */
export function Chat({ dev, chatMode = false }: { dev: DevTask; chatMode?: boolean }) {
	const live = useLiveSteps(dev.status === "running" ? `dev-${dev.id}` : undefined);
	const { data: items } = useQuery({
		queryKey: ["devtranscript", dev.id, dev.updated, live?.length ?? 0, live?.filter((s) => s.done).length ?? 0],
		queryFn: () => fetchDevTranscript(dev.id),
		placeholderData: (prev) => prev,
	});
	const end = useRef<HTMLDivElement>(null);
	const count = items?.length ?? 0;
	const seen = useRef(0);
	// 运行中来了新内容才滚到底部；打开一个已经结束的任务时停在开头，先看到要做什么，再往下读结论
	useEffect(() => {
		if (count && seen.current && count > seen.current) end.current?.scrollIntoView({ block: "end", behavior: "smooth" });
		if (count) seen.current = count;
	}, [count]);
	if (!items?.length) return <div className="foot">{dev.status === "running" ? "已开始，等待第一步…" : "还没有对话记录"}</div>;
	const firstUser = items.findIndex((it) => it.kind === "user");
	return (
		<div className="chat">
			{items.map((it, i) =>
				it.kind === "user" ? (
					<UserBubble key={i} text={it.text ?? ""} first={i === firstUser} images={it.images} shown={chatMode ? dev.request : undefined} />
				) : it.kind === "assistant" ? (
					<div key={i} className="chat-agent">
						<Markdown text={it.text ?? ""} />
						<Thumbs images={it.images} />
					</div>
				) : (
					<ToolLine key={i} item={it} />
				),
			)}
			{dev.status === "running" && <div className="foot livedot">正在处理</div>}
			<div ref={end} />
		</div>
	);
}

export function DevDrawer({
	dev: d,
	onClose,
	onBack,
	backLabel,
}: {
	dev: DevTask;
	task?: Task;
	onClose: () => void;
	onBack?: () => void;
	backLabel?: string;
}) {
	const qc = useQueryClient();
	const running = d.status === "running";
	const isDev = d.agent === "dev";
	const ended = d.status === "discarded" || d.status === "done";
	// 归档的开发任务 worktree 已经删了；助手类任务会话还在，完成了也能接着问
	const canTalk = d.status !== "discarded" && !(isDev && d.status === "done");
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
		if (
			action === "push" &&
			!(await confirmDialog({
				title: d.mrUrl ? `把新提交推送到 ${d.branch}？` : `推送 ${d.branch}，并创建合并到 ${d.base} 的 MR？`,
				body: d.mrUrl ? "MR 已经有了，只推送新提交。" : undefined,
				confirmText: "推送",
			}))
		)
			return;
		if (
			action === "discard" &&
			!(await confirmDialog({
				title: "放弃这个开发任务？",
				body: `会删除它的工作目录和本地分支 ${d.branch}，没推送的改动找不回来。`,
				confirmText: "放弃",
			}))
		)
			return;
		if (action === "message" && !text.trim()) return;
		setBusy(true);
		try {
			const r = await post(`/api/dev/${d.id}/${action}`, { text });
			setMsg(
				action === "push"
					? { text: r.url ? `已推送，MR：${r.url}` : "已推送，MR 已更新" }
					: action === "message"
						? { text: r.mode === "steered" ? "已发送，它会在下一步之前看到" : "已发送，助手开始处理" }
						: action === "stop"
							? { text: "已停止" }
							: action === "close"
								? { text: "已完成" }
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
	const conclusion = !running && d.status !== "pushing" && Boolean(d.summary?.trim());
	// 开发任务只查清楚、没改代码，或者 MR 已经提了，也能直接完成；还有没推送的改动时只能推送或放弃
	const canClose = d.status === "pushed" || (d.status === "review" && Boolean(diff) && !diff!.commits && !diff!.uncommitted);
	return (
		<Drawer
			onBack={onBack}
			backLabel={backLabel}
			title={
				isDev ? `开发助手：${d.repo.split("/").pop()}` : `${AGENT_NAME[d.agent] ?? d.agent}${d.repo ? `：${d.repo.split("/").pop()}` : ""}`
			}
			onClose={onClose}
			actions={
				!canTalk ? undefined : (
					<div className="chat-input">
						<textarea
							value={text}
							disabled={d.status === "pushing"}
							placeholder={
								d.status === "done"
									? "已经完成了。再发消息，它会接着这次对话继续做（⌘↩ 发送）"
									: running
										? "补充一句，它会在下一步之前看到，例如「先别动 pb」（⌘↩ 发送）"
										: "提问、补充要求，或让它接着改（⌘↩ 发送）"
							}
							onChange={(e) => setText(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void act("message");
							}}
						/>
						<div className="row">
							<button className="btn primary" disabled={busy || !text.trim()} onClick={() => act("message")}>
								发送
							</button>
							{running && (
								<button className="btn" disabled={busy} onClick={() => act("stop")}>
									停止
								</button>
							)}
							{canPush && (
								<button className="btn" disabled={busy} onClick={() => act("push")}>
									{d.mrUrl ? "推送新提交" : "推送并创建 MR"}
								</button>
							)}
							{!running && !ended && (!isDev || canClose) && (
								<button className="btn" disabled={busy} onClick={() => act("close")}>
									完成
								</button>
							)}
							{!running && isDev && (
								<button className="btn ghost" disabled={busy} onClick={() => act("discard")}>
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
				<span className="num">{time(d.created)}</span>
				{isDev && (
					<span>
						分支 <code>{d.branch}</code>，基于 <code>origin/{d.base}</code>
					</span>
				)}
				{d.model && <span>{`${d.model.split("/").pop()}，思考强度${EFFORT[d.thinking ?? ""] ?? "默认"}`}</span>}
				{d.runs > 0 && <span className="num">{`第 ${d.runs} 轮，花费 ${money(d.usage?.cost)}`}</span>}
				{d.mrUrl && (
					<a href={d.mrUrl} target="_blank" rel="noreferrer">
						打开 MR
					</a>
				)}
			</div>
			{/* 跑完了先给结论：打开就能看到答案，过程折起来 */}
			{conclusion && (
				<>
					<div className="label">结论</div>
					<div className="chat-agent conclusion">
						<Conclusion text={d.summary} ui={d.ui} devId={d.id} />
					</div>
				</>
			)}
			{conclusion ? (
				<details className="ctxwrap">
					<summary>要做什么</summary>
					<blockquote>{d.request}</blockquote>
				</details>
			) : (
				<>
					<div className="label">要做什么</div>
					<blockquote>{d.request}</blockquote>
				</>
			)}
			{d.error && <div className="err">{d.error}</div>}
			{diff && (
				<>
					<div className="label">
						改动：{diff.commits ? `${diff.commits.split("\n").length} 个提交` : "还没有提交"}
						<button className="linkbtn" onClick={() => setShowDiff(!showDiff)}>
							{showDiff ? "收起" : "查看改动"}
						</button>
					</div>
					{diff.uncommitted && <div className="err">还有未提交的改动：{diff.uncommitted}</div>}
					{showDiff && (
						<>
							<pre className="diff">{diff.commits}</pre>
							<pre className="diff">{diff.diff || "没有改动"}</pre>
						</>
					)}
				</>
			)}
			{conclusion ? (
				<details className="ctxwrap">
					<summary>过程</summary>
					<Chat dev={d} />
				</details>
			) : (
				<>
					<div className="label">过程</div>
					<Chat dev={d} />
				</>
			)}
		</Drawer>
	);
}
