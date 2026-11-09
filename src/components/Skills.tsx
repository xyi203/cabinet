import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type SkillView, fetchSkillDoc, fetchSkills, post } from "../lib/api";
import { AGENT_NAME } from "../lib/format";
import { Markdown, splitFrontmatter } from "./Markdown";
import { toast } from "./Toast";
import { Card, Segmented } from "./ui";

type Filter = "all" | "visible" | "hidden" | "rules" | "broken";

/** 命令规则：用文字分组代替颜色，不用另配图例 */
function Rules({ s }: { s: SkillView }) {
	if (!s.rules.length) return null;
	const kinds = [
		["直接执行", "read"],
		["需要批准", "write"],
		["不允许", "deny"],
	] as const;
	return (
		<div className="mt-2 flex flex-col gap-2">
			{s.rules.map((r) => (
				<div key={r.name} className="text-[12px]">
					<div className="text-text-2">
						<code>{r.name}</code> 命令
					</div>
					{kinds.map(([label, k]) =>
						r[k].length ? (
							<div key={k} className="mt-1 flex gap-2">
								<span className="w-14 shrink-0 text-muted">{label}</span>
								<span className="flex min-w-0 flex-wrap gap-1">
									{r[k].map((w) => (
										<code key={w} className="rounded bg-soft px-1.5 text-text">
											{w}
										</code>
									))}
								</span>
							</div>
						) : null,
					)}
				</div>
			))}
		</div>
	);
}

function SkillDoc({ doc }: { doc?: string }) {
	if (doc === undefined) return <div className="mt-2 text-[12px] text-muted">加载中…</div>;
	const { meta, body } = splitFrontmatter(doc);
	return (
		<div className="mt-2 max-h-[60vh] overflow-auto rounded-md border border-line bg-bg px-4 py-3">
			{meta && (
				<pre className="m-0 mb-3 overflow-x-auto border-b border-line pb-3 font-mono text-[12px] leading-5 whitespace-pre-wrap text-muted">
					{meta}
				</pre>
			)}
			<Markdown text={body} />
		</div>
	);
}

function Row({ s, everyone }: { s: SkillView; everyone: number }) {
	const qc = useQueryClient();
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const { data: doc } = useQuery({ queryKey: ["skill-doc", s.name], queryFn: () => fetchSkillDoc(s.name), enabled: open && !s.broken });
	async function toggle() {
		setBusy(true);
		try {
			await post("/api/skills/hide", { name: s.name, hidden: !s.hidden });
			toast(s.hidden ? `已取消隐藏 ${s.name}，下次运行时助手可以用` : `已隐藏 ${s.name}，下次运行时助手不再看到它`);
			await qc.invalidateQueries({ queryKey: ["skills"] });
		} catch (e) {
			toast((e as Error).message, true);
		} finally {
			setBusy(false);
		}
	}
	// 几乎所有技能所有助手都能用，只在例外时说明
	const who =
		s.hidden || s.broken || s.agents.length === everyone
			? ""
			: s.agents.length
				? `仅${s.agents.map((a) => AGENT_NAME[a] ?? a).join("、")}可用`
				: "没有助手能用";
	return (
		<div className="border-t border-line px-4 py-3 first:border-t-0">
			<div className="flex items-start gap-3">
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
						<span className={`text-[14px] font-semibold break-all ${s.hidden || s.broken ? "text-muted" : "text-text"}`}>{s.name}</span>
						{s.broken && (
							<span className="rounded bg-soft px-1.5 text-[12px] text-text-2" title="目录里缺少 SKILL.md">
								无法使用
							</span>
						)}
						{s.hidden && <span className="rounded bg-soft px-1.5 text-[12px] text-text-2">已隐藏</span>}
						{who && <span className="text-[12px] text-muted">{who}</span>}
					</div>
				</div>
				<div className="flex shrink-0 flex-wrap justify-end gap-1.5">
					{!s.broken && (
						<button type="button" className="btn sm" aria-expanded={open} onClick={() => setOpen(!open)}>
							{open ? "收起" : "查看说明"}
						</button>
					)}
					<button type="button" className="btn sm" disabled={busy} onClick={toggle}>
						{s.hidden ? "取消隐藏" : "隐藏"}
					</button>
				</div>
			</div>
			{/* 说明和规则放在按钮下方占满整行，窄屏不被按钮挤成一条 */}
			{s.desc && <div className={`mt-1 text-[12px] text-muted ${open ? "" : "line-clamp-2"}`}>{s.desc}</div>}
			<Rules s={s} />
			{open && <SkillDoc doc={doc} />}
		</div>
	);
}

/** 技能：助手能用哪些 skill、命令规则怎么配；用不上的可以隐藏，系统提示里不再列，每次调用省 tokens */
export function SkillsPage() {
	const { data: skills, error } = useQuery({ queryKey: ["skills"], queryFn: fetchSkills });
	const [filter, setFilter] = useState<Filter>("all");
	const [q, setQ] = useState("");
	if (error && !skills) return <div className="text-[14px] text-bad">读取失败：{(error as Error).message}</div>;
	if (!skills) return <div className="py-10 text-center text-[14px] text-muted">加载中…</div>;
	const match: Record<Filter, (s: SkillView) => boolean> = {
		all: () => true,
		visible: (s) => !s.hidden && !s.broken,
		hidden: (s) => s.hidden,
		rules: (s) => s.rules.length > 0,
		broken: (s) => s.broken,
	};
	const everyone = new Set(skills.flatMap((s) => s.agents)).size;
	const kw = q.trim().toLowerCase();
	const rows = skills.filter((s) => match[filter](s) && (!kw || `${s.name} ${s.desc}`.toLowerCase().includes(kw)));
	const label = (f: Filter, name: string) => `${name} ${skills.filter(match[f]).length}`;
	const broken = skills.some(match.broken);
	return (
		<div className="flex flex-col gap-3">
			<p className="m-0 text-[12px] text-muted">用不上的技能可以隐藏，助手就不会看到它，每次运行能省一些额度。</p>
			<div className="flex flex-wrap items-center gap-3">
				<Segmented
					value={filter}
					onChange={setFilter}
					options={[
						{ value: "all", label: label("all", "全部") },
						{ value: "visible", label: label("visible", "可用") },
						{ value: "hidden", label: label("hidden", "已隐藏") },
						{ value: "rules", label: label("rules", "有命令规则") },
						// 没有失效的就不占位置
						...(broken || filter === "broken" ? [{ value: "broken" as const, label: label("broken", "无法使用") }] : []),
					]}
				/>
				<input
					type="search"
					value={q}
					onChange={(e) => setQ(e.target.value)}
					placeholder="搜索技能"
					aria-label="搜索技能"
					className="w-full rounded-md border border-line bg-panel px-2.5 py-1.5 text-[14px] text-text [font-family:inherit] sm:w-56"
				/>
			</div>
			{filter === "rules" && <p className="m-0 text-[12px] text-muted">命令规则在「提示词」的「命令规则」里修改。</p>}
			<Card>
				{rows.map((s) => (
					<Row key={s.name} s={s} everyone={everyone} />
				))}
				{!rows.length && <div className="py-8 text-center text-[14px] text-muted">没有符合条件的技能</div>}
			</Card>
		</div>
	);
}
