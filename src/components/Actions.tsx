// 一件事上就地能做的操作：工作台每行的主操作、任务详情里的审批和失败处理。改写、推送这类要看内容的，点开详情做
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type ApprovalView, type Draft, type State, type TaskView, post } from "../lib/api";
import { describeDraft } from "../lib/format";
import { confirmDialog } from "./Confirm";
import { toast } from "./Toast";

/** 发请求、刷新看板、结果走提示条 */
export function useAct() {
	const qc = useQueryClient();
	const [busy, setBusy] = useState(false);
	async function act(url: string, body: unknown, done: string) {
		setBusy(true);
		try {
			await post(url, body);
			toast(done);
			void qc.invalidateQueries({ queryKey: ["state"] });
		} catch (e) {
			toast((e as Error).message, true);
		} finally {
			setBusy(false);
		}
	}
	return { busy, act };
}

/** 按钮区的点击不冒泡到整行（整行点击是打开详情） */
export const stop = (e: React.MouseEvent) => e.stopPropagation();

/** 写操作审批：在这里直接执行或拒绝（飞书卡片上也能点，两边同步） */
export function ApprovalActions({ a }: { a: ApprovalView }) {
	const { busy, act } = useAct();
	const [note, setNote] = useState("");
	return (
		<div className="oa" onClick={stop}>
			<input
				id={`apv-note-${a.id}`}
				value={note}
				onChange={(e) => setNote(e.target.value)}
				placeholder="拒绝时可以写一句理由"
				className="in wide"
				aria-label="拒绝理由"
			/>
			<button
				className="btn pri sm"
				disabled={busy}
				onClick={async () => {
					if (await confirmDialog({ title: "执行这个写操作？", body: a.command, confirmText: "执行" }))
						void act(`/api/approvals/${a.id}/approve`, { note }, "已批准，执行中…");
				}}
			>
				批准执行
			</button>
			{a.learn && (
				<button
					className="btn sm"
					disabled={busy}
					title={`确认是只读的话：${a.learn}，之后不再问`}
					onClick={async () => {
						if (await confirmDialog({ title: "执行，并以后直接放行？", body: `${a.command}\n\n${a.learn}`, confirmText: "执行并放行" }))
							void act(`/api/approvals/${a.id}/remember`, { note }, "已批准，以后同样的命令直接放行");
					}}
				>
					执行并以后放行
				</button>
			)}
			<button className="btn ghost sm" disabled={busy} onClick={() => act(`/api/approvals/${a.id}/reject`, { note }, "已拒绝")}>
				拒绝
			</button>
		</div>
	);
}

/** 这件事现在挂着的草稿（最新一版） */
export const liveDraft = (t: TaskView, s: State): Draft | undefined => {
	const id = t.drafts.at(-1);
	return id ? s.drafts.find((d) => d.id === id) : undefined;
};

/** 工作台每行的主操作：一两个按钮，就地办完；要看内容的给「打开」 */
export function RowActions({ t, s, onOpen, onMemory }: { t: TaskView; s: State; onOpen: () => void; onMemory: () => void }) {
	const { busy, act } = useAct();
	const draft = liveDraft(t, s);
	const dev = t.devTasks.length ? s.devTasks.find((d) => d.id === t.devTasks.at(-1)) : undefined;
	const btn = (label: string, on: () => void, cls = "") => (
		<button className={`btn sm ${cls}`} disabled={busy} onClick={on}>
			{label}
		</button>
	);
	let body: React.ReactNode = null;
	if (t.status === "in_review" && t.need === "send" && draft?.status === "pending")
		body = (
			<>
				{draft.mr
					? btn("打开评审", onOpen, "pri")
					: btn(
							"发送",
							async () => {
								if (await confirmDialog({ title: `以你的身份发给 ${draft.senderName}？`, body: describeDraft(draft), confirmText: "发送" }))
									void act(`/api/drafts/${draft.id}/send`, { text: draft.draft, kind: draft.kind }, "已以你的身份发出");
							},
							"pri",
						)}
				{btn("不发", () => act(`/api/drafts/${draft.id}/discard`, {}, "已标记为不发"), "ghost")}
			</>
		);
	else if (t.status === "in_review" && t.need === "send" && dev) body = btn("看改动", onOpen, "pri");
	else if (t.need === "approve" && t.status === "blocked") body = btn("去审批", onOpen, "pri");
	else if (t.need === "read" && t.status === "in_review" && dev)
		body = (
			<>
				{btn("看结论", onOpen)}
				{btn("完成", () => act(`/api/dev/${dev.id}/close`, {}, "已完成"), "ghost")}
			</>
		);
	else if (t.need === "decide" && t.memories) body = btn("去裁定", onMemory, "pri");
	else if (t.need === "retry" && t.status === "blocked")
		body = t.retryId ? (
			<>
				{btn("重试", () => act(`/api/tasks/${t.retryId}/retry`, {}, "已重新提交"), "pri")}
				{btn("忽略", () => act(`/api/tasks/${t.retryId}/dismiss`, {}, "已忽略"), "ghost")}
			</>
		) : dev ? (
			btn("接着做", () => act(`/api/dev/${dev.id}/message`, { text: "上一轮失败了，接着把这个任务做完" }, "已让它接着做"), "pri")
		) : null;
	else if (t.id.startsWith("q:") && t.hold) body = btn("立即处理", () => act("/api/poll", { id: t.id.slice(2) }, "不等了，马上起草"));
	if (!body) return null;
	return (
		<div className="acts" onClick={stop}>
			{body}
		</div>
	);
}
