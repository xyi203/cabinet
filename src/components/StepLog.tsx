import { useQuery } from "@tanstack/react-query";
import { type Step, type Task, fetchLog } from "../lib/api";
import { useLiveSteps } from "../lib/live";

/** 执行日志：运行中的任务用 SSE 推来的实时步骤，结束的从会话文件里取 */
export function StepLog({ task }: { task?: Task }) {
	const live = useLiveSteps(task?.runId);
	const { data, isLoading } = useQuery({
		queryKey: ["log", task?.session, task?.start, task?.end],
		queryFn: () => fetchLog(task!),
		enabled: Boolean(task?.session) && !live,
	});
	if (!task) return <div className="foot">没有对应的执行记录</div>;
	const steps = live ?? data;
	if (!steps && isLoading) return <div className="foot">加载中…</div>;
	if (!steps?.length)
		return (
			<div className="foot">
				{task.status === "todo" ? "还在排队，没开始执行" : live ? "已开始，等待第一步…" : "这次运行没有可展示的步骤"}
			</div>
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
					<span>+{Math.round(s.t - t0)}s</span>
					<b>回答</b>
				</div>
				<div className="say">{s.text}</div>
			</div>
		);
	return (
		<div className={`step${s.error ? " err" : ""}${live ? " live" : ""}`}>
			<div className="h">
				<span>+{Math.round(s.t - t0)}s</span>
				<b>{s.tool}</b>
				<span>{s.done ? `${(s.done - s.t).toFixed(1)}s` : "进行中"}</span>
				{s.error && <span>被拦截/出错</span>}
			</div>
			<code>{a.command ?? ([a.path, a.pattern].filter(Boolean).join("  ") || JSON.stringify(a))}</code>
			{s.result && <pre>{s.result}</pre>}
		</div>
	);
}
