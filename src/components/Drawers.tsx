import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useContext, useState } from "react";
import { type Draft, type Task, fetchStickers, post } from "../lib/api";
import { GLYPH, STATUS, describeDraft, money, time, where } from "../lib/format";
import { DispatchForm } from "./DevDrawer";
import { Drawer, Embedded, type Msg, MsgLine } from "./Drawer";
import { Md } from "./Md";
import { StepLog } from "./StepLog";
import { confirmDialog } from "./Confirm";
import { dur } from "./ui";

/**
 * 一份待发送的草稿：上面是对方说了什么，中间是可以直接改的回复和「想怎么改」，
 * 底部一排：发送 / 不回复 / 完成 / 转成任务。草稿内容就摆在眼前，发送不再弹确认
 */
export function DraftDrawer({ draft: d, task, onClose }: { draft: Draft; task?: Task; onClose: () => void }) {
	const qc = useQueryClient();
	const { data: stickers } = useQuery({ queryKey: ["stickers"], queryFn: fetchStickers });
	const editable = d.status !== "noreply" && d.kind === "text";
	const [text, setText] = useState(editable ? d.draft : "");
	const [opinion, setOpinion] = useState("");
	const [busy, setBusy] = useState(false);
	const [msg, setMsg] = useState<Msg>(null);
	const [dispatching, setDispatching] = useState(false);
	const isMeego = d.chatMode === "meego";
	// 嵌在任务详情里时，上面的时间线已经有原消息、来源和时间
	const embedded = useContext(Embedded);
	// 表情、表情包草稿：文字框空着时，「发送」发的就是 AI 建议的那个
	const suggested = d.status !== "noreply" && d.kind !== "text" ? d.draft : "";

	async function act(action: string, arg = "", kind = "text") {
		setBusy(true);
		try {
			await post(`/api/drafts/${d.id}/${action}`, { text: arg, kind });
			setMsg({
				text:
					action === "revise"
						? "正在改写，好了会出现在「等你处理」，飞书里也会收到"
						: action === "send"
							? "已发送"
							: action === "complete"
								? "已完成"
								: "好的，这条不回复",
			});
			qc.invalidateQueries({ queryKey: ["state"] });
			setTimeout(onClose, action === "revise" ? 1500 : 900);
		} catch (e) {
			setMsg({ text: (e as Error).message, bad: true });
			setBusy(false);
		}
	}

	const placeholder =
		d.status === "noreply"
			? `AI 觉得这条不用回复：${d.draft}\n要回复的话，直接写在这里。`
			: suggested
				? `AI 建议回${d.kind === "reaction" ? `表情 ${GLYPH[suggested] ?? suggested}` : `表情包「${suggested.replace(/\.[^.]+$/, "")}」`}，点「发送」就会发出。想回文字的话，直接写在这里。`
				: "";

	return (
		<Drawer
			title={embedded ? `回复 ${d.senderName}` : where(d)}
			onClose={onClose}
			actions={
				<>
					<button
						className="btn primary"
						disabled={busy || !(text.trim() || suggested)}
						title={`以你的身份发给 ${d.senderName}`}
						onClick={() => void (text.trim() ? act("send", text.trim()) : act("send", suggested, d.kind))}
					>
						发送
					</button>
					<button className="btn" disabled={busy} onClick={() => act("discard")}>
						不回复
					</button>
					<button className="btn" disabled={busy} title="已经在别处处理过了，不发任何消息" onClick={() => act("complete")}>
						完成
					</button>
					<span className="spacer" />
					<button
						className="btn ghost"
						disabled={busy}
						aria-expanded={dispatching}
						title="交给助手去查，或让开发助手改代码"
						onClick={() => setDispatching(!dispatching)}
					>
						转成任务
					</button>
				</>
			}
		>
			{!embedded && (
				<div className="meta">
					<span className={`pill ${d.status}`}>{STATUS[d.status] ?? d.status}</span>
					<span className="num">{time(d.created)}</span>
				</div>
			)}
			{d.meego && (
				<a href={d.meego.url} target="_blank" rel="noreferrer">
					打开工作项
				</a>
			)}
			{d.context && (
				// 前文短就直接展开，长了折起来，免得把回复框挤到下面
				<details className="ctxwrap" open={d.context.length <= 300}>
					<summary>{d.chatMode === "meego" ? "工作项里最近的评论" : "前面的聊天"}</summary>
					<blockquote className="ctx">{d.context}</blockquote>
				</details>
			)}
			{!embedded && (
				<>
					<div className="label">{d.senderName} 说</div>
					<blockquote>{d.text}</blockquote>
				</>
			)}
			{dispatching && <DispatchForm draft={d} onDone={onClose} />}
			<MrPanel d={d} />
			{d.note && (
				<>
					<div className="label">AI 的备注（只有你能看到）</div>
					<Md text={d.note} />
				</>
			)}
			{!embedded && (
				<label className="label" htmlFor={`reply-${d.id}`}>
					你的回复
				</label>
			)}
			<textarea
				id={`reply-${d.id}`}
				aria-label={`回复 ${d.senderName}`}
				value={text}
				placeholder={placeholder}
				onChange={(e) => setText(e.target.value)}
			/>
			<div className="revise">
				<input
					value={opinion}
					placeholder="想怎么改？例如：语气随意点，补一句今天下班前给结论"
					aria-label="改写意见"
					onChange={(e) => setOpinion(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.nativeEvent.isComposing && opinion.trim()) void act("revise", opinion.trim());
					}}
				/>
				<button className="btn" disabled={busy || !opinion.trim()} onClick={() => act("revise", opinion.trim())}>
					改写
				</button>
			</div>
			{!isMeego && (
				<>
					<div className="label">或者回一个表情</div>
					<div className="emojis">
						{stickers?.emoji.map((e) => (
							<button
								key={e}
								title={`给 ${d.senderName} 的消息加上「${GLYPH[e] ?? e}」`}
								disabled={busy}
								className={d.kind === "reaction" && d.draft === e ? "on" : undefined}
								onClick={() => void act("send", e, "reaction")}
							>
								{GLYPH[e] ?? e}
							</button>
						))}
					</div>
					<div className="label">或者发一个表情包</div>
					<div className="stickers">
						{stickers?.stickers.length ? (
							stickers.stickers.map((f) => (
								<button
									key={f}
									disabled={busy}
									title={`发给 ${d.senderName}`}
									className={d.kind === "sticker" && d.draft === f ? "on" : undefined}
									onClick={() => void act("send", f, "sticker")}
								>
									<img src={`/api/stickers/${encodeURIComponent(f)}`} alt="" />
									{f.replace(/\.[^.]+$/, "")}
								</button>
							))
						) : (
							<div className="foot">
								还没有表情包。把图片放进 <code>data/stickers</code> 文件夹就能用。
							</div>
						)}
					</div>
				</>
			)}
			<MsgLine msg={msg} />
			<details className="ctxwrap">
				<summary>AI 是怎么起草的</summary>
				<StepLog task={task} />
			</details>
		</Drawer>
	);
}

