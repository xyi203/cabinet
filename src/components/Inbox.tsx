import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type InboxItem, post } from "../lib/api";
import { AGENT_NAME, ago } from "../lib/format";

const LEVELS: Array<{ level: InboxItem["level"]; name: string; hint: string }> = [
	{ level: "now", name: "现在", hint: "有人在等：写操作审批、草稿待确认、起草失败、告警结论、Watchdog 发现的问题" },
	{ level: "soon", name: "尽快", hint: "agent 任务待看或失败" },
	{ level: "later", name: "有空", hint: "建议不回的草稿、有冲突的记忆（只在这里，不推送）" },
];
const KIND: Record<InboxItem["kind"], string> = {
	draft: "草稿",
	failure: "失败",
	dev: "任务",
	memory: "记忆",
	watch: "系统",
	approval: "审批",
};

/** 写操作审批：在这里直接执行或拒绝（飞书卡片上也能点，两边同步） */
function ApprovalActions({ id }: { id: string }) {
	const qc = useQueryClient();
	const [note, setNote] = useState("");
	const [busy, setBusy] = useState(false);
	const [msg, setMsg] = useState("");
	async function act(action: "approve" | "reject") {
		if (action === "approve" && !confirm("执行这个写操作？")) return;
		setBusy(true);
		try {
			await post(`/api/approvals/${id}/${action}`, { note });
			setMsg(action === "approve" ? "已批准，执行中…" : "已拒绝");
			qc.invalidateQueries({ queryKey: ["state"] });
		} catch (e) {
			setMsg((e as Error).message);
		} finally {
			setBusy(false);
		}
	}
	return (
		<div className="approval-actions" onClick={(e) => e.stopPropagation()}>
			<input value={note} onChange={(e) => setNote(e.target.value)} placeholder="拒绝时可以写一句理由" />
			<button className="btn primary" disabled={busy} onClick={() => act("approve")}>
				执行
			</button>
			<button className="btn danger" disabled={busy} onClick={() => act("reject")}>
				拒绝
			</button>
			{msg && <span className="foot">{msg}</span>}
		</div>
	);
}

/** 待你处理：需要你判断的事都在这一页，点一条打开对应的抽屉 */
export function Inbox({ items, now, onOpen }: { items: InboxItem[]; now: number; onOpen: (it: InboxItem) => void }) {
	if (!items.length) return <div className="empty">没有要你处理的事</div>;
	return (
		<div>
			{LEVELS.map(({ level, name, hint }) => {
				const rows = items.filter((it) => it.level === level);
				if (!rows.length) return null;
				return (
					<section key={level} className="inbox-group">
						<h2>
							{name} <span>{rows.length}</span> <small>{hint}</small>
						</h2>
						{rows.map((it) => (
							<div
								key={`${it.kind}-${it.ref}`}
								className={`card${it.kind === "watch" || it.kind === "approval" ? "" : " click"}`}
								onClick={() => onOpen(it)}
							>
								<div className="meta">
									<span className={`tag ${it.kind === "failure" || it.kind === "watch" ? "failed" : it.kind}`}>{KIND[it.kind]}</span>
									<span className="who">{it.why}</span>
									<span>{it.kind === "dev" ? (AGENT_NAME[it.label] ?? it.label) : it.label}</span>
									<span>{ago(now, it.at)}</span>
								</div>
								{it.kind === "approval" ? (
									<>
										<pre className="approval-what">{it.title.replace(/```\n?/g, "").slice(0, 1500)}</pre>
										<ApprovalActions id={it.ref} />
									</>
								) : (
									<blockquote>{it.title.slice(0, 300)}</blockquote>
								)}
							</div>
						))}
					</section>
				);
			})}
		</div>
	);
}
