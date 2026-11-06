import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { type StatsBucket, type StatsGroup, type StatsRange, fetchStats } from "../lib/api";
import { AGENT_NAME, money } from "../lib/format";
import { Card, SectionTitle, Segmented, StatTile, compact, pct } from "./ui";

const RANGES: Array<{ value: StatsRange; label: string }> = [
	{ value: "today", label: "今天" },
	{ value: "7d", label: "7 天" },
	{ value: "30d", label: "30 天" },
];

const TIER_NAME: Record<string, string> = {
	ack: "寒暄（ack）",
	answer: "一般（answer）",
	deep: "查证据（deep）",
	mr: "MR 预审",
	task: "agent 任务",
	patrol: "巡检",
	rewrite: "改写草稿",
	qa: "问答",
};

/** 容器宽度：SVG 按实际像素画，字号不随缩放变形 */
function useWidth<T extends HTMLElement>() {
	const ref = useRef<T>(null);
	const [w, setW] = useState(0);
	useEffect(() => {
		if (!ref.current) return;
		const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
		ro.observe(ref.current);
		return () => ro.disconnect();
	}, []);
	return [ref, w] as const;
}

/** 顶部圆角、底部贴着基线的柱子 */
function bar(x: number, y: number, w: number, h: number) {
	const r = Math.min(4, w / 2, h);
	return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/** 消耗柱状图：单一系列（标题说明是什么），悬停看这一格的消耗、运行次数和 tokens */
export function CostChart({ series, height = 180 }: { series: StatsBucket[]; height?: number }) {
	const [ref, width] = useWidth<HTMLDivElement>();
	const [hover, setHover] = useState<number | null>(null);
	const left = 44;
	const bottom = 22;
	const top = 8;
	const plotW = Math.max(0, width - left - 4);
	const plotH = height - top - bottom;
	const max = Math.max(...series.map((b) => b.cost), 0);
	// 刻度取个整：0.01 / 0.05 / 0.1 / 0.5 / 1 …
	const steps = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100];
	const step = steps.find((s) => s * 3 >= max) ?? 200;
	const yMax = max > 0 ? step * 3 : 0.03;
	const slot = series.length ? plotW / series.length : 0;
	const bw = Math.max(1, slot - 2);
	const every = series.length > 24 ? 5 : series.length > 12 ? 3 : 1;
	const h = hover != null ? series[hover] : undefined;
	return (
		<div ref={ref} className="relative w-full" style={{ height }}>
			{width > 0 && (
				<svg width={width} height={height} className="block" role="img" aria-label="消耗柱状图">
					{[0, 1, 2, 3].map((i) => {
						const y = top + plotH - (plotH * i) / 3;
						return (
							<g key={i}>
								<line x1={left} x2={width} y1={y} y2={y} stroke="var(--line)" strokeWidth={1} />
								<text x={left - 6} y={y + 4} textAnchor="end" fontSize={11} fill="var(--muted)">
									{i === 0 ? "0" : money(step * i).replace(/\.?0+$/, "")}
								</text>
							</g>
						);
					})}
					{series.map((b, i) => {
						const bh = yMax ? (b.cost / yMax) * plotH : 0;
						const x = left + i * slot + 1;
						return (
							<g key={b.t}>
								{bh > 0 && (
									<path d={bar(x, top + plotH - bh, bw, bh)} fill="var(--accent)" opacity={hover == null || hover === i ? 1 : 0.45} />
								)}
								{i % every === 0 && (
									<text x={x + bw / 2} y={height - 6} textAnchor="middle" fontSize={11} fill="var(--muted)">
										{b.label}
									</text>
								)}
								{/* 命中区比柱子大：整列都能悬停 */}
								<rect
									x={left + i * slot}
									y={top}
									width={slot}
									height={plotH}
									fill="transparent"
									onMouseEnter={() => setHover(i)}
									onMouseLeave={() => setHover(null)}
								/>
							</g>
						);
					})}
				</svg>
			)}
			{h && hover != null && (
				<div
					className="pointer-events-none absolute top-1 z-10 rounded-lg border border-line bg-panel px-3 py-2 text-[12px] whitespace-nowrap text-text shadow-md"
					style={{ left: Math.min(Math.max(left + hover * slot + slot / 2 - 70, 0), Math.max(0, width - 150)) }}
				>
					<div className="font-semibold">{h.label}</div>
					<div className="tabular-nums">消耗 {money(h.cost)}</div>
					<div className="text-muted tabular-nums">
						{h.runs} 次运行{h.failed ? `（失败 ${h.failed}）` : ""} · {compact(h.tokens)} tokens
					</div>
				</div>
			)}
		</div>
	);
}

