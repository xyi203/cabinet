import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type DispatchSuspect, type State, fetchDispatch, post } from "../lib/api";
import { AGENT_NAME, STATUS, money } from "../lib/format";
import { confirmDialog } from "./Confirm";
import { toast } from "./Toast";
import { Card, SectionTitle, StatTile, dur, span } from "./ui";

const CHANNEL: Record<string, string> = { lark: "飞书", meego: "飞书项目", bot: "机器人", board: "看板", alert: "告警", cron: "定时" };
const OUTCOME: Record<string, string> = { ...STATUS, done: "完成", pushed: "已推送", rerouted: "改派", none: "不处理" };
const btn = "cursor-pointer rounded-md border border-line bg-panel px-2.5 py-1 text-[12px] text-text hover:bg-soft";
const time = (t: number) => new Date(t * 1000).toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" });

/** 分发：现在谁在跑、谁在排队、可疑的会话，以及最近每次分派去了哪、走完用了多久 */
export function DispatchPage({ state, onOpenDev }: { state: State; onOpenDev: (id: string) => void }) {
	const qc = useQueryClient();
	const { data: d, error } = useQuery({ queryKey: ["dispatch"], queryFn: fetchDispatch, refetchInterval: 5_000 });
	async function act(url: string, body: unknown, done: string) {
		try {
			await post(url, body);
			toast(done);
			void qc.invalidateQueries({ queryKey: ["dispatch"] });
			void qc.invalidateQueries({ queryKey: ["state"] });
		} catch (e) {
			toast((e as Error).message, true);
		}
	}
	const stop = async (key: string, label: string) => {
		if (
			await confirmDialog({
				title: "停止这次运行？",
				body: `${label}\n起草、问答会记成失败，之后可以重试；agent 任务会停在当前进度。`,
				confirmText: "停止",
			})
		)
			void act("/api/runs/stop", { key }, "已停止");
	};
	const onSuspect = (s: DispatchSuspect) => {
		if (!s.action) return;
		if (s.action.kind === "stop") void stop(s.action.ref, s.detail);
		else if (s.action.kind === "retry")
			void act(`/api/dev/${s.action.ref}/message`, { text: "上一轮失败了，接着把这个任务做完" }, "已让它接着做");
		else onOpenDev(s.action.ref);
	};
	if (error && !d) return <div className="text-[13px] text-bad">读取分发状态失败：{(error as Error).message}</div>;
	if (!d) return <div className="text-[13px] text-muted">加载中…</div>;
	const busy = d.queue.capacity - d.queue.free;
	return (
		<div className="flex flex-col gap-4">
			<div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
				<StatTile label="并发" value={`${busy} / ${d.queue.capacity}`} sub="同时跑的 agent 运行（MAX_CONCURRENCY）" />
				<StatTile label="排队等名额" value={d.queue.waiting} sub={d.queue.waiting ? "名额满了，在等前面的跑完" : "没有排队"} />
				<StatTile label="待起草" value={d.inflight.length} sub="消息已收到、草稿还没出来" />
				<StatTile label="可疑" value={d.suspects.length} sub={d.suspects.length ? "看下面的列表" : "一切正常"} />
			</div>
			{d.suspects.length > 0 && (
				<Card className="p-4">
					<SectionTitle extra="跑太久、排队太久、失败、看门狗发现的问题">可疑</SectionTitle>
					<div className="flex flex-col">
						{d.suspects.map((s) => (
							<div key={s.key} className="flex items-center gap-3 border-t border-line py-2 first:border-t-0">
								<span className="shrink-0 rounded bg-warn-soft px-1.5 py-0.5 text-[11px] text-warn">可疑</span>
								<span className="min-w-0 flex-1">
									<span className="block text-[13px] font-semibold text-text">{s.title}</span>
									<span className="block truncate text-[12px] text-muted">{s.detail}</span>
								</span>
								{s.action && (
									<button className={btn} onClick={() => onSuspect(s)}>
										{s.action.kind === "stop" ? "停止" : s.action.kind === "retry" ? "接着做" : "打开"}
									</button>
								)}
							</div>
						))}
					</div>
				</Card>
			)}
			<div className="grid gap-4 lg:grid-cols-2">
				<Card className="p-4">
					<SectionTitle extra={`${d.running.length} 个`}>运行中</SectionTitle>
					{d.running.length ? (
						d.running.map((r) => (
							<div key={r.key} className="flex items-center gap-3 border-t border-line py-2 first:border-t-0">
								<span className={`h-2 w-2 shrink-0 rounded-full ${r.suspicious ? "bg-warn" : "bg-ok"}`} />
								<span className="min-w-0 flex-1 truncate text-[13px] text-text">
									{r.label}
									<span className="ml-2 text-muted">{r.agent ? (AGENT_NAME[r.agent] ?? r.agent) : ""}</span>
								</span>
								<span className="shrink-0 text-[12px] text-muted tabular-nums">已跑 {span(d.now - r.started)}</span>
								<button className={btn} onClick={() => stop(r.key, r.label)}>
									停止
								</button>
							</div>
						))
					) : (
						<div className="py-4 text-center text-[13px] text-muted">没有在跑的</div>
					)}
				</Card>
				<Card className="p-4">
					<SectionTitle extra={`${d.inflight.length} 条`}>待起草</SectionTitle>
					{d.inflight.length ? (
						d.inflight.map((i) => (
							<div key={i.id} className="flex items-center gap-3 border-t border-line py-2 first:border-t-0">
								<span className="min-w-0 flex-1 truncate text-[13px] text-text">
									{i.label}
									<span className="ml-2 text-muted">{i.text}</span>
								</span>
								<span className="shrink-0 text-[12px] text-muted tabular-nums">等了 {span(d.now - i.since)}</span>
							</div>
						))
					) : (
						<div className="py-4 text-center text-[13px] text-muted">没有排队的消息</div>
					)}
				</Card>
			</div>
			<Card className="p-4">
				<SectionTitle>Agent</SectionTitle>
				<div className="grid gap-3 md:grid-cols-3">
					{state.agents.map((a) => (
						<div key={a.name} className="rounded-lg border border-line px-3 py-2.5">
							<div className="flex items-center gap-2">
								<b className="text-[13px] text-text">{AGENT_NAME[a.name] ?? a.name}</b>
								<span
									className={`ml-auto rounded px-1.5 py-0.5 text-[11px] ${a.running.length ? "bg-ok-soft text-ok" : "bg-soft text-muted"}`}
								>
									{a.running.length ? `${a.running.length} 个运行中` : "空闲"}
								</span>
							</div>
							<div className="mt-1 truncate text-[12px] text-muted" title={a.desc}>
								{a.model.split("/").pop()} · {a.readOnly ? "只读" : "可写 worktree"}
								{a.manual ? " · 手动指派" : ""}
							</div>
							<div className="mt-1 text-[12px] text-muted tabular-nums">
								今日 {a.runs} 次 · 失败 {a.failed} · {money(a.cost)}
							</div>
						</div>
					))}
				</div>
			</Card>
			<Card className="p-4">
				<SectionTitle extra="最近 50 次">最近分派</SectionTitle>
				<div className="overflow-x-auto">
					<table className="w-full min-w-[760px] border-collapse text-[12px]">
						<thead>
							<tr className="text-left text-muted">
								<th className="pb-1.5 font-normal">时间</th>
								<th className="pb-1.5 font-normal">来源</th>
								<th className="pb-1.5 font-normal">内容</th>
								<th className="pb-1.5 font-normal">分派给</th>
								<th className="pb-1.5 font-normal">结果</th>
								<th className="pb-1.5 text-right font-normal" title="从消息进来到结果落地">
									耗时
								</th>
							</tr>
						</thead>
						<tbody>
							{d.routes.map((r) => (
								<tr key={r.id} className="border-t border-line align-top">
									<td className="py-1.5 pr-3 whitespace-nowrap text-muted tabular-nums">{time(r.routed)}</td>
									<td className="py-1.5 pr-3 whitespace-nowrap text-text">
										{CHANNEL[r.channel] ?? r.channel}
										{r.actor ? <span className="text-muted"> · {r.actor}</span> : null}
									</td>
									<td className="max-w-[320px] truncate py-1.5 pr-3 text-text" title={r.text}>
										{r.text || "—"}
									</td>
									<td className="max-w-[260px] py-1.5 pr-3 text-text">
										<div className="truncate">
											{r.agent ? (AGENT_NAME[r.agent] ?? r.agent) : "不处理"}
											{r.tier ? <span className="text-muted"> · {r.tier}</span> : null}
										</div>
										<div className="truncate text-muted" title={r.rule}>
											{r.rule}
										</div>
									</td>
									<td className={`py-1.5 pr-3 whitespace-nowrap ${r.outcome === "failed" ? "text-bad" : "text-text"}`}>
										{r.outcome ? (OUTCOME[r.outcome] ?? r.outcome) : <span className="text-muted">进行中</span>}
									</td>
									<td className="py-1.5 text-right whitespace-nowrap text-muted tabular-nums">
										{r.settled && r.received ? dur(r.settled - r.received) : "—"}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</Card>
		</div>
	);
}
