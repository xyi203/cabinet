import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type Draft, type Task, fetchStickers, post } from "../lib/api";
import { GLYPH, STATUS, describeDraft, money, time, where } from "../lib/format";
import { DispatchForm } from "./DevDrawer";
import { Drawer, type Msg, MsgLine } from "./Drawer";
import { StepLog } from "./StepLog";
import { confirmDialog } from "./Confirm";

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

	async function act(action: string, arg = "", kind = "text") {
		setBusy(true);
		try {
			await post(`/api/drafts/${d.id}/${action}`, { text: arg, kind });
			setMsg({
				text:
					action === "revise"
						? "已提交改写，新草稿生成后会出现在待办里（同时私聊发你一份）"
						: action === "send"
							? "已以你的身份发出"
							: action === "complete"
								? "已标记完成"
								: "已标记为不发",
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
			? `AI 建议不回复：${d.draft}\n需要回复可以直接在这里写，或在下方点表情`
			: d.kind !== "text"
				? `AI 建议回${d.kind === "reaction" ? "表情" : "表情包"}：${d.draft}（在下方点选即可发送），也可以在这里改成文字`
				: "";

	return (
		<Drawer
			title={where(d)}
			onClose={onClose}
			actions={
				<>
					<button
						className="btn primary"
						disabled={busy}
						onClick={async () => {
							if (!text.trim()) return setMsg({ text: "回复内容是空的", bad: true });
							if (await confirmDialog({ title: `以你的身份发给 ${d.senderName}？`, body: text.trim().slice(0, 300), confirmText: "发送" }))
								void act("send", text.trim());
						}}
					>
						以我的身份发送
					</button>
					<button
						className="btn"
						disabled={busy}
						onClick={() => (opinion.trim() ? act("revise", opinion.trim()) : setMsg({ text: "先填修改意见", bad: true }))}
					>
						AI 改写
					</button>
					<button className="btn" disabled={busy} title="已经在别处处理过，不发任何消息" onClick={() => act("complete")}>
						标记完成
					</button>
					<button className="btn danger" disabled={busy} onClick={() => act("discard")}>
						不发
					</button>
					<button
						className="btn"
						disabled={busy}
						title="交给 agent：查询类只读地查，不建分支；要改代码的在独立 worktree 里实现，你审核后再推送"
						onClick={() => setDispatching(!dispatching)}
					>
						转成任务
					</button>
				</>
			}
		>
			<div className="meta">
				<span className={`pill ${d.status}`}>{STATUS[d.status] ?? d.status}</span>
				<span>{time(d.created)}</span>
				{d.meego && (
					<a href={d.meego.url} target="_blank" rel="noreferrer">
						打开工作项
					</a>
				)}
			</div>
			{d.context && (
				<>
					<div className="label">{d.chatMode === "meego" ? "工作项最近的评论" : "相关前文"}</div>
					<blockquote className="ctx">{d.context}</blockquote>
				</>
			)}
			<div className="label">原消息</div>
			<blockquote>{d.text}</blockquote>
			{dispatching && <DispatchForm draft={d} onDone={onClose} />}
			<MrPanel d={d} />
			{d.note && (
				<>
					<div className="label">备注（不会发出）</div>
					<div className="body">{d.note}</div>
				</>
			)}
			<div className="label">回复内容（可直接修改，发出时以你的身份发送）</div>
			<textarea value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} />
			{!isMeego && (
				<>
					<div className="label">或者直接回表情（加在对方消息上）</div>
					<div className="emojis">
						{stickers?.emoji.map((e) => (
							<button
								key={e}
								title={e}
								disabled={busy}
								style={d.kind === "reaction" && d.draft === e ? { borderColor: "var(--accent)" } : undefined}
								onClick={async () => {
									if (await confirmDialog({ title: `以你的身份给 ${d.senderName} 的消息加表情 ${GLYPH[e] ?? e}？`, confirmText: "加表情" }))
										void act("send", e, "reaction");
								}}
							>
								{`${GLYPH[e] ?? ""} ${e}`.trim()}
							</button>
						))}
					</div>
					<div className="label">或者发表情包（data/stickers）</div>
					<div className="stickers">
						{stickers?.stickers.length ? (
							stickers.stickers.map((f) => (
								<button
									key={f}
									disabled={busy}
									style={d.kind === "sticker" && d.draft === f ? { borderColor: "var(--accent)" } : undefined}
									onClick={async () => {
										if (await confirmDialog({ title: `以你的身份给 ${d.senderName} 发表情包「${f}」？`, confirmText: "发送" }))
											void act("send", f, "sticker");
									}}
								>
									<img src={`/api/stickers/${encodeURIComponent(f)}`} alt={f} />
									{f.replace(/\.[^.]+$/, "")}
								</button>
							))
						) : (
							<div className="foot">目录里还没有表情包，放图片进去即可，无需重启</div>
						)}
					</div>
				</>
			)}
			<div className="label">让 AI 改写（填修改意见）</div>
			<input value={opinion} placeholder="例如：语气随意点，补一句今天下班前给结论" onChange={(e) => setOpinion(e.target.value)} />
			<MsgLine msg={msg} />
			<div className="label">执行日志</div>
			<StepLog task={task} />
		</Drawer>
	);
}

/** MR 预审：评审报告，以及 GitLab 上 approve、评审意见发成 MR 评论（草稿发没发都能点） */
function MrPanel({ d }: { d: Draft }) {
	const qc = useQueryClient();
	const [busy, setBusy] = useState(false);
	const [msg, setMsg] = useState<Msg>(null);
	const mr = d.mr;
	async function act(action: "approve" | "note") {
		const ok = await confirmDialog(
			action === "approve"
				? { title: `在 GitLab 上 approve ${mr!.project}!${mr!.iid}？` }
				: { title: `把评审意见发到 ${mr!.project}!${mr!.iid}？`, body: d.report, confirmText: "发到 MR" },
		);
		if (!ok) return;
		setBusy(true);
		try {
			await post(`/api/drafts/${d.id}/mr/${action}`);
			setMsg({ text: action === "approve" ? "已在 GitLab approve" : "评审意见已发到 MR" });
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
					<div className="label">评审报告（只给你看）</div>
					<div className="body">{d.report}</div>
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
							<span className="pill sent">已 approve</span>
						) : (
							<button className="btn primary" disabled={busy} onClick={() => act("approve")}>
								GitLab 通过（approve）
							</button>
						)}
						{d.report &&
							(mr.done.includes("note") ? (
								<span className="pill sent">评审意见已发到 MR</span>
							) : (
								<button className="btn" disabled={busy} onClick={() => act("note")}>
									评审意见发到 MR
								</button>
							))}
					</div>
					<MsgLine msg={msg} />
				</>
			)}
		</>
	);
}