/** 拆分表：名字、次数、消耗（带同色的占比条）、平均耗时 */
function GroupTable({ title, rows, names }: { title: string; rows: StatsGroup[]; names?: Record<string, string> }) {
	const max = Math.max(...rows.map((r) => r.cost), 0);
	return (
		<Card className="p-4">
			<SectionTitle>{title}</SectionTitle>
			{rows.length ? (
				<table className="w-full border-collapse text-[13px]">
					<thead>
						<tr className="text-left text-[12px] text-muted">
							<th className="pb-1.5 font-normal">名称</th>
							<th className="pb-1.5 text-right font-normal">次数</th>
							<th className="w-[40%] pb-1.5 pl-3 font-normal">消耗</th>
							<th className="pb-1.5 text-right font-normal">平均耗时</th>
						</tr>
					</thead>
					<tbody>
						{rows.map((r) => (
							<tr key={r.name} className="border-t border-line">
								<td className="max-w-[160px] truncate py-1.5 text-text" title={r.name}>
									{names?.[r.name] ?? r.name}
								</td>
								<td className="py-1.5 text-right text-text tabular-nums">
									{r.runs}
									{r.failed ? <span className="ml-1 text-bad">({r.failed} 失败)</span> : null}
								</td>
								<td className="py-1.5 pl-3">
									<div className="flex items-center gap-2">
										<div className="h-1.5 flex-1 overflow-hidden rounded-full bg-accent-soft">
											<div className="h-full rounded-full bg-accent" style={{ width: max ? `${(r.cost / max) * 100}%` : 0 }} />
										</div>
										<span className="w-16 text-right text-text tabular-nums">{money(r.cost)}</span>
									</div>
								</td>
								<td className="py-1.5 text-right text-muted tabular-nums">{r.seconds ? `${Math.round(r.seconds)}s` : "—"}</td>
							</tr>
						))}
					</tbody>
				</table>
			) : (
				<div className="py-4 text-center text-[13px] text-muted">这段时间没有运行</div>
			)}
		</Card>
	);
}

export function StatsPage() {
	const [range, setRange] = useState<StatsRange>("today");
	const { data: s, error } = useQuery({ queryKey: ["stats", range], queryFn: () => fetchStats(range), refetchInterval: 60_000 });
	const draftTotal = s?.drafts.reduce((n, d) => n + d.count, 0) ?? 0;
	const draftMax = Math.max(...(s?.drafts.map((d) => d.count) ?? [0]), 0);
	return (
		<div className="flex flex-col gap-4">
			<div className="flex items-center gap-3">
				<Segmented value={range} options={RANGES} onChange={setRange} />
				<span className="text-[12px] text-muted">消耗按网关单价折算（订阅不另外收费，看的是额度占用）；11-06 之前的记录没有模型和档位</span>
			</div>
			{error && !s && <div className="text-[13px] text-bad">读取统计失败：{(error as Error).message}</div>}
			{s && (
				<>
					<div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
						<StatTile label="消耗" value={money(s.total.cost)} sub={`${compact(s.total.tokens)} tokens`} />
						<StatTile label="运行次数" value={s.total.runs} sub={s.total.failed ? `失败 ${s.total.failed} 次` : "没有失败"} />
						<StatTile
							label="草稿命中率"
							value={s.hitRate == null ? "—" : pct(s.hitRate)}
							sub={`${draftTotal} 份草稿`}
							title="草稿被用上（你发了、标记完成）占已有结果的比例；还在等你确认的不算"
						/>
						<StatTile
							label="平均每次"
							value={s.total.runs ? money(s.total.cost / s.total.runs) : "—"}
							sub={s.total.runs ? `${compact(s.total.tokens / s.total.runs)} tokens` : undefined}
						/>
					</div>
					<Card className="p-4">
						<SectionTitle extra={range === "today" ? "按小时" : "按天"}>消耗</SectionTitle>
						<CostChart series={s.series} />
						<details className="mt-2 text-[12px]">
							<summary className="cursor-pointer text-muted">按时间看明细</summary>
							<table className="mt-2 w-full border-collapse text-[12px]">
								<tbody>
									{s.series
										.filter((b) => b.runs)
										.map((b) => (
											<tr key={b.t} className="border-t border-line">
												<td className="py-1 text-muted">{b.label}</td>
												<td className="py-1 text-right tabular-nums">{b.runs} 次</td>
												<td className="py-1 text-right tabular-nums">{compact(b.tokens)} tokens</td>
												<td className="py-1 text-right tabular-nums">{money(b.cost)}</td>
											</tr>
										))}
								</tbody>
							</table>
						</details>
					</Card>
					<div className="grid gap-3 xl:grid-cols-3">
						<GroupTable title="按 agent" rows={s.byAgent} names={AGENT_NAME} />
						<GroupTable title="按档位" rows={s.byTier} names={TIER_NAME} />
						<GroupTable title="按模型" rows={s.byModel} />
					</div>
					<Card className="p-4">
						<SectionTitle extra={`${draftTotal} 份`}>草稿结果</SectionTitle>
						{s.drafts.length ? (
							<div className="flex flex-col gap-1.5">
								{s.drafts.map((d) => (
									<div key={d.status} className="flex items-center gap-3 text-[13px]">
										<span className="w-24 shrink-0 text-text">{d.name}</span>
										<div className="h-2 flex-1 overflow-hidden rounded-full bg-accent-soft">
											<div className="h-full rounded-full bg-accent" style={{ width: draftMax ? `${(d.count / draftMax) * 100}%` : 0 }} />
										</div>
										<span className="w-20 shrink-0 text-right text-text tabular-nums">
											{d.count} <span className="text-muted">({pct(d.count / draftTotal)})</span>
										</span>
									</div>
								))}
							</div>
						) : (
							<div className="py-4 text-center text-[13px] text-muted">这段时间没有草稿</div>
						)}
					</Card>
				</>
			)}
		</div>
	);
}
