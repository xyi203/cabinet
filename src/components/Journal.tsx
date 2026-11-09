import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { fetchJournal, post } from "../lib/api";
import { when } from "../lib/format";
import { Markdown } from "./Markdown";
import { toast } from "./Toast";
import { Card, SectionTitle } from "./ui";

const today = () => new Date().toLocaleDateString("sv-SE");
const shift = (date: string, days: number) => {
	const d = new Date(`${date}T12:00:00`);
	d.setDate(d.getDate() + days);
	return d.toLocaleDateString("sv-SE");
};

// 一级标题是「某天工作日报」，页面上已有日期，不再重复
const body = (text: string) => text.replace(/^# .*(\r?\n)*/, "");

/** 日报：某一天的消息、草稿、任务、需求、审批和花费；可以让 AI 写成一段总结 */
export function JournalPage() {
	const qc = useQueryClient();
	const [date, setDate] = useState(today());
	const { data, error } = useQuery({ queryKey: ["journal", date], queryFn: () => fetchJournal(date) });
	const [busy, setBusy] = useState(false);
	async function generate() {
		setBusy(true);
		try {
			await post("/api/journal/generate", { date });
			toast("已生成总结");
			await qc.invalidateQueries({ queryKey: ["journal", date] });
		} catch (e) {
			toast((e as Error).message, true);
		} finally {
			setBusy(false);
		}
	}
	const isToday = date === today();
	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center gap-2">
				<button type="button" className="btn sm" onClick={() => setDate(shift(date, -1))}>
					前一天
				</button>
				<input
					type="date"
					aria-label="日期"
					value={date}
					max={today()}
					onChange={(e) => e.target.value && setDate(e.target.value)}
					className="rounded-md border border-line bg-panel px-2.5 py-1 text-[14px] text-text tabular-nums [font:inherit]"
				/>
				<button type="button" className="btn sm" disabled={isToday} onClick={() => setDate(shift(date, 1))}>
					后一天
				</button>
				{!isToday && (
					<button type="button" className="btn ghost sm" onClick={() => setDate(today())}>
						回到今天
					</button>
				)}
			</div>
			{error && !data && <div className="text-[14px] text-bad">日报读取失败：{(error as Error).message}</div>}
			{!data && !error && <div className="text-[14px] text-muted">加载中…</div>}
			{data && (
				<div className="grid grid-cols-[minmax(0,1fr)] items-start gap-4 xl:grid-cols-2">
					<Card className="p-4">
						<SectionTitle
							extra={
								<button type="button" disabled={busy} onClick={generate} className={`btn sm ${data.summary ? "" : "pri"}`}>
									{busy ? "正在生成…" : data.summary ? "重新生成" : "生成总结"}
								</button>
							}
						>
							总结
						</SectionTitle>
						{data.summary ? (
							<>
								<Markdown text={body(data.summary.text)} />
								<div className="mt-3 text-[12px] text-muted" title={`由 ${data.summary.model.split("/").pop()} 根据当天明细生成`}>
									{when(data.summary.at)} 生成
								</div>
							</>
						) : (
							<div className="text-[14px] text-muted">还没有总结。</div>
						)}
					</Card>
					<Card className="p-4">
						<SectionTitle>当天明细</SectionTitle>
						<Markdown text={body(data.markdown)} />
					</Card>
				</div>
			)}
		</div>
	);
}
