import { useQuery } from "@tanstack/react-query";
import { type Step, type Task, fetchLog } from "../lib/api";
import { useLiveSteps } from "../lib/live";
import { dur } from "./ui";
import { Markdown } from "./Markdown";

/**
 * 执行日志：运行中的任务用 SSE 推来的实时步骤，结束的从会话记录里取。
 * 运行中途才打开的页面收不全实时步骤，也从会话记录里取，每 5 秒刷新一次直到跑完。
 */
export function StepLog({ task }: { task?: Task }) {
	const live = useLiveSteps(task?.runId);
	const { data, isLoading } = useQuery({
		queryKey: ["log", task?.session, task?.start, task?.end],
		queryFn: () => fetchLog(task!),
		enabled: Boolean(task?.session) && !live,
		refetchInterval: task?.runId && task.end == null ? 5000 : false,
	});
	if (!task) return <div className="foot">没有处理记录</div>;
	const steps = live ?? data;
	if (!steps && isLoading) return <div className="foot">加载中…</div>;
	if (!steps?.length)
		return (
			<div className="foot">{task.status === "todo" ? "还在排队，没有开始" : live ? "已开始，等第一步…" : "这次没有可展示的步骤"}</div>
		);
	const t0 = steps[0].t;
	return (
		<div className="log">
			{steps.map((s, i) => (
				<StepItem key={i} s={s} t0={t0} live={Boolean(live) && !s.done && s.kind === "call"} />
			))}
		</div>
	);
}

function StepItem({ s, t0, live }: { s: Step; t0: number; live: boolean }) {
	const a = s.args ?? {};
	if (s.kind === "text")
		return (
			<div className="step">
				<div className="h">
					<span className="num">{Math.round(s.t - t0)} 秒</span>
					<b>回答</b>
				</div>
				<Markdown text={s.text ?? ""} className="say" />
			</div>
		);
	return (
		<div className={`step${s.error ? " err" : ""}${live ? " live" : ""}`}>
			<div className="h">
				<span className="num">{Math.round(s.t - t0)} 秒</span>
				<b>{s.tool}</b>
				<span className="num">{s.done ? `用时 ${dur(s.done - s.t)}` : "进行中"}</span>
				{s.error && <span>被拦下或出错</span>}
			</div>
			<code>{a.command ?? ([a.path, a.pattern].filter(Boolean).join("  ") || JSON.stringify(a))}</code>
			{s.result && <pre>{s.result}</pre>}
		</div>
	);
}
