import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type AgentStat, type DevTask, type State, createAgentTask, fetchRepos } from "../lib/api";
import { AGENT_NAME, ago, money } from "../lib/format";
import { type Msg, MsgLine } from "./Drawer";
import { ModelPicker } from "./ModelPicker";

// agent 任务按「需要谁动」分四列
const COLS: Array<{ name: string; match: (t: DevTask) => boolean }> = [
	{ name: "进行中", match: (t) => t.status === "running" || t.status === "pushing" },
	{ name: "待你看", match: (t) => t.status === "review" },
	{ name: "失败", match: (t) => t.status === "failed" },
	{ name: "已结束", match: (t) => ["pushed", "done", "discarded"].includes(t.status) },
];
const SUB: Record<string, string> = {
	running: "运行中",
	pushing: "推送中",
	review: "待你看",
	failed: "失败",
	pushed: "已提 MR",
	done: "已完成",
	discarded: "已放弃",
};

function AgentCard({ a, now }: { a: AgentStat; now: number }) {
	return (
		<div className="agent-card">
			<div className="head">
				<b>{AGENT_NAME[a.name] ?? a.name}</b>
				<span className={`pill ${a.running.length ? "pending" : ""}`}>{a.running.length ? `${a.running.length} 个运行中` : "空闲"}</span>
			</div>
			<div className="foot">
				{a.model.split("/").pop()} · {a.readOnly ? "只读" : "可写 worktree"}
				{a.manual ? " · 手动指派" : ""}
			</div>
			<div className="desc">{a.desc}</div>
			{a.running.map((r, i) => (
				<div key={i} className="foot">
					● {r.label}（{ago(now, r.started)}开始）
				</div>
			))}
			<div className="stats">
				今日 <b>{a.runs}</b> 次 · 失败 <b>{a.failed}</b> · <b>{money(a.cost)}</b>
			</div>
		</div>
	);
}

function NewTask({ agents, onCreated }: { agents: AgentStat[]; onCreated: (t: DevTask) => void }) {
	const qc = useQueryClient();
	const { data: repos } = useQuery({ queryKey: ["repos"], queryFn: fetchRepos });
	// 简单回应 agent 只用于代回复表情，不适合派活
	const choices = agents.filter((a) => a.name !== "chat");
	const [agent, setAgent] = useState(choices.find((a) => a.name === "ask")?.name ?? choices[0]?.name ?? "");
	const [request, setRequest] = useState("");
	const [repo, setRepo] = useState("");
	const [branch, setBranch] = useState("feature/");
	const [busy, setBusy] = useState(false);
	const [msg, setMsg] = useState<Msg>(null);
	const dev = agent === "dev";
	const conf = choices.find((a) => a.name === agent);
	// 默认用 agent 自己的配置；换 agent 时跟着换，除非已经手动改过
	const [pick, setPick] = useState<{ agent: string; model: string; thinking: string } | null>(null);
	const model = pick?.agent === agent ? pick.model : (conf?.model ?? "");
	const thinking = pick?.agent === agent ? pick.thinking : (conf?.thinking ?? "medium");
	async function submit() {
		if (!request.trim()) return setMsg({ text: "先写任务内容", bad: true });
		setBusy(true);
		try {
			const t = await createAgentTask({
				agent,
				request,
				repo: repo || (dev ? repos?.[0] : undefined),
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
				<select value={agent} onChange={(e) => setAgent(e.target.value)}>
					{choices.map((a) => (
						<option key={a.name} value={a.name}>
							{AGENT_NAME[a.name] ?? a.name}
						</option>
					))}
				</select>
				<select value={repo} onChange={(e) => setRepo(e.target.value)}>
					{!dev && <option value="">不限仓库（~/code）</option>}
					{repos?.map((r) => (
						<option key={r} value={r}>
							{r}
						</option>
					))}
				</select>
				{dev && <input value={branch} onChange={(e) => setBranch(e.target.value.trim())} placeholder="feature/xxx" />}
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
						? "要实现什么，例如：给 v1/comment/product-stats 加上和 v1/comment/list 一样的筛选参数（⌘↩ 提交）"
						: "要它查什么、看什么，例如：查一下 prod 上店铺 12345 最近一周的评论数（⌘↩ 提交）"
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

export function AgentBoard({ state, onOpen }: { state: State; onOpen: (id: string) => void }) {
	const [creating, setCreating] = useState(false);
	return (
		<>
			<div className="agent-cards">
				{state.agents.map((a) => (
					<AgentCard key={a.name} a={a} now={state.now} />
				))}
			</div>
			<div className="filters">
				<button className={creating ? "on" : undefined} onClick={() => setCreating(!creating)}>
					＋ 新建任务
				</button>
			</div>
			{creating && (
				<NewTask
					agents={state.agents}
					onCreated={(t) => {
						setCreating(false);
						onOpen(t.id);
					}}
				/>
			)}
			<div className="board">
				{COLS.map((col) => {
					const items = state.devTasks.filter(col.match);
					return (
						<div className="col" key={col.name}>
							<h2>
								{col.name}
								<span>{items.length}</span>
							</h2>
							<div className="lane">
								{items.map((t) => (
									<div key={t.id} className="tcard" onClick={() => onOpen(t.id)}>
										<div className="head">
											<span className="tag dev">{AGENT_NAME[t.agent] ?? t.agent}</span>
											<span>{SUB[t.status] ?? t.status}</span>
										</div>
										<div className="t">{t.title.replace(/\n/g, " ")}</div>
										<div className="foot2">
											<span>
												{t.agent === "dev" ? `${t.repo.split("/").pop()} · ${t.branch}` : t.repo ? t.repo.split("/").pop() : "~/code"}
											</span>
											<span>{ago(state.now, t.updated) + (t.usage?.cost ? ` · ${money(t.usage.cost)}` : "")}</span>
										</div>
									</div>
								))}
								{!items.length && (
									<div className="foot" style={{ padding: 8 }}>
										暂无
									</div>
								)}
							</div>
						</div>
					);
				})}
			</div>
		</>
	);
}
