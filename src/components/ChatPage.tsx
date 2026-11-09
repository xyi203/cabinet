import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { type DevTask, type RecordRow, createAgentTask, post } from "../lib/api";
import { ago, money } from "../lib/format";
import { Chat } from "./DevDrawer";
import { RecordList } from "./Lists";

/** 会话列表里的状态：只说进行中和出错，其余不写 */
const STATUS: Record<string, string> = { running: "正在回答", failed: "出错了" };

/**
 * 对话：直接和助手聊。左边是最近的会话，右边是整页对话，底部输入框；
 * 每段会话底层是一个 assistant 的 agent 任务（chat 标记），能力和看板派的任务一样，写操作照样要审批。
 */
export function ChatPage({ chats, records, now }: { chats: DevTask[]; records: RecordRow[]; now: number }) {
	const qc = useQueryClient();
	// null = 新对话；默认打开最近的一段
	const [sel, setSel] = useState<string | null | undefined>(undefined);
	const selected = sel === undefined ? chats[0]?.id : sel;
	const current = chats.find((c) => c.id === selected);
	const [text, setText] = useState("");
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState("");
	const box = useRef<HTMLTextAreaElement>(null);
	const open = (id: string | null) => {
		setSel(id);
		box.current?.focus();
	};

	async function send() {
		const t = text.trim();
		if (!t || busy) return;
		setBusy(true);
		setErr("");
		try {
			if (current) await post(`/api/dev/${current.id}/message`, { text: t });
			else {
				const task = await createAgentTask({ agent: "assistant", request: t, chat: true });
				setSel(task.id);
			}
			setText("");
			qc.invalidateQueries({ queryKey: ["state"] });
		} catch (e) {
			setErr((e as Error).message);
		} finally {
			setBusy(false);
		}
	}

	async function stop() {
		if (!current) return;
		try {
			await post(`/api/dev/${current.id}/stop`);
			qc.invalidateQueries({ queryKey: ["state"] });
		} catch (e) {
			setErr((e as Error).message);
		}
	}

	const running = current?.status === "running";
	return (
		<div className="chatpage">
			<aside>
				<button className="btn primary new" onClick={() => open(null)}>
					新对话
				</button>
				<div className="sessions">
					{chats.map((c) => (
						<div key={c.id} className={`session${c.id === selected ? " on" : ""}`} onClick={() => open(c.id)}>
							<div className="t">{c.title.replace(/\s+/g, " ")}</div>
							<div className="m num">
								{[STATUS[c.status], ago(now, c.updated), c.usage ? `花费 ${money(c.usage.cost)}` : ""].filter(Boolean).join("，")}
							</div>
						</div>
					))}
					{!chats.length && <div className="foot">还没有对话</div>}
				</div>
				<details className="qa-records">
					<summary>在飞书私聊机器人的问答</summary>
					<RecordList records={records} />
				</details>
			</aside>
			<main>
				<div className="thread">
					{current ? (
						<Chat key={current.id} dev={current} chatMode />
					) : (
						<div className="empty">
							查数据、看日志、翻代码、看告警，或者让它建一个定时任务。
							<br />
							要改动什么之前，它会先请你批准。
						</div>
					)}
				</div>
				<div className="composer">
					<textarea
						ref={box}
						autoFocus
						value={text}
						rows={3}
						placeholder={running ? "它还在回答，现在发的话会在下一步之前看到" : "问点什么。回车发送，Shift + 回车换行"}
						onChange={(e) => setText(e.target.value)}
						onKeyDown={(e) => {
							// 输入法选词时的回车不算发送
							if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
								e.preventDefault();
								void send();
							}
						}}
					/>
					<div className="row">
						{err && <span className="err">{err}</span>}
						{running && (
							<button className="btn" onClick={stop}>
								停止
							</button>
						)}
						<button className="btn primary" disabled={busy || !text.trim()} onClick={send}>
							发送
						</button>
					</div>
				</div>
			</main>
		</div>
	);
}
