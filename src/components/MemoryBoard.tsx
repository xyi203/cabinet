import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
	type ArmScore,
	type Classification,
	type Memory,
	addMemory,
	fetchMemory,
	memoryAction,
	resolveMemories,
	searchMemory,
} from "../lib/api";
import { time } from "../lib/format";
import { type Msg, MsgLine } from "./Drawer";

const KIND: Record<Memory["kind"], string> = { preference: "偏好", fact: "事实", experience: "经验" };
const PROVENANCE: Record<Memory["provenance"], string> = {
	user_statement: "你的原话",
	tool_observation: "工具结果",
	model_inference: "模型推断",
};
const EVIDENCE: Record<string, string> = { yi: "你说", tool: "工具", board: "看板", message: "材料" };

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
			<button className="btn sm" onClick={() => onSubmit(c)}>
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
		<div className="mrow">
			{text === null ? (
				<div className="body">{m.content}</div>
			) : (
				<>
					<textarea value={text} onChange={(e) => setText(e.target.value)} />
					<div className="row">
						<button className="btn pri sm" disabled={busy || !text.trim()} onClick={() => act("edit", { content: text })}>
							保存文字
						</button>
						<button className="btn sm" disabled={busy} onClick={() => setText(null)}>
							取消
						</button>
						<span className="foot">改过的算你的原话、已确认；有争议的改完还要在下面裁定</span>
					</div>
				</>
			)}
			{m.application === "convention" && <div className="foot">适用：{m.appliesWhen}</div>}
			<div className="meta">
				<span className={`tag${m.application === "convention" ? " conv" : ""}`}>{m.application === "convention" ? "约定" : "线索"}</span>
				<span className="tag">{KIND[m.kind]}</span>
				{m.state === "candidate" && <span className="tag cand">待确认，不会被带上</span>}
				<span>{PROVENANCE[m.provenance]}</span>
				<span>{m.confirmed ? "已确认" : "未确认"}</span>
				{m.scope !== "personal" && <span className="tag">限 {m.scopeName || m.scope}</span>}
				{m.injected > 0 && <span>带上过 {m.injected} 次</span>}
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
					<button className="btn sm" disabled={busy} onClick={() => act("confirm")}>
						确认
					</button>
				)}
				{m.state === "contested" && m.confirmed && (
					<button className="btn sm" disabled={busy} onClick={() => act("confirm")}>
						以这条为准
					</button>
				)}
				{live && text === null && (
					<button className="btn sm" disabled={busy} onClick={() => setText(m.content)}>
						改文字
					</button>
				)}
				{live && (
					<button className="btn sm" disabled={busy} onClick={() => setEditing(!editing)}>
						{editing ? "取消" : "改分类"}
					</button>
				)}
				{live ? (
					<button className="btn ghost sm" disabled={busy} onClick={() => act("forget")}>
						遗忘
					</button>
				) : (
					<button className="btn sm" disabled={busy} onClick={() => act("restore")}>
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
			<div className="mrow final">
				<div className="label">最终版本（可直接改写或合并）</div>
				<div className="row">
					{items.map((m) => (
						<button
							key={m.id}
							className={`btn sm${keep === m.id && text === m.content ? " pri" : ""}`}
							disabled={busy}
							onClick={() => {
								setKeep(m.id);
								setText(m.content);
							}}
						>
							用 #{m.id}
						</button>
					))}
					<button className="btn sm" disabled={busy} onClick={() => setText(items.map((m) => m.content).join("；"))}>
						合并几条
					</button>
				</div>
				<textarea value={text} onChange={(e) => setText(e.target.value)} />
				<div className="row">
					<button className="btn pri sm" disabled={busy || !text.trim()} onClick={resolve}>
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
		<div className="newbox">
			<label htmlFor="mem-new">手记一条（就是你的原话，记成已确认）</label>
			<textarea
				id="mem-new"
				value={content}
				onChange={(e) => setContent(e.target.value)}
				placeholder="记一条，例如：回 PM 的排期问题不要直接承诺日期，先说评估一下（不超过 300 字）"
			/>
			<ClassifyForm init={{ kind: "preference", application: "reference", appliesWhen: "" }} onSubmit={submit} submitText="记下" />
			<MsgLine msg={msg} />
		</div>
	);
}

const TABS: Array<[string, (m: Memory) => boolean]> = [
	["生效", (m) => m.state === "active"],
	["待确认", (m) => m.state === "candidate"],
	["已遗忘 / 已取代", (m) => m.state === "forgotten" || m.state === "superseded"],
];

function Section({
	name,
	hint,
	items,
	empty,
	onError,
}: {
	name: string;
	hint: string;
	items: Memory[];
	empty: string;
	onError: (m: Msg) => void;
}) {
	return (
		<section className="wgroup">
			<div className="gh">
				<h2>{name}</h2>
				<span className="c">{items.length}</span>
				<span className="hint">{hint}</span>
			</div>
			{items.length ? (
				<div className="list">
					{items.map((m) => (
						<MemoryCard key={m.id} m={m} onError={onError} />
					))}
				</div>
			) : (
				<div className="empty">{empty}</div>
			)}
		</section>
	);
}

