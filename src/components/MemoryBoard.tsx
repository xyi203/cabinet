import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
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
import { time, when } from "../lib/format";
import { toast } from "./Toast";
import { Segmented } from "./ui";

const KIND: Record<Memory["kind"], string> = { preference: "偏好", fact: "事实", experience: "经验" };
const PROVENANCE: Record<Memory["provenance"], string> = {
	user_statement: "你说的",
	tool_observation: "查到的",
	model_inference: "AI 推断",
};
const EVIDENCE: Record<string, string> = { yi: "你说", tool: "查到", board: "你在看板上写", message: "消息" };
/** 和后端 MAX_CONTENT 一致 */
const MAX = 300;

const field = "rounded-md border border-line bg-panel px-2.5 py-1.5 text-[14px] text-text [font:inherit]";
const tag = "rounded px-1.5 text-[12px] leading-[18px]";

const live = (m: Memory) => m.state !== "forgotten" && m.state !== "superseded";
const scopeText = (m: Memory) =>
	m.scope === "personal" ? "" : m.scope.startsWith("chat:") ? `仅在「${m.scopeName || "某个群"}」` : `仅对 ${m.scopeName || "某个人"}`;

async function run(p: Promise<unknown>, done?: string) {
	try {
		await p;
		if (done) toast(done);
		return true;
	} catch (e) {
		toast((e as Error).message, true);
		return false;
	}
}

/** 怎么用 + 什么时候 + 类型。约定只能是偏好（后端校验），选约定时类型固定为偏好、不再给选 */
function UseFields({ c, setC }: { c: Classification; setC: (c: Classification) => void }) {
	return (
		<div className="flex flex-wrap items-center gap-2">
			<Segmented
				value={c.application}
				options={[
					{ value: "reference", label: "相关时参考" },
					{ value: "convention", label: "每次照做" },
				]}
				onChange={(application) => setC({ ...c, application, kind: application === "convention" ? "preference" : c.kind })}
			/>
			{c.application === "convention" ? (
				<input
					className={`${field} min-w-[200px] flex-1`}
					aria-label="什么时候照做"
					value={c.appliesWhen}
					onChange={(e) => setC({ ...c, appliesWhen: e.target.value })}
					placeholder="什么时候照做，例如：回复 PM 关于排期的问题时"
				/>
			) : (
				<select
					className={field}
					aria-label="类型"
					value={c.kind}
					onChange={(e) => setC({ ...c, kind: e.target.value as Classification["kind"] })}
				>
					{Object.entries(KIND).map(([k, v]) => (
						<option key={k} value={k}>
							{v}
						</option>
					))}
				</select>
			)}
		</div>
	);
}

const ready = (text: string, c: Classification) =>
	Boolean(text.trim()) && (c.application !== "convention" || Boolean(c.appliesWhen.trim()));

function TextBox({
	value,
	onChange,
	placeholder,
	id,
}: {
	value: string;
	onChange: (v: string) => void;
	placeholder?: string;
	id?: string;
}) {
	return (
		<div className="relative">
			<textarea
				id={id}
				className={`${field} block min-h-[72px] w-full resize-y leading-[22px]`}
				value={value}
				maxLength={MAX}
				onChange={(e) => onChange(e.target.value)}
				placeholder={placeholder}
			/>
			{value.length > MAX - 50 && (
				<span className="absolute right-2 bottom-1.5 text-[12px] text-muted tabular-nums">
					{value.length}/{MAX}
				</span>
			)}
		</div>
	);
}

/** 编辑：文字和用法一起改。文字变了先改文字（后端会升版本），再用返回的新版本改用法 */
function EditForm({ m, onDone }: { m: Memory; onDone: () => void }) {
	const qc = useQueryClient();
	const [text, setText] = useState(m.content);
	const [c, setC] = useState<Classification>({ kind: m.kind, application: m.application, appliesWhen: m.appliesWhen });
	const [busy, setBusy] = useState(false);
	async function save() {
		setBusy(true);
		const ok = await run(
			(async () => {
				let cur = m;
				if (text.trim() !== m.content) cur = (await memoryAction(cur, "edit", { content: text })).item;
				if (c.kind !== m.kind || c.application !== m.application || c.appliesWhen.trim() !== m.appliesWhen)
					await memoryAction(cur, "classify", c);
			})(),
			"已保存",
		);
		setBusy(false);
		void qc.invalidateQueries({ queryKey: ["memory"] });
		if (ok) onDone();
	}
	return (
		<div className="flex flex-col gap-2">
			<TextBox value={text} onChange={setText} />
			<UseFields c={c} setC={setC} />
			<div className="flex gap-2">
				<button className="btn pri sm" disabled={busy || !ready(text, c)} onClick={save}>
					保存
				</button>
				<button className="btn ghost sm" disabled={busy} onClick={onDone}>
					取消
				</button>
			</div>
		</div>
	);
}

