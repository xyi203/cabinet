import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type AgentStat, type DevTask, createAgentTask, fetchRepos } from "../lib/api";
import { AGENT_NAME } from "../lib/format";
import { type Msg, MsgLine } from "./Drawer";
import { ModelPicker } from "./ModelPicker";

/** 新建 agent 任务：选 agent、仓库、模型，写要做什么 */
export function NewTask({ agents, onCreated }: { agents: AgentStat[]; onCreated: (t: DevTask) => void }) {
	const qc = useQueryClient();
	const { data: repos } = useQuery({ queryKey: ["repos"], queryFn: fetchRepos });
	// 简单回应 agent 只用于代回复表情，不适合派活
	const choices = agents;
	const [agent, setAgent] = useState(choices.find((a) => a.name === "assistant")?.name ?? choices[0]?.name ?? "");
	const [request, setRequest] = useState("");
	const [repo, setRepo] = useState("");
	const [branch, setBranch] = useState("");
	const [busy, setBusy] = useState(false);
	const [msg, setMsg] = useState<Msg>(null);
	const dev = agent === "dev";
	const conf = choices.find((a) => a.name === agent);
	// 默认用 agent 自己的配置；换 agent 时跟着换，除非已经手动改过
	const [pick, setPick] = useState<{ agent: string; model: string; thinking: string } | null>(null);
	const model = pick?.agent === agent ? pick.model : (conf?.model ?? "");
	const thinking = pick?.agent === agent ? pick.thinking : (conf?.thinking ?? "medium");
	async function submit() {
		if (!request.trim()) return setMsg({ text: "先写下要做什么", bad: true });
		// 不替开发任务预选仓库：按最近修改排的第一个只是碰巧
		if (dev && !repo) return setMsg({ text: "开发任务要选仓库", bad: true });
		setBusy(true);
		try {
			const t = await createAgentTask({
				agent,
				request,
				repo: repo || undefined,
				branch: dev ? branch : undefined,
				model,
				thinking,
			});
			qc.invalidateQueries({ queryKey: ["state"] });
			setRequest("");
			setMsg(null);
			onCreated(t);
		} catch (e) {
			setMsg({ text: (e as Error).message, bad: true });
		} finally {
			setBusy(false);
		}
	}
	return (
		<div className="panel newtask">
			<div className="row">
				<select value={agent} aria-label="交给谁" onChange={(e) => setAgent(e.target.value)}>
					{choices.map((a) => (
						<option key={a.name} value={a.name}>
							{AGENT_NAME[a.name] ?? a.name}
						</option>
					))}
				</select>
				<select value={repo} aria-label="仓库" onChange={(e) => setRepo(e.target.value)}>
					<option value="">{dev ? "选仓库" : "不指定仓库"}</option>
					{repos?.map((r) => (
						<option key={r} value={r}>
							{r}
						</option>
					))}
				</select>
				{dev && (
					<input value={branch} aria-label="分支" onChange={(e) => setBranch(e.target.value.trim())} placeholder="分支，留空会自动起名" />
				)}
			</div>
			<div className="row">
				<ModelPicker model={model} thinking={thinking} onChange={(m, t) => setPick({ agent, model: m, thinking: t })} />
			</div>
			<textarea
				value={request}
				onChange={(e) => setRequest(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
				}}
				placeholder={
					dev
						? "要改什么，例如：给 v1/comment/product-stats 加上和 v1/comment/list 一样的筛选参数（⌘↩ 交给它）"
						: "要它查什么，例如：查一下 prod 上店铺 12345 最近一周的评论数（⌘↩ 交给它）"
				}
			/>
			<div className="row">
				<button className="btn primary" disabled={busy} onClick={submit}>
					交给{AGENT_NAME[agent] ?? agent}
				</button>
				<span className="foot">{choices.find((a) => a.name === agent)?.desc}</span>
			</div>
			<MsgLine msg={msg} />
		</div>
	);
}
