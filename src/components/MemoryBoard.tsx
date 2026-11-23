import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { createColumnHelper, useTable } from "@tanstack/react-table";
import { type ReactNode, useState } from "react";
import {
	type Classification,
	type ListedFact,
	type Convention,
	type Recalled,
	addMemory,
	deleteConvention,
	editConvention,
	fetchFacts,
	fetchMemory,
	searchMemory,
} from "../lib/api";
import { time } from "../lib/format";
import { DataTable, Pagination, type PaginationState, pageFeatures } from "./DataTable";
import { toast } from "./Toast";
import { Segmented } from "./ui";

// 记忆存在外面：约定、偏好与经验都在 Hindsight。
// 这一页管约定、手写一条、试召回，并列出 Hindsight 存着的明细（只读）
const KIND: Record<Classification["kind"], string> = { preference: "偏好", fact: "事实", experience: "经验" };
const WHERE = { convention: "约定", hindsight: "Hindsight" };
const SERVICE: Record<string, string> = { hindsight: "Hindsight" };
/** 和后端 MAX_CONTENT 一致 */
const MAX = 300;

const field = "rounded-[8px] border border-transparent bg-soft px-2.5 py-1.5 text-[14px] text-text [font:inherit]";
const tag = "rounded px-1.5 text-[12px] leading-[18px]";

const scopeText = (c: Convention) =>
	c.scope === "personal" ? "" : c.scope.startsWith("chat:") ? `仅在「${c.scopeName || "某个群"}」` : `仅对 ${c.scopeName || "某个人"}`;

async function run<T>(p: Promise<T>, done?: string) {
	try {
		const r = await p;
		if (done) toast(done);
		return r;
	} catch (e) {
		toast((e as Error).message, true);
		return undefined;
	}
}

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

/** 手写一条：选「每次照做」进约定；否则偏好、事实与经验都进 Hindsight */
function NewMemory({ onClose }: { onClose: () => void }) {
	const qc = useQueryClient();
	const [content, setContent] = useState("");
	const [c, setC] = useState<Classification>({ kind: "preference", application: "reference", appliesWhen: "" });
	const [busy, setBusy] = useState(false);
	const ready = Boolean(content.trim()) && (c.application !== "convention" || Boolean(c.appliesWhen.trim()));
	async function submit() {
		setBusy(true);
		const r = await run(addMemory({ ...c, content }));
		setBusy(false);
		if (!r) return;
		toast(`已记进${WHERE[r.item.where]}`);
		void qc.invalidateQueries({ queryKey: ["memory"] });
		onClose();
	}
	return (
		<div className="flex flex-col gap-2 rounded-[12px] bg-bg px-4 py-3">
			<TextBox
				id="mem-new"
				value={content}
				onChange={setContent}
				placeholder="要记住什么，例如：回 PM 的排期问题不要直接承诺日期，先说评估一下"
			/>
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
			<div className="flex flex-wrap items-center gap-2">
				<button className="btn pri sm" disabled={busy || !ready} onClick={submit}>
					记下
				</button>
				<button className="btn ghost sm" disabled={busy} onClick={onClose}>
					取消
				</button>
				<span className="text-[12px] text-muted">
					{c.application === "convention" ? "进约定，条件成立时每次都带" : "进 Hindsight，相关时参考"}
				</span>
			</div>
		</div>
	);
}