/** MR 预审：评审报告，以及在 GitLab 上批准、把评审意见发成 MR 评论（草稿发没发都能点） */
function MrPanel({ d }: { d: Draft }) {
	const qc = useQueryClient();
	const [busy, setBusy] = useState(false);
	const [msg, setMsg] = useState<Msg>(null);
	const mr = d.mr;
	async function act(action: "approve" | "note") {
		// 评论一次会发出好几条，发出去别人马上能看到：先确认一次。批准可以在 GitLab 上撤销，不再确认
		if (
			action === "note" &&
			!(await confirmDialog({ title: `把评审意见发到 ${mr!.project}!${mr!.iid}`, body: d.report, confirmText: "发到 MR" }))
		)
			return;
		setBusy(true);
		try {
			await post(`/api/drafts/${d.id}/mr/${action}`);
			setMsg({ text: action === "approve" ? "已在 GitLab 批准" : "评审意见已发到 MR" });
			qc.invalidateQueries({ queryKey: ["state"] });
		} catch (e) {
			setMsg({ text: (e as Error).message, bad: true });
		} finally {
			setBusy(false);
		}
	}
	if (!d.report && !mr) return null;
	return (
		<>
			{d.report && (
				<>
					<div className="label">评审报告（只有你能看到）</div>
					<Md text={d.report} />
				</>
			)}
			{mr && (
				<>
					<div className="label">
						MR{" "}
						<a href={mr.url} target="_blank" rel="noreferrer">
							{mr.project}!{mr.iid}
						</a>
					</div>
					<div className="row-inline">
						{mr.done.includes("approve") ? (
							<span className="pill sent">已在 GitLab 批准</span>
						) : (
							<button className="btn primary" disabled={busy} onClick={() => act("approve")}>
								在 GitLab 批准
							</button>
						)}
						{d.report &&
							(mr.done.includes("note") ? (
								<span className="pill sent">评审意见已发到 MR</span>
							) : (
								<button className="btn" disabled={busy} onClick={() => act("note")}>
									把评审意见发到 MR
								</button>
							))}
					</div>
					<MsgLine msg={msg} />
				</>
			)}
		</>
	);
}

