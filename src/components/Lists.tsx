import { useQuery } from "@tanstack/react-query";
import { type Draft, type RecordRow, fetchMemory } from "../lib/api";
import { STATUS, describeDraft, isLive, money, time } from "../lib/format";

const Pill = ({ st }: { st: string }) => <span className={`pill ${st}`}>{STATUS[st] ?? st}</span>;

export function DraftList({ drafts, onOpen }: { drafts: Draft[]; onOpen: (d: Draft) => void }) {
	if (!drafts.length) return <div className="empty">暂无</div>;
	return (
		<div>
			{drafts.map((d) => (
				<div key={d.id} className={`card${isLive(d) ? " click" : ""}`} onClick={isLive(d) ? () => onOpen(d) : undefined}>
					<div className="meta">
						<span className="who">{d.senderName}</span>
						<span>{d.chatMode === "p2p" ? "私聊" : d.chatMode === "meego" ? `飞书项目「${d.chatName}」` : `群「${d.chatName}」@你`}</span>
						<Pill st={d.status} />
						<span>{time(d.created)}</span>
					</div>
					<blockquote>{d.text}</blockquote>
					<div className="label">{d.status === "noreply" ? "建议不回复" : "草稿"}</div>
					{d.kind === "sticker" ? (
						<div>
							<div className="body">{describeDraft(d)}</div>
							<img className="thumb" src={`/api/stickers/${encodeURIComponent(d.draft)}`} alt={d.draft} />
						</div>
					) : (
						<div className="body">{describeDraft(d)}</div>
					)}
					{d.note && (
						<>
							<div className="label">备注（不会发出）</div>
							<div className="body">{d.note}</div>
						</>
					)}
				</div>
			))}
		</div>
	);
}

export function RecordList({ records }: { records: RecordRow[] }) {
	if (!records.length) return <div className="empty">暂无</div>;
	return (
		<div>
			{records.map((r) => (
				<div key={r.id} className="card">
					<div className="meta">
						<span className="who">{r.label || (r.kind === "draft" ? "草稿" : "问答")}</span>
						<Pill st={r.status} />
						<span>{time(r.ts)}</span>
						{r.seconds ? <span>{`${r.seconds}s · ${money(r.usage?.cost)}`}</span> : null}
					</div>
					{r.question && <blockquote>{r.question}</blockquote>}
					{r.answer && <div className="body">{r.answer}</div>}
					{r.error && <div className="err">{r.error}</div>}
				</div>
			))}
		</div>
	);
}

export function Memory() {
	const { data, error } = useQuery({ queryKey: ["memory"], queryFn: fetchMemory });
	return (
		<div className="panel">
			<pre className="mem">{error ? "读取失败" : data ? data.text || "（空）" : "加载中…"}</pre>
		</div>
	);
}