export function TaskDrawer({ task: t, draft, onClose }: { task: Task; draft?: Draft; onClose: () => void }) {
	const qc = useQueryClient();
	const [busy, setBusy] = useState(false);
	const [msg, setMsg] = useState<Msg>(null);
	const answer = t.answer ?? (draft ? describeDraft(draft) : "");
	async function retry(action: "retry" | "dismiss" = "retry") {
		setBusy(true);
		try {
			await post(`/api/tasks/${t.id}/${action}`);
			setMsg({ text: action === "retry" ? "已重新提交，稍后会出现在「进行中」" : "已忽略，不再算失败" });
			qc.invalidateQueries({ queryKey: ["state"] });
			setTimeout(onClose, 1200);
		} catch (e) {
			setMsg({ text: (e as Error).message, bad: true });
			setBusy(false);
		}
	}
	return (
		<Drawer
			title={`${t.type === "draft" ? "草稿" : "问答"} · ${t.label}`}
			onClose={onClose}
			actions={
				t.status === "blocked" ? (
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
				<span className={`pill ${t.status === "blocked" ? "failed" : t.status === "done" ? "sent" : "pending"}`}>{t.sub || t.status}</span>
				<span>{time(t.created)}</span>
				{t.seconds ? <span>{`${t.seconds}s · ${money(t.usage?.cost)}`}</span> : null}
				{t.route && <span title="分派依据">{t.route}</span>}
			</div>
			{draft?.context && (
				<>
					<div className="label">相关前文</div>
					<blockquote className="ctx">{draft.context}</blockquote>
				</>
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
					<div className="label">错误</div>
					<div className="err">{t.error}</div>
				</>
			)}
			<MsgLine msg={msg} />
			<div className="label">执行日志</div>
			<StepLog task={t} />
		</Drawer>
	);
}
