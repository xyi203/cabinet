import { type RecordRow } from "../lib/api";
import { STATUS, money, time } from "../lib/format";
import { dur } from "./ui";

const Pill = ({ st }: { st: string }) => <span className={`pill ${st}`}>{STATUS[st] ?? st}</span>;

export function RecordList({ records }: { records: RecordRow[] }) {
	if (!records.length) return <div className="foot">还没有记录</div>;
	return (
		<div>
			{records.map((r) => (
				<div key={r.id} className="card">
					<div className="meta">
						<span className="who">{r.label || (r.kind === "draft" ? "草稿" : "问答")}</span>
						<Pill st={r.status} />
						<span className="num">{time(r.ts)}</span>
						{r.seconds ? <span className="num">{`用时 ${dur(r.seconds)}，花费 ${money(r.usage?.cost)}`}</span> : null}
					</div>
					{r.question && <blockquote>{r.question}</blockquote>}
					{r.answer && <div className="body">{r.answer}</div>}
					{r.error && <div className="err">{r.error}</div>}
				</div>
			))}
		</div>
	);
}
