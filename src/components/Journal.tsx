import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { fetchJournal, post } from "../lib/api";
import { toast } from "./Toast";
import { Card, SectionTitle } from "./ui";

const today = () => new Date().toLocaleDateString("sv-SE");
const shift = (date: string, days: number) => {
	const d = new Date(`${date}T12:00:00`);
	d.setDate(d.getDate() + days);
	return d.toLocaleDateString("sv-SE");
};

/** 日报里只用到标题、列表和段落：简单渲染，不引 Markdown 库 */
function Md({ text }: { text: string }) {
	return (
		<div className="flex flex-col gap-1 text-[13px] leading-6 text-text">
			{text.split("\n").map((l, i) => {
				if (/^#\s/.test(l)) return null;
				if (/^#{2,}\s/.test(l))
					return (
						<div key={i} className="mt-2 text-[14px] font-semibold">
							{l.replace(/^#+\s/, "")}
						</div>
					);
				const m = /^(\s*)[-*]\s(.*)$/.exec(l);
				if (m)
					return (
						<div key={i} className="flex gap-2" style={{ paddingLeft: m[1].length * 8 }}>
							<span className="text-muted">•</span>
							<span className="min-w-0 flex-1">{m[2]}</span>
						</div>
					);
				return l.trim() ? <div key={i}>{l}</div> : null;
			})}
		</div>
	);
}

/** 日报：某一天的消息、草稿、任务、需求、审批和消耗；可以让模型写成一段文字总结 */
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
	const nav = "cursor-pointer rounded-md border border-line bg-panel px-2.5 py-1 text-[13px] text-text hover:bg-soft disabled:opacity-40";
	return (
		<div className="flex flex-col gap-4">
			<div className="flex items-center gap-2">
				<button type="button" className={nav} onClick={() => setDate(shift(date, -1))}>
					‹ 前一天
				</button>
				<input
					type="date"
					value={date}
					max={today()}
					onChange={(e) => e.target.value && setDate(e.target.value)}
					className="rounded-md border border-line bg-panel px-2.5 py-1 text-[13px] text-text"
				/>
				<button type="button" className={nav} disabled={date >= today()} onClick={() => setDate(shift(date, 1))}>
					后一天 ›
				</button>
				{date !== today() && (
					<button type="button" className={nav} onClick={() => setDate(today())}>
						今天
					</button>
				)}
			</div>
			{error && !data && <div className="text-[13px] text-bad">读取失败：{(error as Error).message}</div>}
			{data && (
				<div className="grid items-start gap-4 xl:grid-cols-2">
					<Card className="p-4">
						<SectionTitle
							extra={
								<button
									type="button"
									disabled={busy}
									onClick={generate}
									className="cursor-pointer rounded-md border border-accent bg-accent px-2.5 py-1 text-[12px] text-white disabled:opacity-50"
								>
									{busy ? "生成中…" : data.summary ? "重新生成" : "生成总结"}
								</button>
							}
						>
							文字总结
						</SectionTitle>
						{data.summary ? (
							<>
								<Md text={data.summary.text} />
								<div className="mt-3 text-[12px] text-muted">
									{data.summary.model.split("/").pop()} ·{" "}
									{new Date(data.summary.at * 1000).toLocaleString("zh-CN", {
										hour12: false,
										month: "2-digit",
										day: "2-digit",
										hour: "2-digit",
										minute: "2-digit",
									})}{" "}
									生成；只根据右边的汇总写
								</div>
							</>
						) : (
							<div className="py-6 text-center text-[13px] text-muted">
								还没生成。点「生成总结」让模型根据当天汇总写一段（约几千 tokens）
							</div>
						)}
					</Card>
					<Card className="p-4">
						<SectionTitle>当天汇总</SectionTitle>
						<Md text={data.markdown} />
					</Card>
				</div>
			)}
		</div>
	);
}
