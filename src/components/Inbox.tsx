import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type Draft, type InboxItem, post } from "../lib/api";
import { AGENT_NAME, describeDraft } from "../lib/format";
import { confirmDialog } from "./Confirm";
import { INBOX_KIND } from "./Overview";
import { toast } from "./Toast";
import { Segmented, span } from "./ui";

const LEVEL: Record<InboxItem["level"], { name: string; cls: string; hint: string }> = {
	now: { name: "现在", cls: "bg-bad-soft text-bad", hint: "有人在等：写操作审批、草稿待确认、起草失败、告警结论、Watchdog 发现的问题" },
	soon: { name: "尽快", cls: "bg-warn-soft text-warn", hint: "agent 任务待看或失败" },
	later: { name: "有空", cls: "bg-soft text-muted", hint: "建议不回的草稿、有冲突的记忆（只在这里，不推送）" },
};
const KINDS: InboxItem["kind"][] = ["approval", "draft", "failure", "dev", "memory", "watch"];
type Tab = "all" | InboxItem["kind"];

const btn =
	"cursor-pointer rounded-md border border-line bg-panel px-2.5 py-1 text-[12px] text-text hover:bg-soft disabled:cursor-default disabled:opacity-50";
const primary =
	"cursor-pointer rounded-md border border-accent bg-accent px-2.5 py-1 text-[12px] text-white hover:opacity-90 disabled:cursor-default disabled:opacity-50";

/** 发请求、刷新看板、结果走提示条 */
function useAct() {
	const qc = useQueryClient();
	const [busy, setBusy] = useState(false);
	async function act(url: string, body: unknown, done: string) {
		setBusy(true);
		try {
			await post(url, body);
			toast(done);
			qc.invalidateQueries({ queryKey: ["state"] });
		} catch (e) {
			toast((e as Error).message, true);
		} finally {
			setBusy(false);
		}
	}
	return { busy, act };
}

/** 写操作审批：在这里直接执行或拒绝（飞书卡片上也能点，两边同步） */
function ApprovalActions({ id, what, learn }: { id: string; what: string; learn?: string }) {
	const { busy, act } = useAct();
	const [note, setNote] = useState("");
	return (
		<div className="mt-2 flex flex-wrap items-center gap-2" onClick={(e) => e.stopPropagation()}>
			<input
				value={note}
				onChange={(e) => setNote(e.target.value)}
				placeholder="拒绝时可以写一句理由"
				className="min-w-[200px] flex-1 rounded-md border border-line bg-bg px-2.5 py-1 text-[12px] text-text"
			/>
			<button
				className={primary}
				disabled={busy}
				onClick={async () => {
					if (await confirmDialog({ title: "执行这个写操作？", body: what, confirmText: "执行" }))
						void act(`/api/approvals/${id}/approve`, { note }, "已批准，执行中…");
				}}
			>
				执行
			</button>
			{learn && (
				<button
					className={btn}
					disabled={busy}
					title={`确认是只读的话：${learn}，之后不再问`}
					onClick={async () => {
						if (await confirmDialog({ title: "执行，并以后直接放行？", body: `${what}\n\n${learn}`, confirmText: "执行并放行" }))
							void act(`/api/approvals/${id}/remember`, { note }, "已批准，以后同样的命令直接放行");
					}}
				>
					执行并以后放行
				</button>
			)}
			<button className={btn} disabled={busy} onClick={() => act(`/api/approvals/${id}/reject`, { note }, "已拒绝")}>
				拒绝
			</button>
		</div>
	);
}

/** 按钮区的点击不冒泡到整行（整行点击是打开抽屉） */
const stop = (e: React.MouseEvent) => e.stopPropagation();