function ConventionRow({ c }: { c: Convention }) {
	const qc = useQueryClient();
	const [editing, setEditing] = useState(false);
	const [text, setText] = useState(c.content);
	const [cond, setCond] = useState(c.appliesWhen);
	const [busy, setBusy] = useState(false);
	async function act(p: () => Promise<unknown>, done: string) {
		setBusy(true);
		const ok = (await run(p(), done)) !== undefined;
		setBusy(false);
		void qc.invalidateQueries({ queryKey: ["memory"] });
		return ok;
	}
	const scope = scopeText(c);
	return (
		<div className="flex flex-col gap-1.5 border-t border-line px-1 py-3.5 first:border-t-0">
			{editing ? (
				<div className="flex flex-col gap-2">
					<TextBox value={text} onChange={setText} />
					<input className={field} aria-label="什么时候照做" value={cond} onChange={(e) => setCond(e.target.value)} />
				</div>
			) : (
				<>
					<div
						className={`text-[14px] leading-[22px] break-words whitespace-pre-wrap ${c.active ? "text-text" : "text-muted line-through"}`}
					>
						{c.content}
					</div>
					<div className="text-[12px] text-text-2">什么时候用：{c.appliesWhen}</div>
				</>
			)}
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
				<div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted">
					{!c.active && <span className={`${tag} bg-soft text-text-2`}>已停用</span>}
					{scope && <span className="text-text-2">{scope}</span>}
					{c.updated && <span className="tabular-nums">{c.updated.slice(0, 10)}</span>}
				</div>
				<div className="flex shrink-0 gap-1">
					{editing ? (
						<>
							<button
								className="btn pri sm"
								disabled={busy || !text.trim() || !cond.trim()}
								onClick={async () => {
									if (await act(() => editConvention(c.id, { content: text, appliesWhen: cond }), "已保存")) setEditing(false);
								}}
							>
								保存
							</button>
							<button className="btn ghost sm" disabled={busy} onClick={() => setEditing(false)}>
								取消
							</button>
						</>
					) : (
						<>
							<button className="btn ghost sm" disabled={busy} onClick={() => setEditing(true)}>
								改
							</button>
							<button
								className="btn ghost sm"
								disabled={busy}
								onClick={() => act(() => editConvention(c.id, { active: !c.active }), c.active ? "已停用" : "已启用")}
							>
								{c.active ? "停用" : "启用"}
							</button>
							<button
								className="btn ghost sm"
								disabled={busy}
								onClick={() => confirm("删掉这条约定？") && act(() => deleteConvention(c.id), "已删除")}
							>
								删除
							</button>
						</>
					)}
				</div>
			</div>
		</div>
	);
}

const TYPE: Record<string, string> = { world: "事实", experience: "经历", observation: "归纳" };

const row = (key: string, text: string, label: string) => (
	<div key={key} className="flex flex-col gap-1 border-t border-line px-1 py-3 first:border-t-0">
		<div className="text-[14px] leading-[22px] break-words whitespace-pre-wrap text-text">{text}</div>
		<div className="text-[12px] text-muted">{label}</div>
	</div>
);

function Trial({ r }: { r: Recalled }) {
	const empty = !r.conventions.length && !r.facts.length;
	return (
		<div className="flex flex-col gap-3">
			{r.degraded.length > 0 && <div className="text-[12px] text-bad">有几路没查成：{r.degraded.join("；")}</div>}
			{empty ? (
				<div className="px-0.5 text-[14px] text-muted">没有会用上的记忆。</div>
			) : (
				<div className="border-y border-line">
					{r.conventions.map((c) => row(`c${c.id}`, c.content, `约定 · 适用：${c.appliesWhen}`))}
					{r.facts.map((f) => row(f.id, f.text, `Hindsight · ${TYPE[f.type] ?? f.type}${f.at ? ` · ${f.at.slice(0, 10)}` : ""}`))}
				</div>
			)}
			{r.block && (
				<details>
					<summary className="cursor-pointer px-0.5 text-[12px] text-muted">注入时的原文</summary>
					<pre className="mt-2 rounded-[8px] bg-soft p-3 text-[12px] leading-[18px] whitespace-pre-wrap text-text-2">{r.block}</pre>
				</details>
			)}
		</div>
	);
}

const factScope = (tags: string[]) =>
	tags.includes("personal") || !tags.length ? "" : tags.some((t) => t.startsWith("chat:")) ? "仅某个群" : "仅某个人";

const factHelper = createColumnHelper<typeof pageFeatures, ListedFact>();
// 列定义放模块级：每次渲染都新建会让表重算行模型
const factColumns = factHelper.columns([
	factHelper.accessor("text", {
		header: "内容",
		cell: (c) => <div className="leading-[22px] break-words whitespace-pre-wrap">{c.getValue()}</div>,
	}),
	factHelper.accessor("type", {
		header: "类型",
		cell: (c) => <span className={`${tag} bg-soft text-text-2`}>{TYPE[c.getValue()] ?? c.getValue()}</span>,
	}),
	factHelper.accessor("tags", {
		header: "范围",
		cell: (c) => <span className="text-[12px] text-text-2">{factScope(c.getValue()) || "通用"}</span>,
	}),
	factHelper.accessor("at", {
		header: "时间",
		cell: (c) => <span className="text-[12px] text-muted tabular-nums">{c.getValue()?.slice(0, 10) ?? ""}</span>,
	}),
]);
const FACT_COLS = { type: "w-[64px]", tags: "w-[80px] hidden md:table-cell", at: "w-[92px] hidden sm:table-cell" };
const noFacts: ListedFact[] = [];