/** 起草 / 问答这次处理本身的状态（不是草稿的状态） */
const RUN: Record<string, string> = { todo: "排队中", in_progress: "进行中", blocked: "失败", done: "已完成", cancelled: "已取消" };

export function TaskDrawer({ task: t, draft, onClose }: { task: Task; draft?: Draft; onClose: () => void }) {
	const qc = useQueryClient();
	const [busy, setBusy] = useState(false);
	const [msg, setMsg] = useState<Msg>(null);
	const answer = t.answer ?? (draft ? describeDraft(draft) : "");
	async function retry(action: "retry" | "dismiss" = "retry") {
		setBusy(true);
		try {
			await post(`/api/tasks/${t.id}/${action}`);
			setMsg({ text: action === "retry" ? "正在重试，可以在「进行中」看进度" : "已忽略" });
			qc.invalidateQueries({ queryKey: ["state"] });
			setTimeout(onClose, 1200);
		} catch (e) {
			setMsg({ text: (e as Error).message, bad: true });
			setBusy(false);
		}
	}
	const queued = t.type === "draft" && (t.status === "todo" || t.status === "in_progress");
	async function queuedAct(path: string, done: string) {
		setBusy(true);
		try {
			await post(path, { id: t.id });
			setMsg({ text: done });
			qc.invalidateQueries({ queryKey: ["state"] });
			setTimeout(onClose, 1000);
		} catch (e) {
			setMsg({ text: (e as Error).message, bad: true });
			setBusy(false);
		}
	}
	return (
		<Drawer
			title={`${t.type === "draft" ? "草稿" : "问答"}：${t.label}`}
			onClose={onClose}
			actions={
				queued ? (
					<>
						{t.status === "todo" && (
							<button className="btn primary" disabled={busy} onClick={() => queuedAct("/api/poll", "开始起草")}>
								现在起草
							</button>
						)}
						<button
							className="btn"
							disabled={busy}
							title="这条不用回，算作已处理"
							onClick={() => queuedAct("/api/drafts/dismiss", "好的，这条不起草了")}
						>
							不用起草
						</button>
					</>
				) : t.status === "blocked" ? (
					<>
						{t.retryable && (
							<button className="btn primary" disabled={busy} onClick={() => retry()}>
								重试
							</button>
						)}
						<button className="btn" disabled={busy} onClick={() => retry("dismiss")}>
							忽略
						</button>
					</>
				) : undefined
			}
		>
			<div className="meta">
				<span className={`pill ${t.status === "blocked" ? "failed" : t.status === "done" ? "sent" : "pending"}`}>
					{t.sub || RUN[t.status] || t.status}
				</span>
				<span className="num">{time(t.created)}</span>
				{t.seconds ? <span className="num">{`用时 ${dur(t.seconds)}，花费 ${money(t.usage?.cost)}`}</span> : null}
				{t.route && <span title="为什么这样分派">{t.route}</span>}
			</div>
			{draft?.context && (
				<details className="ctxwrap">
					<summary>前面的聊天</summary>
					<blockquote className="ctx">{draft.context}</blockquote>
				</details>
			)}
			<div className="label">原消息</div>
			<blockquote>{t.title}</blockquote>
			{answer && (
				<>
					<div className="label">回复</div>
					<div className="body">{answer}</div>
				</>
			)}
			{draft && <MrPanel d={draft} />}
			{t.error && (
				<>
					<div className="label">出了什么问题</div>
					<div className="err">{t.error}</div>
				</>
			)}
			<MsgLine msg={msg} />
			<details className="ctxwrap">
				<summary>处理过程</summary>
				<StepLog task={t} />
			</details>
		</Drawer>
	);
}