/** 试一试里这条会不会被带上：和真正召回一致——待确认、有冲突的不带；约定总带；参考过了相关度门槛才带 */
function verdict(m: Memory, s: ArmScore): [string, boolean] {
	if (m.state === "candidate") return ["待确认，不会用上", false];
	if (m.state === "contested") return ["有冲突，暂不使用", false];
	if (m.application === "convention") return ["约定，总会用上", true];
	return s.passed ? ["会用上", true] : ["不够相关，不会用上", false];
}
const scoreTip = (s: ArmScore) =>
	`关键词 ${s.keyword === undefined ? "未命中" : s.keyword.toFixed(3)}，语义相似度 ${s.vector === undefined ? "未命中" : s.vector.toFixed(3)}`;

/** 来源：这条记忆从哪些原话、消息、查询结果里来的，默认收起 */
function Evidence({ m, now, className = "" }: { m: Memory; now: number; className?: string }) {
	if (!m.evidence.length) return null;
	return (
		<details className={`text-[12px] ${className}`}>
			<summary className="cursor-pointer text-muted">查看 {m.evidence.length} 条来源</summary>
			<div className="mt-1.5 flex flex-col gap-2 border-l-2 border-line pl-3">
				{m.evidence.map((e, i) => (
					<div key={i}>
						<div className="text-muted">
							{EVIDENCE[e.kind] ?? e.kind}
							<span className="ml-2 tabular-nums">{when(e.at, now)}</span>
						</div>
						<div className="break-words whitespace-pre-wrap text-text-2">{e.quote}</div>
					</div>
				))}
			</div>
		</details>
	);
}

function MemoryRow({
	m,
	all,
	now,
	score,
	showUse,
}: {
	m: Memory;
	all: Map<number, Memory>;
	now: number;
	score?: ArmScore;
	showUse?: boolean;
}) {
	const qc = useQueryClient();
	const [busy, setBusy] = useState(false);
	const [editing, setEditing] = useState(false);
	async function act(action: "confirm" | "forget" | "restore", done: string) {
		setBusy(true);
		await run(memoryAction(m, action), done);
		setBusy(false);
		void qc.invalidateQueries({ queryKey: ["memory"] });
	}
	// 待确认的推断如果和某条记忆冲突，确认它会让那条停用：先说清楚
	const rivals = m.state === "candidate" ? m.conflicts.map((id) => all.get(id)).filter((x): x is Memory => Boolean(x && live(x))) : [];
	const by = m.supersededBy ? all.get(m.supersededBy) : undefined;
	const v = score && verdict(m, score);
	const scope = scopeText(m);
	return (
		<div className="flex flex-col gap-1.5 border-t border-line px-4 py-3 first:border-t-0">
			{editing ? (
				<EditForm m={m} onDone={() => setEditing(false)} />
			) : (
				<>
					<div className="text-[14px] leading-[22px] break-words whitespace-pre-wrap text-text">{m.content}</div>
					{m.application === "convention" && <div className="text-[12px] text-text-2">什么时候用：{m.appliesWhen}</div>}
				</>
			)}
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
				<div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted">
					{v && (
						<span className={`${tag} ${v[1] ? "bg-accent-soft text-accent" : "bg-soft text-text-2"}`} title={scoreTip(score)}>
							{v[0]}
						</span>
					)}
					{showUse && <span className={`${tag} bg-soft text-text-2`}>{m.application === "convention" ? "约定" : "参考"}</span>}
					{m.state === "forgotten" && <span className={`${tag} bg-soft text-text-2`}>已忘掉</span>}
					{m.state === "superseded" && (
						<span className={`${tag} bg-soft text-text-2`} title={by ? `取代它的：${by.content}` : undefined}>
							已被取代
						</span>
					)}
					{scope && <span className="text-text-2">{scope}</span>}
					<span>{KIND[m.kind]}</span>
					<span>
						{PROVENANCE[m.provenance]}
						{m.state === "active" && !m.confirmed ? "，未确认" : ""}
					</span>
					{m.injected > 0 && (
						<span className="tabular-nums" title={m.lastInjected ? `最近一次：${time(m.lastInjected)}` : undefined}>
							用过 {m.injected} 次
						</span>
					)}
					<span className="tabular-nums" title={`更新于 ${time(m.updated)}`}>
						{when(m.updated, now)}
					</span>
				</div>
				{!editing && (
					<div className="flex shrink-0 gap-2">
						{live(m) ? (
							<>
								{(m.state === "candidate" || !m.confirmed) && (
									<button className="btn sm" disabled={busy} onClick={() => act("confirm", "已确认")}>
										确认
									</button>
								)}
								<button className="btn sm" disabled={busy} onClick={() => setEditing(true)}>
									编辑
								</button>
								<button className="btn ghost sm" disabled={busy} onClick={() => act("forget", "已忘掉，可以在「不再使用」里恢复")}>
									忘掉
								</button>
							</>
						) : (
							<button className="btn sm" disabled={busy} onClick={() => act("restore", "已恢复")}>
								恢复
							</button>
						)}
					</div>
				)}
			</div>
			{rivals.length > 0 && (
				<div className="text-[12px] text-warn">
					和这条记忆冲突，确认后它不再使用：
					<span className="text-text-2">{rivals.map((r) => r.content).join("；")}</span>
				</div>
			)}
			<Evidence m={m} now={now} />
		</div>
	);
}