/** Hindsight 里的经验与事实：服务端分页，可按正文与类型过滤 */
function Facts() {
	const [q, setQ] = useState("");
	const [filter, setFilter] = useState("");
	const [type, setType] = useState("");
	const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 20 });
	const { data, error, isFetching } = useQuery({
		queryKey: ["memory", "facts", filter, type, pagination],
		queryFn: () => fetchFacts({ q: filter, type, offset: pagination.pageIndex * pagination.pageSize, limit: pagination.pageSize }),
		placeholderData: keepPreviousData,
	});
	const table = useTable({
		features: pageFeatures,
		columns: factColumns,
		data: data?.items ?? noFacts,
		getRowId: (f) => f.id,
		rowCount: data?.total ?? 0,
		manualPagination: true,
		state: { pagination },
		onPaginationChange: setPagination,
	});
	// 换条件回到第一页
	const reset = () => setPagination((p) => ({ ...p, pageIndex: 0 }));
	return (
		<Section name="经验与事实" count={data?.total} hint="Hindsight 从草稿、问答里抽出来的，「归纳」是它合并多条后的结论">
			<div className="flex flex-wrap items-center gap-2">
				<Segmented
					value={type}
					options={[
						{ value: "", label: "全部" },
						{ value: "world", label: "事实" },
						{ value: "experience", label: "经历" },
						{ value: "observation", label: "归纳" },
					]}
					onChange={(t) => {
						setType(t);
						reset();
					}}
				/>
				<input
					className={`${field} w-full lg:max-w-[360px] lg:flex-1`}
					aria-label="按内容过滤"
					value={q}
					onChange={(e) => {
						setQ(e.target.value);
						if (!e.target.value.trim() && filter) {
							setFilter("");
							reset();
						}
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							setFilter(q.trim());
							reset();
						}
					}}
					placeholder="按内容过滤，回车"
				/>
			</div>
			{error && !data ? (
				<div className="px-0.5 text-[14px] text-bad">读取失败：{(error as Error).message}</div>
			) : (
				<>
					<DataTable table={table} colClass={FACT_COLS} loading={isFetching} empty={filter || type ? "没有匹配的。" : "还没有。"} />
					<Pagination table={table} />
				</>
			)}
		</Section>
	);
}

export function MemoryBoard() {
	const { data, error } = useQuery({ queryKey: ["memory"], queryFn: fetchMemory });
	const [q, setQ] = useState("");
	const [query, setQuery] = useState("");
	const [adding, setAdding] = useState(false);
	const found = useQuery({ queryKey: ["memory-search", query], queryFn: () => searchMemory(query), enabled: Boolean(query) });
	if (error && !data) return <div className="py-10 text-center text-[14px] text-bad">记忆读取失败：{(error as Error).message}</div>;
	if (!data) return <div className="py-10 text-center text-[14px] text-muted">加载中…</div>;
	const clear = () => {
		setQ("");
		setQuery("");
	};
	return (
		<div className="flex flex-col gap-6">
			{(data.down.length > 0 || data.pending > 0) && (
				<div className="flex flex-col gap-1 text-[12px]">
					{data.down.map((d) => (
						<div key={d.service} className="text-bad" title={d.error}>
							{SERVICE[d.service] ?? d.service} 从 {time(d.since)} 起调不通：{d.error}
						</div>
					))}
					{data.pending > 0 && <div className="text-muted">还有 {data.pending} 件草稿或问答在等着沉淀</div>}
				</div>
			)}
			<div className="flex flex-col gap-3">
				<div className="flex flex-wrap items-center gap-2">
					<input
						className={`${field} order-last w-full lg:order-none lg:w-auto lg:max-w-[420px] lg:flex-1`}
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
			</div>
			{query && (
				<Section name="会用上的记忆" hint="不限作用域；起草时还会按对方和会话过滤">
					{found.data ? (
						<Trial r={found.data} />
					) : (
						<div className="px-0.5 text-[14px] text-muted">{found.error ? `没找成：${(found.error as Error).message}` : "正在找…"}</div>
					)}
					<div>
						<button className="btn ghost sm" onClick={clear}>
							清除结果
						</button>
					</div>
				</Section>
			)}
			<Section name="约定" count={data.conventions.length} hint="条件满足时照做，每次都带">
				{data.error ? (
					<div className="px-0.5 text-[14px] text-bad">约定读取失败：{data.error}</div>
				) : data.conventions.length ? (
					<div className="border-y border-line">
						{data.conventions.map((c) => (
							<ConventionRow key={`${c.id}-${c.updated}`} c={c} />
						))}
					</div>
				) : (
					<div className="px-0.5 text-[14px] text-muted">还没有约定。在飞书里对助手说「以后……」「记住……」，或者点「记一条」。</div>
				)}
			</Section>
			<Facts />
		</div>
	);
}
