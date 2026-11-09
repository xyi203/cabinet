// 新页面共用的小部件（Tailwind）：指标卡、额度条、分段切换、区块标题
import type { ReactNode } from "react";
import type { QuotaWindow } from "../lib/api";

const COMPACT = new Intl.NumberFormat("zh-CN", { notation: "compact", maximumSignificantDigits: 3 });
const PLAIN = new Intl.NumberFormat("zh-CN");
/** 大数按中文习惯：9,999、1.23万、37.9万、1400万、1.23亿（保留三位有效数字，不写 K、M） */
export const compact = (n: number) => (Math.abs(n) < 10_000 ? PLAIN.format(Math.round(n)) : COMPACT.format(Math.round(n)));

/** 一段时长：3 分钟、2 小时 5 分钟、1 天 4 小时 */
export function span(sec: number) {
	const s = Math.max(0, Math.round(sec));
	if (s < 3600) return `${Math.max(1, Math.round(s / 60))} 分钟`;
	const h = Math.floor(s / 3600);
	if (h < 24) {
		const m = Math.floor((s % 3600) / 60);
		return m ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
	}
	const d = Math.floor(h / 24);
	return h % 24 ? `${d} 天 ${h % 24} 小时` : `${d} 天`;
}

export const pct = (x: number) => `${Math.round(x * 100)}%`;

/** 耗时：不到 10 秒带一位小数，不到一分钟按秒，之后同 span */
export const dur = (sec: number) => (sec < 10 ? `${Math.max(0, sec).toFixed(1)} 秒` : sec < 60 ? `${Math.round(sec)} 秒` : span(sec));

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
	return <div className={`rounded-[10px] border border-line bg-panel ${className}`}>{children}</div>;
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
			<div className="mt-1 text-[20px] leading-tight font-semibold text-text tabular-nums">{value}</div>
			{sub != null && <div className="mt-1 text-[12px] text-muted">{sub}</div>}
		</Card>
	);
}

/** 额度用量：平时是强调色，快用完（80% 起）才变成警示色；轨道统一暖灰 */
function severity(u: number) {
	if (u >= 0.8) return { fill: "bg-warn", track: "bg-soft", text: "text-warn" };
	return { fill: "bg-accent", track: "bg-soft", text: "text-text" };
}

/** 一个额度窗口：标签、用量条、重置倒计时 */
export function QuotaMeter({ label, w, now, stale }: { label: string; w?: QuotaWindow; now: number; stale?: string }) {
	if (!w)
		return (
			<Card className="px-4 py-3">
				<div className="text-[12px] text-muted">{label}</div>
				<div className="mt-1 text-[20px] leading-tight font-semibold text-muted">—</div>
				<div className="mt-1 text-[12px] text-muted">暂时查不到</div>
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
			<div className={`mt-1 text-[20px] leading-tight font-semibold tabular-nums ${s.text}`}>{pct(w.utilization)}</div>
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
					className={`cursor-pointer rounded-md border-0 px-3 py-1 text-[14px] ${
						o.value === value ? "bg-accent-soft font-semibold text-accent" : "bg-transparent text-muted hover:text-text"
					}`}
				>
					{o.label}
				</button>
			))}
		</div>
	);
}
