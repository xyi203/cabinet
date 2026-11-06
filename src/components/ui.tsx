// 新页面共用的小部件（Tailwind）：指标卡、额度条、分段切换、区块标题
import type { ReactNode } from "react";
import type { QuotaWindow } from "../lib/api";

/** 12.9K / 3.4M / 1.2B */
export function compact(n: number) {
	const a = Math.abs(n);
	if (a >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
	if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
	if (a >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
	return String(Math.round(n));
}

/** 等了多久 / 还有多久：3m、2h05m、1d04h */
export function span(sec: number) {
	const s = Math.max(0, Math.round(sec));
	if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
	const h = Math.floor(s / 3600);
	if (h < 24) return `${h}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
	return `${Math.floor(h / 24)}d${String(h % 24).padStart(2, "0")}h`;
}

export const pct = (x: number) => `${Math.round(x * 100)}%`;

/** 耗时：不到一分钟按秒，之后同 span */
export const dur = (sec: number) => (sec < 60 ? `${Math.max(0, Math.round(sec))}s` : span(sec));

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
	return <div className={`rounded-xl border border-line bg-panel ${className}`}>{children}</div>;
}

export function SectionTitle({ children, extra }: { children: ReactNode; extra?: ReactNode }) {
	return (
		<div className="mb-2 flex items-center gap-2">
			<h2 className="m-0 text-[14px] font-semibold text-text">{children}</h2>
			<div className="ml-auto text-[12px] text-muted">{extra}</div>
		</div>
	);
}

/** 指标卡：标签、数值、补充说明 */
export function StatTile({ label, value, sub, title }: { label: string; value: ReactNode; sub?: ReactNode; title?: string }) {
	return (
		<Card className="px-4 py-3">
			<div className="text-[12px] text-muted" title={title}>
				{label}
			</div>
			<div className="mt-1 text-[22px] leading-tight font-semibold text-text tabular-nums">{value}</div>
			{sub != null && <div className="mt-1 truncate text-[12px] text-muted">{sub}</div>}
		</Card>
	);
}

/** 额度窗口的严重程度：填充色随用量变（主色 → 警告 → 危险），轨道用同色更浅的一档 */
function severity(u: number) {
	if (u >= 0.8) return { fill: "bg-bad", track: "bg-bad-soft", text: "text-bad" };
	if (u >= 0.6) return { fill: "bg-warn", track: "bg-warn-soft", text: "text-warn" };
	return { fill: "bg-accent", track: "bg-accent-soft", text: "text-text" };
}

/** 一个额度窗口：标签、用量条、重置倒计时 */
export function QuotaMeter({ label, w, now, stale }: { label: string; w?: QuotaWindow; now: number; stale?: string }) {
	if (!w)
		return (
			<Card className="px-4 py-3">
				<div className="text-[12px] text-muted">{label}</div>
				<div className="mt-1 text-[22px] leading-tight font-semibold text-muted">—</div>
				<div className="mt-1 text-[12px] text-muted">还没查到</div>
			</Card>
		);
	const s = severity(w.utilization);
	return (
		<Card className="px-4 py-3">
			<div className="flex items-center text-[12px] text-muted">
				{label}
				{stale && (
					<span className="ml-auto text-warn" title={stale}>
						数据可能过时
					</span>
				)}
			</div>
			<div className={`mt-1 text-[22px] leading-tight font-semibold tabular-nums ${s.text}`}>{pct(w.utilization)}</div>
			<div
				className={`mt-2 h-2 overflow-hidden rounded-full ${s.track}`}
				role="meter"
				aria-label={label}
				aria-valuenow={Math.round(w.utilization * 100)}
				aria-valuemin={0}
				aria-valuemax={100}
			>
				<div className={`h-full rounded-full ${s.fill}`} style={{ width: `${Math.min(100, w.utilization * 100)}%` }} />
			</div>
			<div className="mt-1.5 text-[12px] text-muted">{w.resetsAt ? `${span(w.resetsAt - now)} 后重置` : "重置时间未知"}</div>
		</Card>
	);
}

/** 分段切换（范围、页签） */
export function Segmented<T extends string>({
	value,
	options,
	onChange,
}: {
	value: T;
	options: Array<{ value: T; label: ReactNode }>;
	onChange: (v: T) => void;
}) {
	return (
		<div className="inline-flex rounded-lg border border-line bg-panel p-0.5">
			{options.map((o) => (
				<button
					key={o.value}
					type="button"
					onClick={() => onChange(o.value)}
					className={`cursor-pointer rounded-md border-0 px-3 py-1 text-[13px] ${
						o.value === value ? "bg-accent-soft font-semibold text-accent" : "bg-transparent text-muted hover:text-text"
					}`}
				>
					{o.label}
				</button>
			))}
		</div>
	);
}
