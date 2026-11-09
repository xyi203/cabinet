import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { type StatsBucket, type StatsGroup, type StatsRange, fetchStats } from "../lib/api";
import { AGENT_NAME, date, hm, money } from "../lib/format";
import { Card, SectionTitle, Segmented, StatTile, compact, dur, pct } from "./ui";

const RANGES: Array<{ value: StatsRange; label: string }> = [
	{ value: "today", label: "今天" },
	{ value: "7d", label: "近 7 天" },
	{ value: "30d", label: "近 30 天" },
];

/** 运行的类型（档位）：给人看的叫法，队列页也用 */
export const TIER_NAME: Record<string, string> = {
	ack: "简短回应",
	answer: "一般回复",
	deep: "需要查证",
	mr: "MR 预审",
	task: "任务",
	patrol: "巡检",
	rewrite: "改写草稿",
	qa: "问答",
};
/** 11 月 6 日之前的运行没记模型和类型，后端记成「未记录 / 未知」 */
const EARLY = new Set(["未记录", "未知"]);
const EARLY_TIP = "11月6日之前的运行没有记下这一项";
/** 算作「用上了」的草稿结果，和后端命中率口径一致（stats.ts） */
const USED = new Set(["sent", "completed"]);
const PENDING = new Set(["pending", "noreply", "sending", "revising"]);

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

/** 纵轴三格取整：每格 1 / 2 / 5 × 10ⁿ，最小一分钱；不设上限，花费再大柱子也不会顶出图 */
function niceStep(max: number) {
	const raw = Math.max(max / 3, 0.01);
	const mag = 10 ** Math.floor(Math.log10(raw));
	return [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw - 1e-12) ?? 10 * mag;
}
const axisMoney = (v: number, step: number) => (v === 0 ? "$0" : step >= 1 ? `$${Math.round(v)}` : `$${v.toFixed(2)}`);

/** 一格是哪段时间：今天按小时写「09:00–10:00」，按天写日期 */
const bucketName = (b: StatsBucket, hourly: boolean) => (hourly ? `${hm(b.t)}–${hm(b.t + 3600)}` : date(b.t));

