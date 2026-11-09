import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type DispatchSuspect, type State, fetchDispatch, post } from "../lib/api";
import { AGENT_NAME, STATUS, money, when } from "../lib/format";
import { confirmDialog } from "./Confirm";
import { TIER_NAME } from "./Stats";
import { toast } from "./Toast";
import { Card, SectionTitle, StatTile, dur, span } from "./ui";

const CHANNEL: Record<string, string> = { lark: "飞书", meego: "飞书项目", bot: "机器人", board: "看板", alert: "告警", cron: "定时" };
const OUTCOME: Record<string, string> = { ...STATUS, done: "完成", pushed: "已推送", rerouted: "改派", none: "不处理" };
const THINKING: Record<string, string> = { low: "低", medium: "中", high: "高", xhigh: "很高", max: "最高" };
/** 分派依据：去掉「分诊 answer：」这类内部前缀（类型已经单独显示），兜底换成人话 */
const reason = (rule: string) => (rule === "兜底" ? "没有匹配的规则，交给默认助手" : rule.replace(/^分诊 \w+：/, ""));
/** 助手说明里开头的「（手动指派）」括号去掉：说明本身已经讲清楚了 */
const desc = (s: string) => s.replace(/^（[^）]*）/, "");

/** 队列：现在谁在运行、谁在排队、需要留意的问题，以及最近每条消息分派给了谁、多久处理完 */
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
				body: `${label}\n起草和问答会记为失败，之后可以重试；任务会停在当前进度。`,
				confirmText: "停止",
			})
		)
			void act("/api/runs/stop", { key }, "已停止");
	};
	const onSuspect = (s: DispatchSuspect) => {
		if (!s.action) return;
		if (s.action.kind === "stop") void stop(s.action.ref, s.detail);
		else if (s.action.kind === "retry")
			void act(`/api/dev/${s.action.ref}/message`, { text: "上一轮失败了，接着把这个任务做完" }, "已重试");
		else onOpenDev(s.action.ref);
	};
	if (error && !d) return <div className="text-[14px] text-bad">队列读取失败：{(error as Error).message}</div>;
	if (!d) return <div className="text-[14px] text-muted">加载中…</div>;
	const cap = d.queue.capacity;
	const busy = cap - d.queue.free;
	const row = "flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-line py-2.5 first:border-t-0";
	return (
		<div className="flex flex-col gap-4">
			<div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
				<StatTile label="同时运行" value={`${busy} / ${cap}`} sub={d.queue.free > 0 ? `还能再开 ${d.queue.free} 个` : "已满，新的要排队"} />
				<StatTile label="排队" value={d.queue.waiting} sub={d.queue.waiting ? "在等前面的运行完" : "不用等"} />
				<StatTile label="待起草" value={d.inflight.length} sub="草稿还没写好" />
				<StatTile label="需要留意" value={d.suspects.length} sub={d.suspects.length ? "见下方" : "一切正常"} />
			</div>
			{d.suspects.length > 0 && (
				<Card className="p-4">
					<SectionTitle>需要留意</SectionTitle>
					<div className="flex flex-col">
						{d.suspects.map((s) => (
							<div key={s.key} className={row}>
								<span className="h-2 w-2 shrink-0 rounded-full bg-warn" aria-hidden />
								<span className="min-w-0 flex-1">
									<span className="block text-[14px] font-semibold text-text">{s.title}</span>
									<span className="block text-[12px] break-words text-muted">{s.detail}</span>
								</span>
								{s.action && (
									<button className="btn sm" onClick={() => onSuspect(s)}>
										{s.action.kind === "stop" ? "停止" : s.action.kind === "retry" ? "重试" : "查看"}
									</button>
								)}
							</div>
						))}
					</div>
				</Card>
			)}
			<div className="grid gap-4 lg:grid-cols-2">
				<Card className="p-4">
					<SectionTitle extra={d.running.length ? `${d.running.length} 个` : undefined}>正在运行</SectionTitle>
					{d.running.length ? (
						d.running.map((r) => (
							<div key={r.key} className={row}>
								<span className={`h-2 w-2 shrink-0 rounded-full ${r.suspicious ? "bg-warn" : "bg-ok"}`} aria-hidden />
								<span className="min-w-0 flex-1 truncate text-[14px] text-text" title={r.label}>
									{r.label}
									{r.agent && <span className="ml-2 text-muted">{AGENT_NAME[r.agent] ?? r.agent}</span>}
								</span>
								<span className="shrink-0 text-[12px] text-muted tabular-nums">已运行 {span(d.now - r.started)}</span>
								<button className="btn sm" onClick={() => stop(r.key, r.label)}>
									停止
								</button>
							</div>
						))
					) : (
						<div className="text-[14px] text-muted">没有正在运行的。</div>
					)}
				</Card>
				<Card className="p-4">
					<SectionTitle extra={d.inflight.length ? `${d.inflight.length} 条` : undefined}>待起草</SectionTitle>
					{d.inflight.length ? (
						d.inflight.map((i) => (
							<div key={i.id} className={row}>
								<span className="min-w-[200px] flex-1 truncate text-[14px] text-text" title={i.text}>
									{i.label}
									<span className="ml-2 text-muted">{i.text}</span>
								</span>
								<span className="shrink-0 text-[12px] text-muted tabular-nums">
									{i.waitUntil && i.waitUntil > d.now ? `你还在聊，${dur(i.waitUntil - d.now)}后起草` : `已等 ${span(d.now - i.since)}`}
								</span>
								<span className="flex shrink-0 gap-2">
									<button className="btn sm" onClick={() => act("/api/poll", { id: i.id }, "开始起草")}>
										现在起草
									</button>
									<button className="btn ghost sm" onClick={() => act("/api/drafts/dismiss", { id: i.id }, "这条不回复了")}>
										不回复
									</button>
								</span>
							</div>
						))
					) : (
						<div className="text-[14px] text-muted">没有等待起草的消息。</div>
					)}
				</Card>
			</div>
			<Card className="p-4">
				<SectionTitle>助手</SectionTitle>
				<div className="grid md:grid-cols-3 md:gap-x-6">
					{state.agents.map((a) => (
						<div key={a.name} className="flex flex-col gap-1 border-t border-line py-3 first:border-t-0 md:border-t-0 md:py-0">
							<div className="flex items-center gap-2">
								<span className="text-[14px] font-semibold text-text">{AGENT_NAME[a.name] ?? a.name}</span>
								<span className={`ml-auto text-[12px] ${a.running.length ? "text-ok" : "text-muted"}`}>
									{a.running.length ? `${a.running.length} 个在运行` : "空闲"}
								</span>
							</div>
							<div className="text-[12px] text-text-2">{desc(a.desc)}</div>
							<div className="flex flex-wrap gap-x-3 text-[12px] text-muted">
								<span>{a.model.split("/").pop()}</span>
								{a.thinking && <span>思考强度：{THINKING[a.thinking] ?? a.thinking}</span>}
								<span>{a.readOnly ? "只读" : "能改代码"}</span>
							</div>
							<div className="flex flex-wrap gap-x-3 text-[12px] text-muted tabular-nums">
								<span>今天运行 {a.runs} 次</span>
								{a.failed > 0 && <span className="text-bad">失败 {a.failed} 次</span>}
								<span>花费 {money(a.cost)}</span>
							</div>
						</div>
					))}
				</div>
			</Card>
			<Card className="p-4">
				<SectionTitle extra={`最近 ${d.routes.length} 条`}>最近分派</SectionTitle>
				<div className="text-[12px]">
					{/* 不够宽时一条占三行（时间来源 + 结果 / 内容 / 分派给）；够宽时一行四列 */}
					<div className="hidden grid-cols-[150px_minmax(0,1fr)_minmax(0,260px)_140px] gap-x-4 pb-1.5 text-muted xl:grid">
						<span>时间</span>
						<span>内容</span>
						<span>分派给</span>
						<span className="text-right" title="从消息进来到处理完">
							结果和用时
						</span>
					</div>
					{d.routes.map((r) => (
						<div
							key={r.id}
							className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 border-t border-line py-2 [grid-template-areas:'m_o''t_t''a_a'] xl:grid-cols-[150px_minmax(0,1fr)_minmax(0,260px)_140px] xl:[grid-template-areas:'m_t_a_o']"
						>
							<div className="flex flex-wrap gap-x-2 [grid-area:m] xl:flex-col">
								<span className="text-muted tabular-nums">{when(r.routed, d.now)}</span>
								<span className="text-text">
									{CHANNEL[r.channel] ?? r.channel}
									{r.actor && <span className="ml-1.5 text-muted">{r.actor}</span>}
								</span>
							</div>
							<div className="line-clamp-2 text-[14px] break-words text-text [grid-area:t] xl:truncate xl:text-[12px]" title={r.text}>
								{r.text || "—"}
							</div>
							<div className="min-w-0 [grid-area:a]">
								<div className="truncate text-text">
									{r.agent ? (AGENT_NAME[r.agent] ?? TIER_NAME[r.agent] ?? r.agent) : "不处理"}
									{r.tier && <span className="ml-1.5 text-muted">{TIER_NAME[r.tier] ?? r.tier}</span>}
								</div>
								<div className="truncate text-muted" title={reason(r.rule)}>
									{reason(r.rule)}
								</div>
							</div>
							<div className="flex justify-end gap-x-2 text-right whitespace-nowrap [grid-area:o]">
								<span className={r.outcome === "failed" ? "text-bad" : r.outcome ? "text-text" : "text-muted"}>
									{r.outcome ? (OUTCOME[r.outcome] ?? r.outcome) : "进行中"}
								</span>
								{r.settled && r.received ? (
									<span className="text-muted tabular-nums" title="从消息进来到处理完">
										<span className="xl:hidden">用时 </span>
										{dur(r.settled - r.received)}
									</span>
								) : null}
							</div>
						</div>
					))}
				</div>
			</Card>
		</div>
	);
}
