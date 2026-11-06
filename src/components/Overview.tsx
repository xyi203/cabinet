import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type InboxItem, type State, type Task, fetchStats } from "../lib/api";
import { money } from "../lib/format";
import { CostChart } from "./Stats";
import { Card, QuotaMeter, SectionTitle, StatTile, compact, pct, span } from "./ui";

export const INBOX_KIND: Record<InboxItem["kind"], string> = {
	approval: "审批",
	draft: "草稿",
	failure: "失败",
	dev: "任务",
	memory: "记忆",
	watch: "系统",
};
const TYPE: Record<Task["type"], string> = { draft: "草稿", qa: "问答", dev: "任务" };
const hot = (it: InboxItem) => it.kind === "failure" || it.kind === "watch" || it.kind === "approval";

/** 概览：先看额度和消耗、有没有事在等你，再看最近发生了什么 */
export function Overview({
	state,
	onOpenInbox,
	onOpenTask,
}: {
	state: State;
	onOpenInbox: (it: InboxItem) => void;
	onOpenTask: (t: Task) => void;
}) {
	const { data: today } = useQuery({ queryKey: ["stats", "today"], queryFn: () => fetchStats("today"), refetchInterval: 60_000 });
	const { data: week } = useQuery({ queryKey: ["stats", "7d"], queryFn: () => fetchStats("7d"), refetchInterval: 300_000 });
	const q = state.quota;
	const stale = q?.error ? `最近一次查询失败：${q.error}` : q && state.now - q.at > 30 * 60 ? "超过 30 分钟没更新" : undefined;
	const inbox = state.inbox;
	const feed = state.tasks.toSorted((a, b) => (b.end ?? b.start ?? b.created) - (a.end ?? a.start ?? a.created)).slice(0, 12);
	return (
		<div className="flex flex-col gap-4">
			<div className="grid grid-cols-2 gap-3 md:grid-cols-3 2xl:grid-cols-6">
				<StatTile
					label="今日消耗"
					value={money(today?.total.cost ?? state.stats.usage.cost)}
					sub={today ? `${compact(today.total.tokens)} tokens · ${today.total.runs} 次运行` : undefined}
					title="按网关单价折算；订阅不另外收费，看的是额度占用"
				/>
				<QuotaMeter label="Claude 5 小时额度" w={q?.windows.five_hour} now={state.now} stale={stale} />
				<QuotaMeter label="Claude 7 天额度" w={q?.windows.seven_day} now={state.now} stale={stale} />
				<StatTile label="进行中" value={state.running + state.inflight} sub={`${state.running} 个运行 · ${state.inflight} 条待起草`} />
				<StatTile label="待确认草稿" value={state.stats.pending} sub={`今天进来 ${state.stats.requests} 条`} />
				<StatTile
					label="草稿命中率（7 天）"
					value={week?.hitRate == null ? "—" : pct(week.hitRate)}
					sub="你发了或标记完成的比例"
					title="草稿被用上（你发了、标记完成）占已有结果的比例；还在等你确认的不算"
				/>
			</div>
			<div className="grid gap-4 lg:grid-cols-2">
				<Card className="p-4">
					<SectionTitle
						extra={
							<Link to="/" search={{ view: "todo" }} className="text-accent no-underline">
								全部 {inbox.length} →
							</Link>
						}
					>
						等你处理
					</SectionTitle>
					{inbox.length ? (
						<div className="flex flex-col">
							{inbox.slice(0, 7).map((it) => (
								<button
									key={`${it.kind}-${it.ref}`}
									type="button"
									onClick={() => onOpenInbox(it)}
									className="flex w-full cursor-pointer items-center gap-2 border-0 border-t border-line bg-transparent px-0 py-2 text-left first:border-t-0 hover:bg-soft"
								>
									<span
										className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] ${hot(it) ? "bg-bad-soft text-bad" : "bg-accent-soft text-accent"}`}
									>
										{INBOX_KIND[it.kind]}
									</span>
									<span className="min-w-0 flex-1 truncate text-[13px] text-text">
										{it.why}
										<span className="ml-2 text-muted">{it.title.slice(0, 80)}</span>
									</span>
									<span className="shrink-0 text-[12px] text-muted tabular-nums">等了 {span(state.now - it.at)}</span>
								</button>
							))}
						</div>
					) : (
						<div className="py-6 text-center text-[13px] text-muted">没有等你处理的事</div>
					)}
				</Card>
				<Card className="p-4">
					<SectionTitle
						extra={
							<Link to="/" search={{ view: "tasks" }} className="text-accent no-underline">
								全部任务 →
							</Link>
						}
					>
						最近动态
					</SectionTitle>
					<div className="flex flex-col">
						{feed.map((t) => (
							<button
								key={t.id}
								type="button"
								onClick={() => onOpenTask(t)}
								className="flex w-full cursor-pointer items-center gap-2 border-0 border-t border-line bg-transparent px-0 py-2 text-left first:border-t-0 hover:bg-soft"
							>
								<span className="shrink-0 rounded bg-soft px-1.5 py-0.5 text-[11px] text-muted">{TYPE[t.type]}</span>
								<span className="min-w-0 flex-1 truncate text-[13px] text-text">
									{t.title}
									<span className="ml-2 text-muted">{t.label}</span>
								</span>
								<span className={`shrink-0 text-[12px] ${t.status === "blocked" ? "text-bad" : "text-muted"}`}>{t.sub}</span>
								<span className="w-14 shrink-0 text-right text-[12px] text-muted tabular-nums">
									{span(state.now - (t.end ?? t.start ?? t.created))}前
								</span>
							</button>
						))}
						{!feed.length && <div className="py-6 text-center text-[13px] text-muted">还没有动态</div>}
					</div>
				</Card>
			</div>
			{today && (
				<Card className="p-4">
					<SectionTitle
						extra={
							<Link to="/" search={{ view: "stats" }} className="text-accent no-underline">
								看统计 →
							</Link>
						}
					>
						今天每小时消耗
					</SectionTitle>
					<CostChart series={today.series} height={140} />
				</Card>
			)}
		</div>
	);
}
