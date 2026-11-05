import { useState } from "react";
import type { State, Task } from "../lib/api";
import { AGENT_NAME, ago, money } from "../lib/format";

// 借鉴 multica：6 个状态归入 4 列
const COLS: Array<{ name: string; groups: Array<[string, string, string]> }> = [
	{ name: "未开始", groups: [["todo", "待办", "○"]] },
	{ name: "工作中", groups: [["in_progress", "进行中", "◐"]] },
	{
		name: "需介入",
		groups: [
			["in_review", "审核中", "◉"],
			["blocked", "已阻塞", "⊘"],
		],
	},
	{
		name: "已结束",
		groups: [
			["done", "已完成", "✓"],
			["cancelled", "已取消", "✕"],
		],
	},
];
const FILTERS: Array<[string, string]> = [
	["all", "全部"],
	["p2p", "私聊我的"],
	["at", "群里 @我"],
	["meego", "飞书项目"],
	["dev", "开发"],
	["qa", "问答"],
];

function pass(filter: string, t: Task) {
	if (filter === "all") return true;
	if (filter === "qa") return t.type === "qa";
	if (filter === "dev") return t.type === "dev";
	if (t.type !== "draft") return false;
	return filter === "at" ? !["p2p", "meego"].includes(t.chatMode ?? "") : t.chatMode === filter;
}

function TaskCard({ t, now, onOpen }: { t: Task; now: number; onOpen: (t: Task) => void }) {
	return (
		<div className="tcard" onClick={() => onOpen(t)}>
			<div className="head">
				<span>
					<span className={`tag ${t.type}`}>
						{t.type === "dev"
							? t.agent && t.agent !== "dev"
								? "Agent"
								: "开发"
							: t.chatMode === "meego"
								? "飞书项目"
								: t.type === "draft"
									? "草稿"
									: "问答"}
					</span>
					{t.agent && t.agent !== "dev" && (
						<>
							{" "}
							<span className="tag agent" title={t.route ?? ""}>
								{AGENT_NAME[t.agent] ?? t.agent}
							</span>
						</>
					)}
				</span>
				<span>{t.sub}</span>
			</div>
			<div className="t">{t.title.replace(/\n/g, " ")}</div>
			<div className="foot2">
				<span>{t.label}</span>
				<span>{ago(now, t.created) + (t.usage?.cost ? ` · ${money(t.usage.cost)}` : "")}</span>
			</div>
		</div>
	);
}

export function Board({ state, onOpen }: { state: State; onOpen: (t: Task) => void }) {
	const [filter, setFilter] = useState(() => {
		try {
			return localStorage.getItem("filter") ?? "all";
		} catch {
			return "all";
		}
	});
	const [collapsed, setCollapsed] = useState(() => new Set(["cancelled"]));
	const tasks = state.tasks.filter((t) => pass(filter, t));
	const choose = (k: string) => {
		setFilter(k);
		try {
			localStorage.setItem("filter", k);
		} catch {}
	};
	const toggle = (k: string) =>
		setCollapsed((s) => {
			const n = new Set(s);
			if (n.has(k)) n.delete(k);
			else n.add(k);
			return n;
		});
	return (
		<>
			<div className="filters">
				{FILTERS.map(([k, name]) => (
					<button key={k} className={k === filter ? "on" : undefined} onClick={() => choose(k)}>
						{name}
					</button>
				))}
				<span className="live">● {state.running + state.inflight} 个任务进行中</span>
			</div>
			<div className="board">
				{COLS.map((col) => {
					const items = tasks.filter((t) => col.groups.some((g) => g[0] === t.status));
					return (
						<div className="col" key={col.name}>
							<h2>
								{col.name}
								<span>{items.length}</span>
							</h2>
							<div className="lane">
								{col.groups.map(([key, name, icon]) => {
									const list = items.filter((t) => t.status === key);
									const open = !collapsed.has(key);
									return (
										<div key={key}>
											<div className="grp" onClick={() => toggle(key)}>
												<span className="caret">{open ? "▾" : "▸"}</span>
												<span className={`ico ${key}`}>{icon}</span>
												<b>{name}</b>
												{list.length}
											</div>
											{open && list.map((t) => <TaskCard key={t.id} t={t} now={state.now} onOpen={onOpen} />)}
										</div>
									);
								})}
							</div>
						</div>
					);
				})}
			</div>
		</>
	);
}