/** 每一类就地能做的事；更复杂的（改写、指派）点开抽屉 */
function QuickActions({ it, draft, onOpen }: { it: InboxItem; draft?: Draft; onOpen: () => void }) {
	const { busy, act } = useAct();
	if (it.kind === "draft" && draft)
		return (
			<div className="flex shrink-0 gap-1.5" onClick={stop}>
				{draft.status === "pending" && (
					<button
						className={primary}
						disabled={busy}
						onClick={async () => {
							if (await confirmDialog({ title: `以你的身份发给 ${draft.senderName}？`, body: describeDraft(draft), confirmText: "发送" }))
								void act(`/api/drafts/${draft.id}/send`, { text: draft.draft, kind: draft.kind }, "已以你的身份发出");
						}}
					>
						发送
					</button>
				)}
				<button className={btn} disabled={busy} onClick={() => act(`/api/drafts/${draft.id}/discard`, {}, "已标记为不发")}>
					不发
				</button>
				<button className={btn} onClick={onOpen}>
					改写…
				</button>
			</div>
		);
	if (it.kind === "failure")
		return (
			<div className="flex shrink-0 gap-1.5" onClick={stop}>
				<button className={primary} disabled={busy} onClick={() => act(`/api/tasks/${it.ref}/retry`, {}, "已重新提交")}>
					重试
				</button>
				<button className={btn} disabled={busy} onClick={() => act(`/api/tasks/${it.ref}/dismiss`, {}, "已忽略")}>
					忽略
				</button>
			</div>
		);
	if (it.kind === "dev")
		return (
			<div className="flex shrink-0 gap-1.5" onClick={stop}>
				<button className={btn} onClick={onOpen}>
					看结论
				</button>
				<button className={btn} disabled={busy} onClick={() => act(`/api/dev/${it.ref}/close`, {}, "已归档")}>
					完成
				</button>
			</div>
		);
	if (it.kind === "memory")
		return (
			<button className={btn} onClick={onOpen}>
				去裁定
			</button>
		);
	return null;
}

/** 待办：需要你判断的事按来源分页签，带等待时长，能就地处理的直接处理 */
export function Inbox({
	items,
	drafts,
	now,
	onOpen,
}: {
	items: InboxItem[];
	drafts: Draft[];
	now: number;
	onOpen: (it: InboxItem) => void;
}) {
	const [tab, setTab] = useState<Tab>("all");
	const counts = new Map<Tab, number>([["all", items.length]]);
	for (const it of items) counts.set(it.kind, (counts.get(it.kind) ?? 0) + 1);
	const current = tab !== "all" && !counts.get(tab) ? "all" : tab;
	const rows = current === "all" ? items : items.filter((it) => it.kind === current);
	const options = [{ value: "all" as Tab, label: `全部 ${items.length}` }].concat(
		KINDS.filter((k) => counts.get(k)).map((k) => ({ value: k as Tab, label: `${INBOX_KIND[k]} ${counts.get(k)}` })),
	);
	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-wrap items-center gap-3">
				<Segmented value={current} options={options} onChange={setTab} />
				<span
					className="text-[12px] text-muted"
					title={Object.values(LEVEL)
						.map((l) => `${l.name}：${l.hint}`)
						.join("\n")}
				>
					按急缓排序：现在 → 尽快 → 有空
				</span>
			</div>
			{!rows.length && (
				<div className="rounded-xl border border-line bg-panel py-10 text-center text-[13px] text-muted">没有等你处理的事</div>
			)}
			{rows.map((it) => {
				const clickable = it.kind !== "watch" && it.kind !== "approval";
				const draft = it.kind === "draft" ? drafts.find((d) => d.id === it.ref) : undefined;
				const lv = LEVEL[it.level];
				return (
					<div
						key={`${it.kind}-${it.ref}`}
						className={`rounded-xl border border-line bg-panel px-4 py-3 ${clickable ? "cursor-pointer hover:border-accent/40" : ""}`}
						onClick={clickable ? () => onOpen(it) : undefined}
					>
						<div className="flex items-center gap-2 text-[12px]">
							<span className={`rounded px-1.5 py-0.5 ${lv.cls}`}>{lv.name}</span>
							<span className="rounded bg-accent-soft px-1.5 py-0.5 text-accent">{INBOX_KIND[it.kind]}</span>
							<span className="min-w-0 truncate font-semibold text-text">{it.why}</span>
							<span className="truncate text-muted">{it.kind === "dev" ? (AGENT_NAME[it.label] ?? it.label) : it.label}</span>
							<span className="ml-auto shrink-0 text-muted tabular-nums" title="从进来到现在">
								已等 {span(now - it.at)}
							</span>
						</div>
						{it.kind === "approval" ? (
							<>
								<pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-soft p-2.5 text-[12px] whitespace-pre-wrap text-text">
									{it.title.replace(/```\n?/g, "").slice(0, 1500)}
								</pre>
								<ApprovalActions id={it.ref} what={it.title.replace(/```\n?/g, "").slice(0, 600)} learn={it.learn} />
							</>
						) : (
							<div className="mt-2 flex items-start gap-3">
								<div className="min-w-0 flex-1">
									<div className="line-clamp-2 text-[13px] text-text">{it.title.slice(0, 300)}</div>
									{draft && draft.draft && <div className="mt-1 line-clamp-2 text-[12px] text-muted">草稿：{describeDraft(draft)}</div>}
								</div>
								<QuickActions it={it} draft={draft} onOpen={() => onOpen(it)} />
							</div>
						)}
					</div>
				);
			})}
		</div>
	);
}