/** 一组互相冲突的记忆：选一条为底稿，可以改写或合并，保存后只留这一条 */
function ConflictGroup({ items, now }: { items: Memory[]; now: number }) {
	const qc = useQueryClient();
	// 默认以已确认的、再是最新的那条为底稿
	const pick = items.toSorted((a, b) => Number(b.confirmed) - Number(a.confirmed) || b.updated - a.updated)[0];
	const [keep, setKeep] = useState(pick.id);
	const [text, setText] = useState(pick.content);
	const [busy, setBusy] = useState(false);
	async function resolve() {
		setBusy(true);
		await run(resolveMemories(keep, items, text), "已保存，其余几条不再使用");
		setBusy(false);
		void qc.invalidateQueries({ queryKey: ["memory"] });
	}
	const name = `conflict-${items[0].id}`;
	return (
		<div className="overflow-hidden rounded-[10px] border border-line bg-panel">
			{items.map((m) => (
				<div key={m.id} className="flex flex-col gap-1.5 border-t border-line px-4 py-3 first:border-t-0">
					<label className="flex cursor-pointer items-start gap-3">
						<input
							type="radio"
							name={name}
							className="mt-1 shrink-0 accent-[var(--accent)]"
							checked={keep === m.id}
							disabled={busy}
							onChange={() => {
								setKeep(m.id);
								setText(m.content);
							}}
						/>
						<span className="flex min-w-0 flex-1 flex-col gap-1">
							<span className="text-[14px] leading-[22px] break-words whitespace-pre-wrap text-text">{m.content}</span>
							{m.application === "convention" && <span className="text-[12px] text-text-2">什么时候用：{m.appliesWhen}</span>}
							<span className="flex flex-wrap gap-x-3 text-[12px] text-muted">
								{scopeText(m) && <span className="text-text-2">{scopeText(m)}</span>}
								<span>{PROVENANCE[m.provenance]}</span>
								<span className="tabular-nums" title={time(m.updated)}>
									{when(m.updated, now)}
								</span>
							</span>
						</span>
					</label>
					<Evidence m={m} now={now} className="pl-7" />
				</div>
			))}
			<div className="flex flex-col gap-2 border-t border-line px-4 py-3">
				<div className="flex items-center gap-2 text-[12px] text-text-2">
					最终写成
					<button
						className="btn ghost sm ml-auto"
						disabled={busy}
						onClick={() =>
							setText(
								items
									.map((m) => m.content)
									.join("；")
									.slice(0, MAX),
							)
						}
					>
						合并这几条
					</button>
				</div>
				<TextBox value={text} onChange={setText} />
				<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
					<button className="btn pri sm" disabled={busy || !text.trim()} onClick={resolve}>
						保存
					</button>
					<span className="text-[12px] text-muted">保存后只留这一条，沿用选中那条的用法</span>
				</div>
			</div>
		</div>
	);
}

