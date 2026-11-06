import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type ArmScore, type Classification, type Memory, addMemory, fetchMemory, memoryAction, resolveMemories, searchMemory } from "../lib/api";
import { time } from "../lib/format";
import { type Msg, MsgLine } from "./Drawer";

const KIND: Record<Memory["kind"], string> = { preference: "偏好", fact: "事实", experience: "经验" };
const PROVENANCE: Record<Memory["provenance"], string> = {
	user_statement: "你的原话",
	tool_observation: "工具结果",
	model_inference: "模型推断",
};
const EVIDENCE: Record<string, string> = { yi: "你说", tool: "工具", board: "看板", message: "材料" };

// 有争议的排最前：等你裁定之前它们不会被带进对话
const GROUPS: Array<{ name: string; hint: string; match: (m: Memory) => boolean; open: boolean }> = [
	{
		name: "有争议",
		hint: "互相冲突，暂停使用；选一条为准，或者改写、合并成最终版本再确认，其余转为已取代",
		match: (m) => m.state === "contested",
		open: true,
	},
	{
		name: "长期约定",
		hint: "条件成立时直接照做，每次都带",
		match: (m) => m.state === "active" && m.application === "convention",
		open: true,
	},
	{
		name: "线索",
		hint: "和当前消息相关、过了门槛才带；只作参考",
		match: (m) => m.state === "active" && m.application === "reference",
		open: true,
	},
	{ name: "候选", hint: "模型推断的，确认或改分类后才生效", match: (m) => m.state === "candidate", open: true },
	{
		name: "已遗忘 / 已取代",
		hint: "不再使用；遗忘的同一句话不会被重新提取",
		match: (m) => m.state === "forgotten" || m.state === "superseded",
		open: false,
	},
];

const fmt = (n?: number) => (n === undefined ? "未命中" : n.toFixed(3));

function ClassifyForm({ init, onSubmit, submitText }: { init: Classification; onSubmit: (c: Classification) => void; submitText: string }) {
	const [c, setC] = useState(init);
	return (
		<div className="row">
			<select value={c.kind} onChange={(e) => setC({ ...c, kind: e.target.value as Classification["kind"] })}>
				{Object.entries(KIND).map(([k, v]) => (
					<option key={k} value={k}>
						{v}
					</option>
				))}
			</select>
			<select value={c.application} onChange={(e) => setC({ ...c, application: e.target.value as Classification["application"] })}>
				<option value="reference">线索</option>
				<option value="convention">长期约定</option>
			</select>
			{c.application === "convention" && (
				<input
					className="grow"
					value={c.appliesWhen}
					onChange={(e) => setC({ ...c, appliesWhen: e.target.value })}
					placeholder="什么时候适用，例如：回复 PM 关于排期的问题时"
				/>
			)}
			<button className="btn" onClick={() => onSubmit(c)}>
				{submitText}
			</button>
		</div>
	);
}

