import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type SkillView, fetchSkillDoc, fetchSkills, post } from "../lib/api";
import { AGENT_NAME } from "../lib/format";
import { toast } from "./Toast";
import { Card, Segmented } from "./ui";

type Filter = "all" | "visible" | "hidden" | "rules" | "broken";

function Rules({ s }: { s: SkillView }) {
	if (!s.rules.length) return null;
	return (
		<div className="mt-1.5 flex flex-col gap-1 text-[12px]">
			{s.rules.map((r) => (
				<div key={r.name} className="flex flex-wrap items-center gap-1">
					<code className="text-muted">{r.name}</code>
					{r.read.map((w) => (
						<span key={`r-${w}`} className="rounded bg-ok-soft px-1.5 text-ok" title="直接放行">
							{w}
						</span>
					))}
					{r.write.map((w) => (
						<span key={`w-${w}`} className="rounded bg-warn-soft px-1.5 text-warn" title="要你审批">
							{w}
						</span>
					))}
					{r.deny.map((w) => (
						<span key={`d-${w}`} className="rounded bg-bad-soft px-1.5 text-bad line-through" title="拒绝">
							{w}
						</span>
					))}
				</div>
			))}
		</div>
	);
}

function Row({ s }: { s: SkillView }) {
	const qc = useQueryClient();
	const [open, setOpen] = useState(false);
	const { data: doc } = useQuery({ queryKey: ["skill-doc", s.name], queryFn: () => fetchSkillDoc(s.name), enabled: open && !s.broken });
	async function toggle() {
		try {
			await post("/api/skills/hide", { name: s.name, hidden: !s.hidden });
			toast(s.hidden ? `已恢复 ${s.name}，下一次运行起 agent 能用` : `已对 agent 隐藏 ${s.name}`);
			await qc.invalidateQueries({ queryKey: ["skills"] });
		} catch (e) {
			toast((e as Error).message, true);
		}
	}
	return (
		<div className={`border-t border-line px-4 py-2.5 first:border-t-0 ${s.hidden || s.broken ? "opacity-60" : ""}`}>
			<div className="flex items-start gap-3">
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-2">
						<b className="text-[13px] text-text">{s.name}</b>
						{s.broken && <span className="rounded bg-bad-soft px-1.5 py-0.5 text-[11px] text-bad">没有 SKILL.md</span>}
						{s.hidden && <span className="rounded bg-soft px-1.5 py-0.5 text-[11px] text-muted">已隐藏</span>}
						{!s.hidden &&
							!s.broken &&
							s.agents.map((a) => (
								<span key={a} className="rounded bg-accent-soft px-1.5 py-0.5 text-[11px] text-accent">
									{AGENT_NAME[a] ?? a}
								</span>
							))}
					</div>
					<div className={`mt-1 text-[12px] text-muted ${open ? "" : "line-clamp-2"}`}>{s.desc || "—"}</div>
					<Rules s={s} />
				</div>
				<div className="flex shrink-0 gap-1.5">
					{!s.broken && (
						<button
							type="button"
							onClick={() => setOpen(!open)}
							className="cursor-pointer rounded-md border border-line bg-panel px-2.5 py-1 text-[12px] text-text hover:bg-soft"
						>
							{open ? "收起" : "看说明"}
						</button>
					)}
					<button
						type="button"
						onClick={toggle}
						className="cursor-pointer rounded-md border border-line bg-panel px-2.5 py-1 text-[12px] text-text hover:bg-soft"
					>
						{s.hidden ? "恢复" : "隐藏"}
					</button>
				</div>
			</div>
			{open && (
				<pre className="mt-2 max-h-[50vh] overflow-auto rounded-lg border border-line bg-bg p-3 text-[12px] whitespace-pre-wrap text-text">
					{doc ?? "加载中…"}
				</pre>
			)}
		</div>
	);
}

/** 技能：agent 能用哪些 skill、命令规则怎么配；用不上的可以隐藏，系统提示里不再列，每次调用省 tokens */
export function SkillsPage() {
	const { data: skills, error } = useQuery({ queryKey: ["skills"], queryFn: fetchSkills });
	const [filter, setFilter] = useState<Filter>("all");
	const [q, setQ] = useState("");
	if (error && !skills) return <div className="text-[13px] text-bad">读取失败：{(error as Error).message}</div>;
	const all = skills ?? [];
	const match: Record<Filter, (s: SkillView) => boolean> = {
		all: () => true,
		visible: (s) => !s.hidden && !s.broken,
		hidden: (s) => s.hidden,
		rules: (s) => s.rules.length > 0,
		broken: (s) => s.broken,
	};
	const kw = q.trim().toLowerCase();
	const rows = all.filter((s) => match[filter](s) && (!kw || `${s.name} ${s.desc}`.toLowerCase().includes(kw)));
	const label = (f: Filter, name: string) => `${name} ${all.filter(match[f]).length}`;
	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-wrap items-center gap-3">
				<Segmented
					value={filter}
					onChange={setFilter}
					options={[
						{ value: "all", label: label("all", "全部") },
						{ value: "visible", label: label("visible", "agent 可用") },
						{ value: "hidden", label: label("hidden", "已隐藏") },
						{ value: "rules", label: label("rules", "有命令规则") },
						{ value: "broken", label: label("broken", "失效") },
					]}
				/>
				<input
					value={q}
					onChange={(e) => setQ(e.target.value)}
					placeholder="搜名字和说明"
					className="w-56 rounded-lg border border-line bg-panel px-3 py-1.5 text-[13px] text-text"
				/>
				<span className="text-[12px] text-muted">绿色直接放行、黄色要你审批、划线的拒绝；规则在提示词页的「命令规则」里改</span>
			</div>
			<Card>
				{rows.map((s) => (
					<Row key={s.name} s={s} />
				))}
				{!rows.length && <div className="py-8 text-center text-[13px] text-muted">没有</div>}
			</Card>
		</div>
	);
}