/** 有冲突的按冲突关系连成组（对方可能还是生效状态，也拉进来一起看）；组里只剩一条就单独显示 */
function conflictGroups(items: Memory[], all: Memory[]): Memory[][] {
	const byId = new Map(all.filter(live).map((m) => [m.id, m]));
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

function NewMemory({ onClose }: { onClose: () => void }) {
	const qc = useQueryClient();
	const [content, setContent] = useState("");
	const [c, setC] = useState<Classification>({ kind: "preference", application: "reference", appliesWhen: "" });
	const [busy, setBusy] = useState(false);
	async function submit() {
		setBusy(true);
		const ok = await run(addMemory({ ...c, content }), "已记下");
		setBusy(false);
		if (!ok) return;
		void qc.invalidateQueries({ queryKey: ["memory"] });
		onClose();
	}
	return (
		<div className="flex flex-col gap-2 rounded-[10px] border border-line bg-panel px-4 py-3">
			<TextBox
				id="mem-new"
				value={content}
				onChange={setContent}
				placeholder="要记住什么，例如：回 PM 的排期问题不要直接承诺日期，先说评估一下"
			/>
			<UseFields c={c} setC={setC} />
			<div className="flex gap-2">
				<button className="btn pri sm" disabled={busy || !ready(content, c)} onClick={submit}>
					记下
				</button>
				<button className="btn ghost sm" disabled={busy} onClick={onClose}>
					取消
				</button>
			</div>
		</div>
	);
}

function Section({ name, hint, children, count }: { name: string; hint?: string; count?: number; children: ReactNode }) {
	return (
		<section className="flex flex-col gap-2">
			<div className="flex flex-wrap items-baseline gap-x-2 px-0.5">
				<h2 className="m-0 text-[14px] font-semibold text-text">{name}</h2>
				{count != null && <span className="text-[12px] text-muted tabular-nums">{count}</span>}
				{hint && <span className="text-[12px] text-muted">{hint}</span>}
			</div>
			{children}
		</section>
	);
}

function List({
	items,
	all,
	now,
	empty,
	showUse,
}: {
	items: Memory[];
	all: Map<number, Memory>;
	now: number;
	empty: string;
	showUse?: boolean;
}) {
	if (!items.length) return <div className="px-0.5 text-[14px] text-muted">{empty}</div>;
	return (
		<div className="overflow-hidden rounded-[10px] border border-line bg-panel">
			{items.map((m) => (
				<MemoryRow key={`${m.id}v${m.revision}`} m={m} all={all} now={now} showUse={showUse} />
			))}
		</div>
	);
}

type Tab = "active" | "candidate" | "retired";
const IN_TAB: Record<Tab, (m: Memory) => boolean> = {
	active: (m) => m.state === "active",
	candidate: (m) => m.state === "candidate",
	retired: (m) => !live(m),
};

/** 记忆（docs/router-worker.md §5.5）：冲突放最上面等裁定；下面按 生效 / 待确认 / 不再使用 分页签，旁边是记一条和试一试 */
export function MemoryBoard() {
	const { data, error, dataUpdatedAt } = useQuery({ queryKey: ["memory"], queryFn: fetchMemory });
	const [q, setQ] = useState("");
	const [query, setQuery] = useState("");
	const [tab, setTab] = useState<Tab>("active");
	const [adding, setAdding] = useState(false);
	const found = useQuery({ queryKey: ["memory-search", query], queryFn: () => searchMemory(query), enabled: Boolean(query) });
	if (error && !data) return <div className="py-10 text-center text-[14px] text-bad">记忆读取失败：{(error as Error).message}</div>;
	if (!data) return <div className="py-10 text-center text-[14px] text-muted">加载中…</div>;
	// 「今天 / 昨天」相对拿到数据的时刻说，渲染里不读当前时间
	const now = dataUpdatedAt / 1000;
	const v = data.vectors;
	const all = new Map(data.items.map((m) => [m.id, m]));
	const count = (t: Tab) => data.items.filter(IN_TAB[t]).length;
	const groups = conflictGroups(
		data.items.filter((m) => m.state === "contested"),
		data.items,
	);
	const shown = data.items.filter(IN_TAB[tab]);
	const conventions = shown.filter((m) => m.application === "convention");
	const references = shown.filter((m) => m.application !== "convention");
	const clear = () => {
		setQ("");
		setQuery("");
	};
	return (
		<div className="flex flex-col gap-6">
			<p className="-mt-2 mb-0 text-[14px] text-muted">助手回消息、做事时会参考这些记忆。</p>
			{groups.length > 0 && (
				<Section name="说法有冲突，选一条为准" hint="选好之前，这几条都不会用上">
					{groups.map((group) =>
						group.length > 1 ? (
							<ConflictGroup key={group.map((m) => `${m.id}v${m.revision}`).join("-")} items={group} now={now} />
						) : (
							<List key={group[0].id} items={group} all={all} now={now} empty="" />
						),
					)}
				</Section>
			)}
			<div className="flex flex-col gap-3">
				<div className="flex flex-wrap items-center gap-2">
					<Segmented
						value={query ? ("" as Tab) : tab}
						options={[
							{ value: "active", label: `生效 ${count("active")}` },
							{ value: "candidate", label: `待确认 ${count("candidate")}` },
							{ value: "retired", label: `不再使用 ${count("retired")}` },
						]}
						onChange={(t) => {
							setTab(t);
							clear();
						}}
					/>
					<input
						className={`${field} order-last w-full lg:order-none lg:w-auto lg:max-w-[360px] lg:flex-1`}
						aria-label="试一试"
						value={q}
						onChange={(e) => {
							setQ(e.target.value);
							if (!e.target.value.trim()) setQuery("");
						}}
						onKeyDown={(e) => {
							if (e.key === "Enter") setQuery(q.trim());
							if (e.key === "Escape") clear();
						}}
						placeholder="试一试：输入一条消息，看会用上哪些记忆"
					/>
					<button className="btn pri sm ml-auto" aria-expanded={adding} onClick={() => setAdding(!adding)}>
						记一条
					</button>
				</div>
				{adding && <NewMemory onClose={() => setAdding(false)} />}
				{(v.pending > 0 || v.retryIn || found.data?.degraded) && (
					<div className="text-[12px] text-muted" title={`语义模型 ${v.model}，${v.total} 条`}>
						{v.retryIn || found.data?.degraded
							? "语义匹配暂时不可用，先只按关键词找"
							: `还有 ${v.pending} 条在准备语义匹配，暂时只能按关键词找到`}
					</div>
				)}
			</div>
			{query ? (
				<Section name="会用上的记忆" hint="约定总会用上，这里只列和这条消息相关的">
					{!found.data ? (
						<div className="px-0.5 text-[14px] text-muted">{found.error ? `没找成：${(found.error as Error).message}` : "正在找…"}</div>
					) : (
						<TrialList scores={found.data.scores} all={all} now={now} />
					)}
					<div>
						<button className="btn ghost sm" onClick={clear}>
							清除结果
						</button>
					</div>
				</Section>
			) : tab === "active" ? (
				<>
					<Section name="约定" count={conventions.length} hint="条件满足时照做">
						<List items={conventions} all={all} now={now} empty="还没有约定。在飞书里对助手说「记住……」，或者点「记一条」。" />
					</Section>
					<Section name="参考" count={references.length} hint="和消息相关时才会用上">
						<List items={references} all={all} now={now} empty="还没有。" />
					</Section>
				</>
			) : tab === "candidate" ? (
				<Section name="待确认" count={shown.length} hint="AI 从你的回复里总结的，确认后才会用上">
					<List items={shown} all={all} now={now} empty="没有要确认的。" showUse />
				</Section>
			) : (
				<Section name="不再使用" count={shown.length} hint="忘掉的话，以后不会再被记下">
					<List items={shown} all={all} now={now} empty="没有。" showUse />
				</Section>
			)}
		</div>
	);
}

/** 试一试：先列会用上的；相关度不够、待确认、有冲突的收起来，校准门槛时再展开看分数 */
function TrialList({ scores, all, now }: { scores: ArmScore[]; all: Map<number, Memory>; now: number }) {
	const rows = scores.filter((s) => all.has(s.id));
	const used = rows.filter((s) => verdict(all.get(s.id)!, s)[1]);
	const rest = rows.filter((s) => !verdict(all.get(s.id)!, s)[1]);
	const list = (xs: ArmScore[]) => (
		<div className="overflow-hidden rounded-[10px] border border-line bg-panel">
			{xs.map((s) => (
				<MemoryRow key={s.id} m={all.get(s.id)!} all={all} now={now} score={s} showUse />
			))}
		</div>
	);
	return (
		<>
			{used.length ? list(used) : <div className="px-0.5 text-[14px] text-muted">没有会用上的记忆。</div>}
			{rest.length > 0 && (
				<details className="flex flex-col gap-2">
					<summary className="cursor-pointer px-0.5 text-[12px] text-muted">另有 {rest.length} 条沾边但不会用上</summary>
					<div className="mt-2">{list(rest)}</div>
				</details>
			)}
		</>
	);
}