/** 花费柱状图：只有一个系列，用强调色；悬停看这一格的花费、运行次数和 tokens */
export function CostChart({ series, hourly, height = 180 }: { series: StatsBucket[]; hourly: boolean; height?: number }) {
	const [ref, width] = useWidth<HTMLDivElement>();
	const [hover, setHover] = useState<number | null>(null);
	const left = 48;
	const bottom = 24;
	const top = 8;
	const plotW = Math.max(0, width - left - 4);
	const plotH = height - top - bottom;
	const max = Math.max(...series.map((b) => b.cost), 0);
	const step = niceStep(max);
	const yMax = step * 3;
	const slot = series.length ? plotW / series.length : 0;
	const bw = Math.max(1, slot - 2);
	// 横轴标签按宽度隔几格写一个，窄屏不挤在一起
	const labelW = hourly ? 44 : 64;
	const every = (hourly ? [1, 2, 3, 4, 6, 12] : [1, 2, 3, 5, 7, 10, 15]).find((n) => n * slot >= labelW) ?? series.length;
	const tick = (b: StatsBucket) => (hourly ? hm(b.t) : date(b.t));
	const h = hover != null ? series[hover] : undefined;
	return (
		<div ref={ref} className="relative w-full" style={{ height }}>
			{width > 0 && (
				<svg width={width} height={height} className="block" role="img" aria-label="花费柱状图">
					{[0, 1, 2, 3].map((i) => {
						const y = top + plotH - (plotH * i) / 3;
						return (
							<g key={i}>
								<line x1={left} x2={width} y1={y} y2={y} stroke="var(--line)" strokeWidth={1} />
								<text x={left - 6} y={y + 4} textAnchor="end" fontSize={12} fill="var(--muted)" className="tabular-nums">
									{axisMoney(step * i, step)}
								</text>
							</g>
						);
					})}
					{series.map((b, i) => {
						const bh = (b.cost / yMax) * plotH;
						const x = left + i * slot + 1;
						return (
							<g key={b.t}>
								{bh > 0 && (
									<path
										d={bar(x, top + plotH - Math.max(bh, 1), bw, Math.max(bh, 1))}
										fill="var(--accent)"
										opacity={hover == null || hover === i ? 1 : 0.45}
									/>
								)}
								{i % every === 0 && (
									<text x={x + bw / 2} y={height - 6} textAnchor="middle" fontSize={12} fill="var(--muted)" className="tabular-nums">
										{tick(b)}
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
					className="pointer-events-none absolute top-1 z-10 flex flex-col gap-0.5 rounded-md border border-line bg-panel px-3 py-2 text-[12px] whitespace-nowrap text-text shadow-md"
					style={{ left: Math.min(Math.max(left + hover * slot + slot / 2 - 70, 0), Math.max(0, width - 160)) }}
				>
					<div className="font-semibold">{bucketName(h, hourly)}</div>
					<div className="tabular-nums">花费 {money(h.cost)}</div>
					<div className="text-muted tabular-nums">
						运行 {h.runs} 次{h.failed ? `，失败 ${h.failed} 次` : ""}
					</div>
					{h.tokens > 0 && <div className="text-muted tabular-nums">{compact(h.tokens)} tokens</div>}
				</div>
			)}
		</div>
	);
}

/** 拆分表：名字、次数、花费（带占比条）、平均用时 */
function GroupTable({
	title,
	col,
	rows,
	name = (n) => n,
}: {
	title: string;
	col: string;
	rows: StatsGroup[];
	name?: (n: string) => string;
}) {
	const max = Math.max(...rows.map((r) => r.cost), 0);
	const grid = "grid grid-cols-[minmax(0,1fr)_auto_minmax(96px,1fr)_auto] items-center gap-x-3";
	return (
		<Card className="p-4">
			<SectionTitle>{title}</SectionTitle>
			{rows.length ? (
				<div className="text-[14px]">
					<div className={`${grid} pb-1.5 text-[12px] text-muted`}>
						<span>{col}</span>
						<span className="text-right">次数</span>
						<span>花费</span>
						<span className="text-right" title="只算成功的运行">
							平均用时
						</span>
					</div>
					{rows.map((r) => {
						const early = EARLY.has(r.name);
						return (
							<div key={r.name} className={`${grid} border-t border-line py-1.5`}>
								<span className={`[overflow-wrap:anywhere] ${early ? "text-muted" : "text-text"}`} title={early ? EARLY_TIP : r.name}>
									{early ? "早期记录" : name(r.name)}
								</span>
								<span className="text-right text-text tabular-nums">
									{r.runs}
									{r.failed > 0 && <span className="block text-[12px] whitespace-nowrap text-bad">失败 {r.failed}</span>}
								</span>
								<span className="flex items-center gap-2">
									<span className="h-1.5 min-w-[24px] flex-1 overflow-hidden rounded-full bg-soft">
										<span className="block h-full rounded-full bg-accent" style={{ width: max ? `${(r.cost / max) * 100}%` : 0 }} />
									</span>
									<span className="w-[52px] text-right text-text tabular-nums">{money(r.cost)}</span>
								</span>
								<span className="text-right whitespace-nowrap text-muted tabular-nums">{r.seconds > 0 ? dur(r.seconds) : "—"}</span>
							</div>
						);
					})}
				</div>
			) : (
				<div className="text-[14px] text-muted">这段时间没有运行。</div>
			)}
		</Card>
	);
}

export function StatsPage() {
	const [range, setRange] = useState<StatsRange>("today");
	const { data: s, error } = useQuery({ queryKey: ["stats", range], queryFn: () => fetchStats(range), refetchInterval: 60_000 });
	const drafts = s?.drafts ?? [];
	const draftTotal = drafts.reduce((n, d) => n + d.count, 0);
	const draftMax = Math.max(...drafts.map((d) => d.count), 0);
	// 采用率：用上的（你发了、标为完成）÷ 已有结果的（还在等你的不算），和后端 hitRate 同一口径
	const used = drafts.filter((d) => USED.has(d.status)).reduce((n, d) => n + d.count, 0);
	const settled = drafts.filter((d) => !PENDING.has(d.status)).reduce((n, d) => n + d.count, 0);
	const hourly = range === "today";
	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
				<Segmented value={range} options={RANGES} onChange={setRange} />
				<span className="text-[12px] text-muted">花费按 API 价格折算；实际用的是订阅额度，不另收费</span>
			</div>
			{error && !s && <div className="text-[14px] text-bad">统计读取失败：{(error as Error).message}</div>}
			{s && (
				<>
					<div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
						<StatTile label="花费" value={money(s.total.cost)} sub={`${compact(s.total.tokens)} tokens`} />
						<StatTile
							label="运行次数"
							title="助手每起草、回答、做一次任务算一次"
							value={s.total.runs}
							sub={s.total.failed ? `失败 ${s.total.failed} 次` : "没有失败"}
						/>
						<StatTile
							label="草稿采用率"
							title="你发出或标为完成的草稿，占已有结果的草稿的比例；还在等你处理的不算"
							value={settled ? pct(used / settled) : "—"}
							sub={settled ? `${settled} 份里用上 ${used} 份` : "还没有结果"}
						/>
						<StatTile
							label="平均每次花费"
							value={s.total.runs ? money(s.total.cost / s.total.runs) : "—"}
							sub={s.total.runs ? `${compact(s.total.tokens / s.total.runs)} tokens` : "没有运行"}
						/>
					</div>
					<Card className="p-4">
						<SectionTitle extra={hourly ? "按小时" : "按天"}>花费</SectionTitle>
						{s.total.runs ? (
							<>
								<CostChart series={s.series} hourly={hourly} />
								<details className="mt-2 text-[12px]">
									<summary className="cursor-pointer text-muted">查看明细</summary>
									<table className="mt-2 w-full border-collapse text-[12px] tabular-nums">
										<thead>
											<tr className="text-left text-muted">
												<th className="pb-1 font-normal">时间</th>
												<th className="pb-1 text-right font-normal">运行</th>
												<th className="pb-1 text-right font-normal">tokens</th>
												<th className="pb-1 text-right font-normal">花费</th>
											</tr>
										</thead>
										<tbody>
											{s.series
												.filter((b) => b.runs)
												.map((b) => (
													<tr key={b.t} className="border-t border-line">
														<td className="py-1 text-muted">{bucketName(b, hourly)}</td>
														<td className="py-1 text-right">
															{b.runs} 次{b.failed ? <span className="text-bad">，失败 {b.failed}</span> : null}
														</td>
														<td className="py-1 text-right">{compact(b.tokens)}</td>
														<td className="py-1 text-right">{money(b.cost)}</td>
													</tr>
												))}
										</tbody>
									</table>
								</details>
							</>
						) : (
							<div className="text-[14px] text-muted">这段时间没有运行。</div>
						)}
					</Card>
					<div className="grid gap-3 xl:grid-cols-3">
						<GroupTable title="按助手" col="助手" rows={s.byAgent} name={(n) => AGENT_NAME[n] ?? n} />
						<GroupTable title="按类型" col="类型" rows={s.byTier} name={(n) => TIER_NAME[n] ?? n} />
						<GroupTable title="按模型" col="模型" rows={s.byModel} name={(n) => n.split("/").pop() ?? n} />
					</div>
					<Card className="p-4">
						<SectionTitle
							extra={
								draftTotal ? (
									<span className="inline-flex items-center gap-1.5">
										<span className="h-2 w-2 rounded-full bg-accent" aria-hidden />
										算作用上
									</span>
								) : undefined
							}
						>
							草稿结果
						</SectionTitle>
						{draftTotal ? (
							<div className="flex flex-col gap-1.5">
								{drafts.map((d) => (
									<div key={d.status} className="flex items-center gap-3 text-[14px]">
										<span className="w-[84px] shrink-0 text-text">{d.name}</span>
										<span className="h-2 flex-1 overflow-hidden rounded-full bg-soft">
											<span
												className={`block h-full rounded-full ${USED.has(d.status) ? "bg-accent" : "bg-muted opacity-40"}`}
												style={{ width: draftMax ? `${(d.count / draftMax) * 100}%` : 0 }}
											/>
										</span>
										<span className="w-[88px] shrink-0 text-right text-text tabular-nums">
											{d.count} 份<span className="ml-2 text-muted">{pct(d.count / draftTotal)}</span>
										</span>
									</div>
								))}
							</div>
						) : (
							<div className="text-[14px] text-muted">这段时间没有草稿。</div>
						)}
					</Card>
				</>
			)}
		</div>
	);
}