/** 记忆（docs/router-worker.md §5.5）：冲突放最上面等裁定；手记和试召回并排；列表按 生效 / 待确认 / 已遗忘 分页签 */
export function MemoryBoard() {
	const { data, error } = useQuery({ queryKey: ["memory"], queryFn: fetchMemory });
	const [q, setQ] = useState("");
	const [query, setQuery] = useState("");
	const [tab, setTab] = useState(TABS[0][0]);
	const [msg, setMsg] = useState<Msg>(null);
	const found = useQuery({ queryKey: ["memory-search", query], queryFn: () => searchMemory(query), enabled: Boolean(query) });
	if (error) return <div className="empty">读取失败</div>;
	if (!data) return <div className="empty">加载中…</div>;
	const v = data.vectors;
	const byId = new Map(data.items.map((m) => [m.id, m]));
	const scores = new Map(found.data?.scores.map((s) => [s.id, s]));
	const count = (f: (m: Memory) => boolean) => data.items.filter(f).length;
	const groups = conflictGroups(
		data.items.filter((m) => m.state === "contested"),
		data.items,
	);
	const shown = data.items.filter(TABS.find(([n]) => n === tab)![1]);
	return (
		<div className="memory-board">
			<div className="pulse mempulse">
				<span>
					生效 <b>{count((m) => m.state === "active")}</b>
				</span>
				<span>
					约定 <b>{count((m) => m.state === "active" && m.application === "convention")}</b>
				</span>
				<span>
					线索 <b>{count((m) => m.state === "active" && m.application === "reference")}</b>
				</span>
				<span>
					待确认 <b>{count((m) => m.state === "candidate")}</b>
				</span>
				{groups.length > 0 && (
					<span className="hot">
						有冲突 <b>{groups.length}</b>
					</span>
				)}
			</div>
			{groups.length > 0 && (
				<div className="conflict">
					<div className="gh wait">
						<h2>有冲突，等你裁定</h2>
						<span className="hint">冲突的先停用、不会被带上；选一条为准，或者改写、合并成最终版本</span>
					</div>
					{groups.map((group) =>
						group.length > 1 ? (
							<ConflictGroup key={group.map((m) => `${m.id}v${m.revision}`).join("-")} items={group} onError={setMsg} />
						) : (
							<div key={group[0].id} className="list">
								<MemoryCard m={group[0]} onError={setMsg} />
							</div>
						),
					)}
				</div>
			)}
			<div className="memtools">
				<NewMemory />
				<div className="newbox">
					<label htmlFor="mem-recall">试召回：拿一条消息看会带上哪些（回车）</label>
					<input
						id="mem-recall"
						className="in wide"
						value={q}
						onChange={(e) => setQ(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") setQuery(q.trim());
						}}
						placeholder="例如：王磊：结算页又 500 了，能帮忙看下吗"
					/>
					<div className="oa">
						<button className="btn sm" disabled={!q.trim()} onClick={() => setQuery(q.trim())}>
							试一下
						</button>
						{query && (
							<button
								className="btn ghost sm"
								onClick={() => {
									setQ("");
									setQuery("");
								}}
							>
								清除
							</button>
						)}
					</div>
					<div className="meta">
						向量 {v.model}：{v.total} 条{v.pending ? `，${v.pending} 条待补` : "，已补齐"}
						{v.retryIn ? `（向量服务不可用，${v.retryIn} 秒后重试，期间只用关键词）` : ""}
					</div>
					{found.data?.degraded && <div className="meta">向量检索不可用：{found.data.degraded}，只用了关键词</div>}
				</div>
			</div>
			<MsgLine msg={msg} />
			{query ? (
				<section className="wgroup">
					<div className="gh">
						<h2>试召回结果</h2>
						<span className="hint">约定每次都带；线索看关键词和余弦，过门槛才带</span>
					</div>
					{!found.data ? (
						<div className="empty">检索中…</div>
					) : !found.data.scores.length ? (
						<div className="empty">没有命中</div>
					) : (
						<div className="list">
							{found.data.scores.map(
								(s) => byId.get(s.id) && <MemoryCard key={s.id} m={byId.get(s.id)!} score={scores.get(s.id)} onError={setMsg} />,
							)}
						</div>
					)}
				</section>
			) : (
				<>
					<div className="tools">
						<div className="seg" role="tablist">
							{TABS.map(([n, f]) => (
								<button key={n} role="tab" aria-selected={tab === n} className={tab === n ? "on" : ""} onClick={() => setTab(n)}>
									{n} {count(f)}
								</button>
							))}
						</div>
					</div>
					{tab === "生效" ? (
						<>
							<Section
								name="约定"
								hint="条件成立时直接照做，每次都带"
								items={shown.filter((m) => m.application === "convention")}
								empty="还没有约定。在飞书里说「记住 xxx」，或者在上面手记一条"
								onError={setMsg}
							/>
							<Section
								name="线索"
								hint="和当前消息相关、过了门槛才带；只作参考"
								items={shown.filter((m) => m.application !== "convention")}
								empty="没有"
								onError={setMsg}
							/>
						</>
					) : (
						<Section
							name={tab}
							hint={tab === "待确认" ? "模型推断的，确认或改分类后才生效" : "不再使用；遗忘的同一句话不会被重新提取"}
							items={shown}
							empty="没有"
							onError={setMsg}
						/>
					)}
				</>
			)}
		</div>
	);
}
