import type { ReactNode } from "react";
import type { QuotaWindow } from "../lib/api";
import { pct, span } from "./ui";

/** 24 网格、1.5 描边的线描图标（照 komo 的图标集），只给图标栏用 */
const ICONS: Record<string, ReactNode> = {
	work: (
		<>
			<path d="M4 13h4l1.5 3h5L16 13h4" />
			<path d="M5.5 5h13L21 13v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5z" />
		</>
	),
	stories: (
		<>
			<rect x="3" y="4" width="18" height="16" rx="2" />
			<path d="M9 4v16M15 4v16" />
		</>
	),
	cron: (
		<>
			<circle cx="12" cy="12" r="9" />
			<path d="M12 7v5l3 2" />
		</>
	),
	memory: (
		<>
			<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z" />
			<path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12" />
		</>
	),
	agents: (
		<>
			<rect x="4" y="8" width="16" height="12" rx="3" />
			<path d="M12 4v4M9 13.5v1M15 13.5v1" />
		</>
	),
	ops: <path d="M3 12h4l3-8 4 16 3-8h4" />,
	settings: (
		<>
			<circle cx="12" cy="12" r="3" />
			<path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
		</>
	),
};

export type RailItem = { key: string; label: string; hint: string; badge?: number; badgeLabel?: string };

/**
 * 图标栏（照 komo）：印章、各页入口（图标 + 短字，等你处理的件数是琥珀角标），底部两个 Claude 用量环。
 * 窄屏（≤760）横过来排在顶上，用量环收起。
 */
export function Rail({
	items,
	current,
	onGo,
	quota,
	now,
}: {
	items: RailItem[];
	current: string;
	onGo: (key: string) => void;
	quota?: { five_hour?: QuotaWindow; seven_day?: QuotaWindow };
	now: number;
}) {
	return (
		<aside className="rail">
			<div className="seal" title="Cabinet" aria-hidden>
				阁
			</div>
			<nav className="rail-nav" aria-label="页面">
				{items.map((it) => {
					const on = it.key === current;
					return (
						<button
							key={it.key}
							className={`rail-btn${on ? " on" : ""}`}
							title={it.hint}
							aria-label={it.badge ? `${it.label}，${it.badgeLabel ?? `${it.badge} 件`}` : it.label}
							aria-current={on ? "page" : undefined}
							onClick={() => onGo(it.key)}
						>
							<svg viewBox="0 0 24 24" aria-hidden>
								{ICONS[it.key]}
							</svg>
							<span aria-hidden>{it.label}</span>
							{!!it.badge && (
								<b className="rail-n num" aria-hidden>
									{it.badge > 99 ? "99+" : it.badge}
								</b>
							)}
						</button>
					);
				})}
			</nav>
			{quota && (
				<div className="rail-quota">
					<QuotaRing label="5 小时" w={quota.five_hour} now={now} />
					<QuotaRing label="本周" w={quota.seven_day} now={now} />
				</div>
			)}
		</aside>
	);
}

/** Claude 用量：一个小环（照 komo 输入框下的上下文环），环里是百分比，80% 起变警示色；悬停看多久后重置 */
function QuotaRing({ label, w, now }: { label: string; w?: QuotaWindow; now: number }) {
	if (!w) return null;
	const u = Math.min(1, Math.max(0, w.utilization));
	const hot = u >= 0.8;
	const r = 12;
	const c = 2 * Math.PI * r;
	const reset = w.resetsAt ? `，${span(w.resetsAt - now)}后重置` : "";
	return (
		<div
			className={`ring${hot ? " hot" : ""}`}
			title={`Claude ${label}内已用 ${pct(u)}${reset}`}
			role="meter"
			aria-label={`Claude ${label}内已用`}
			aria-valuenow={Math.round(u * 100)}
			aria-valuemin={0}
			aria-valuemax={100}
		>
			<svg viewBox="0 0 30 30" aria-hidden>
				<circle cx="15" cy="15" r={r} className="track" />
				<circle cx="15" cy="15" r={r} className="fill" strokeDasharray={`${u * c} ${c}`} transform="rotate(-90 15 15)" />
			</svg>
			<b className="num">{Math.round(u * 100)}</b>
			<span>{label}</span>
		</div>
	);
}