function MemoryCard({ m, score, onError }: { m: Memory; score?: ArmScore; onError: (msg: Msg) => void }) {
	const qc = useQueryClient();
	const [busy, setBusy] = useState(false);
	const [editing, setEditing] = useState(false);
	const [text, setText] = useState<string | null>(null);
	async function act(action: "confirm" | "forget" | "restore" | "classify" | "edit", extra?: Classification | { content: string }) {
		setBusy(true);
		try {
			await memoryAction(m, action, extra);
			setEditing(false);
			setText(null);
			onError(null);
			qc.invalidateQueries({ queryKey: ["memory"] });
		} catch (e) {
			onError({ text: (e as Error).message, bad: true });
		} finally {
			setBusy(false);
		}
	}
	const live = m.state !== "forgotten" && m.state !== "superseded";
	return (
		<div className="card memory">
			{text === null ? (
				<div className="body">{m.content}</div>
			) : (
				<>
					<textarea value={text} onChange={(e) => setText(e.target.value)} />
					<div className="row">
						<button className="btn primary" disabled={busy || !text.trim()} onClick={() => act("edit", { content: text })}>
							保存文字
						</button>
						<button className="btn" disabled={busy} onClick={() => setText(null)}>
							取消
						</button>
						<span className="foot">改过的算你的原话、已确认；有争议的改完还要在下面裁定</span>
					</div>
				</>
			)}
			{m.application === "convention" && <div className="foot">适用：{m.appliesWhen}</div>}
			<div className="meta">
				<span className="tag">{KIND[m.kind]}</span>
				<span>{PROVENANCE[m.provenance]}</span>
				<span>{m.confirmed ? "已确认" : "未确认"}</span>
				{m.scope !== "personal" && <span className="tag">限 {m.scopeName || m.scope}</span>}
				<span>带过 {m.injected} 次</span>
				<span>{time(m.updated)}</span>
				<span>
					#{m.id}·v{m.revision}
				</span>
				{m.conflicts.length > 0 && <span className="tag warn">与 {m.conflicts.map((x) => `#${x}`).join("、")} 冲突</span>}
				{m.supersededBy && <span>被 #{m.supersededBy} 取代</span>}
				{score && (
					<span className="tag" title="关键词对照 MEMORY_MIN_KEYWORD，余弦对照 MEMORY_MIN_SIMILARITY">
						关键词 {fmt(score.keyword)} · 余弦 {fmt(score.vector)} · {score.passed ? "过门槛" : "未过门槛"}
					</span>
				)}
			</div>
			{m.evidence.length > 0 && (
				<details className="evidence">
					<summary>依据 {m.evidence.length} 条</summary>
					{m.evidence.map((e, i) => (
						<div key={i} className="foot">
							{EVIDENCE[e.kind] ?? e.kind} · {time(e.at)}：{e.quote}
						</div>
					))}
				</details>
			)}
			{editing && (
				<ClassifyForm
					init={{ kind: m.kind, application: m.application, appliesWhen: m.appliesWhen }}
					onSubmit={(c) => act("classify", c)}
					submitText="保存分类"
				/>
			)}
			<div className="row">
				{live && !m.confirmed && (
					<button className="btn" disabled={busy} onClick={() => act("confirm")}>
						确认
					</button>
				)}
				{m.state === "contested" && m.confirmed && (
					<button className="btn" disabled={busy} onClick={() => act("confirm")}>
						以这条为准
					</button>
				)}
				{live && text === null && (
					<button className="btn" disabled={busy} onClick={() => setText(m.content)}>
						改文字
					</button>
				)}
				{live && (
					<button className="btn" disabled={busy} onClick={() => setEditing(!editing)}>
						{editing ? "取消" : "改分类"}
					</button>
				)}
				{live ? (
					<button className="btn danger" disabled={busy} onClick={() => act("forget")}>
						遗忘
					</button>
				) : (
					<button className="btn" disabled={busy} onClick={() => act("restore")}>
						恢复
					</button>
				)}
			</div>
		</div>
	);
}

/** 一组互相冲突的记忆（按冲突关系连起来的）：并排看，选底稿改写或合并，确认后就是最终版本 */
function ConflictGroup({ items, onError }: { items: Memory[]; onError: (msg: Msg) => void }) {
	const qc = useQueryClient();
	// 默认以已确认的、再是最新的那条为底稿
	const pick = items.toSorted((a, b) => Number(b.confirmed) - Number(a.confirmed) || b.updated - a.updated)[0];
	const [keep, setKeep] = useState(pick.id);
	const [text, setText] = useState(pick.content);
	const [busy, setBusy] = useState(false);
	async function resolve() {
		setBusy(true);
		try {
			await resolveMemories(keep, items, text);
			onError({ text: `已裁定，最终版本记在 #${keep}，其余转为已取代` });
			qc.invalidateQueries({ queryKey: ["memory"] });
		} catch (e) {
			onError({ text: (e as Error).message, bad: true });
		} finally {
			setBusy(false);
		}
	}
	return (
		<div className="conflict-group">
			{items.map((m) => (
				<MemoryCard key={m.id} m={m} onError={onError} />
			))}
			<div className="card memory">
				<div className="label">最终版本（可直接改写或合并）</div>
				<div className="row">
					{items.map((m) => (
						<button
							key={m.id}
							className={`btn${keep === m.id && text === m.content ? " primary" : ""}`}
							disabled={busy}
							onClick={() => {
								setKeep(m.id);
								setText(m.content);
							}}
						>
							用 #{m.id}
						</button>
					))}
					<button className="btn" disabled={busy} onClick={() => setText(items.map((m) => m.content).join("；"))}>
						合并几条
					</button>
				</div>
				<textarea value={text} onChange={(e) => setText(e.target.value)} />
				<div className="row">
					<button className="btn primary" disabled={busy || !text.trim()} onClick={resolve}>
						确认为最终版本
					</button>
					<span className="foot">
						记在 #{keep} 上（沿用它的分类），依据合并过去；
						{items
							.filter((m) => m.id !== keep)
							.map((m) => `#${m.id}`)
							.join("、")}{" "}
						转为已取代
					</span>
				</div>
			</div>
		</div>
	);
}

/** 有争议的按冲突关系连成组（对方可能还是生效状态，也拉进来一起看）；组里只剩一条就单独显示 */
function conflictGroups(items: Memory[], all: Memory[]): Memory[][] {
	const byId = new Map(all.filter((m) => m.state !== "forgotten" && m.state !== "superseded").map((m) => [m.id, m]));
	const seen = new Set<number>();
	const groups: Memory[][] = [];
	for (const m of items) {
		if (seen.has(m.id)) continue;
		const group: Memory[] = [];
		const stack = [m];
		seen.add(m.id);
		while (stack.length) {
			const x = stack.pop()!;
			group.push(x);
			for (const c of x.conflicts) {
				const y = byId.get(c);
				if (y && !seen.has(y.id)) {
					seen.add(y.id);
					stack.push(y);
				}
			}
		}
		groups.push(group.toSorted((a, b) => a.id - b.id));
	}
	return groups;
}

function NewMemory() {
	const qc = useQueryClient();
	const [content, setContent] = useState("");
	const [msg, setMsg] = useState<Msg>(null);
	async function submit(c: Classification) {
		if (!content.trim()) return setMsg({ text: "先写要记住什么", bad: true });
		try {
			await addMemory({ ...c, content });
			setContent("");
			setMsg({ text: "已记下" });
			qc.invalidateQueries({ queryKey: ["memory"] });
		} catch (e) {
			setMsg({ text: (e as Error).message, bad: true });
		}
	}
	return (
		<div className="panel newtask">
			<textarea
				value={content}
				onChange={(e) => setContent(e.target.value)}
				placeholder="记一条，例如：回 PM 的排期问题不要直接承诺日期，先说评估一下（不超过 300 字）"
			/>
			<ClassifyForm init={{ kind: "preference", application: "reference", appliesWhen: "" }} onSubmit={submit} submitText="记下" />
			<MsgLine msg={msg} />
		</div>
	);
}

export function MemoryBoard() {
	const { data, error } = useQuery({ queryKey: ["memory"], queryFn: fetchMemory });
	const [q, setQ] = useState("");
	const [query, setQuery] = useState("");
	const [msg, setMsg] = useState<Msg>(null);
	const found = useQuery({ queryKey: ["memory-search", query], queryFn: () => searchMemory(query), enabled: Boolean(query) });
	if (error) return <div className="empty">读取失败</div>;
	if (!data) return <div className="empty">加载中…</div>;
	const v = data.vectors;
	const byId = new Map(data.items.map((m) => [m.id, m]));
	const scores = new Map(found.data?.scores.map((s) => [s.id, s]));
	return (
		<div className="memory-board">
			<NewMemory />
			<div className="panel newtask">
				<div className="row">
					<input
						className="grow"
						value={q}
						onChange={(e) => setQ(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") setQuery(q.trim());
						}}
						placeholder="按一条消息试召回（回车），看每条的两臂分数"
					/>
					{query && (
						<button
							className="btn"
							onClick={() => {
								setQ("");
								setQuery("");
							}}
						>
							清除
						</button>
					)}
				</div>
				<div className="foot">
					向量 {v.model}：{v.total} 条{v.pending ? `，${v.pending} 条待补` : "，已补齐"}
					{v.retryIn ? `（向量服务不可用，${v.retryIn} 秒后重试，期间只用关键词）` : ""}
				</div>
				{found.data?.degraded && <div className="foot">向量检索不可用：{found.data.degraded}，只用了关键词</div>}
			</div>
			<MsgLine msg={msg} />
			{query ? (
				<div>
					{!found.data ? (
						<div className="empty">检索中…</div>
					) : !found.data.scores.length ? (
						<div className="empty">没有命中</div>
					) : (
						found.data.scores.map(
							(s) => byId.get(s.id) && <MemoryCard key={s.id} m={byId.get(s.id)!} score={scores.get(s.id)} onError={setMsg} />,
						)
					)}
				</div>
			) : (
				GROUPS.map((g) => {
					const items = data.items.filter(g.match);
					if (!items.length) return null;
					return (
						<details key={g.name} className="memory-group" open={g.open}>
							<summary>
								<b>{g.name}</b>{" "}
								<span className="foot">
									{items.length} 条 · {g.hint}
								</span>
							</summary>
							{g.name === "有争议"
								? conflictGroups(items, data.items).map((group) =>
										group.length > 1 ? (
											<ConflictGroup key={group.map((m) => `${m.id}v${m.revision}`).join("-")} items={group} onError={setMsg} />
										) : (
											<MemoryCard key={group[0].id} m={group[0]} onError={setMsg} />
										),
									)
								: items.map((m) => <MemoryCard key={m.id} m={m} onError={setMsg} />)}
						</details>
					);
				})
			)}
			{!query && !data.items.length && <div className="empty">还没有记忆。在飞书里说「记住 xxx」，或者在上面直接记一条。</div>}
		</div>
	);
}
