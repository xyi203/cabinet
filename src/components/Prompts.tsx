import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type PromptFile, fetchPrompt, fetchPromptHistory, fetchPromptVersion, fetchPrompts, post } from "../lib/api";
import { AGENT_NAME, time, when } from "../lib/format";
import { confirmDialog } from "./Confirm";
import { toast } from "./Toast";
import { Card, Segmented } from "./ui";

type Line = { t: " " | "+" | "-"; s: string };

/** 按行对比（LCS）：提示词文件只有几百行，够用 */
export function diffLines(a: string, b: string): Line[] {
	const x = a.split("\n");
	const y = b.split("\n");
	const n = x.length;
	const m = y.length;
	const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
	for (let i = n - 1; i >= 0; i--)
		for (let j = m - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
	const out: Line[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (x[i] === y[j]) {
			out.push({ t: " ", s: x[i] });
			i++;
			j++;
		} else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ t: "-", s: x[i++] });
		else out.push({ t: "+", s: y[j++] });
	}
	while (i < n) out.push({ t: "-", s: x[i++] });
	while (j < m) out.push({ t: "+", s: y[j++] });
	return out;
}

/** 只显示改动附近 3 行，其余折叠 */
function Diff({ from, to, empty }: { from: string; to: string; empty: string }) {
	const lines = diffLines(from, to);
	if (!lines.some((l) => l.t !== " ")) return <div className="py-6 text-center text-[14px] text-muted">{empty}</div>;
	const near = new Set<number>();
	lines.forEach((l, i) => {
		if (l.t !== " ") for (let k = i - 3; k <= i + 3; k++) near.add(k);
	});
	return (
		<pre className="code m-0 max-h-[60vh] overflow-auto rounded-md border border-line bg-bg p-2 leading-5 whitespace-pre-wrap">
			{lines.map((l, i) =>
				near.has(i) ? (
					<div key={i} className={l.t === "+" ? "bg-ok-soft text-ok" : l.t === "-" ? "bg-bad-soft text-bad" : "text-text"}>
						{l.t} {l.s || " "}
					</div>
				) : near.has(i - 1) ? (
					<div key={i} className="text-muted">
						…
					</div>
				) : null,
			)}
		</pre>
	);
}

/** 后端给的文件名和用途是给开发看的（agent、ack 档）；界面上换成白话，没登记的新文件再按词替换 */
const KNOWN: Record<string, [name: string, usedBy: string]> = {
	"config/system.md": ["通用规则", "所有助手都要遵守"],
	"config/draft.md": ["起草规则", "起草和改写回复时使用"],
	"config/agents.json": ["助手配置", "模型、思考强度、能用的工具和技能"],
	"config/skill-rules.json": ["命令规则", "哪些命令直接执行、要你批准或不允许"],
	"config/agents/assistant.md": ["助手", "处理别人发给你的消息"],
	"config/agents/ack.md": ["简单回应", "只需回个表情或不用回的消息"],
	"config/agents/alert.md": ["告警助手", "分析群里的告警"],
	"config/agents/dev.md": ["开发助手", "按需求改代码"],
};
const TIER: Record<string, string> = { ack: "简单回应", answer: "一般问题", deep: "深入排查", mr: "MR 预审" };
function label(f: PromptFile): [string, string] {
	const k = KNOWN[f.path];
	if (k) return k;
	const usedBy = f.usedBy
		.replace(/没有 agent 引用/, "没有助手使用")
		.replace(/(\w+) · (\w+) 档/g, (_, a, t) => `${AGENT_NAME[a] ?? a}的「${TIER[t] ?? t}」`)
		.replace(/\b(assistant|dev|alert)\b/g, (a) => AGENT_NAME[a] ?? a);
	return [f.name, usedBy];
}

type Tab = "edit" | "diff" | "history";

function Editor({ file }: { file: PromptFile }) {
	const qc = useQueryClient();
	const { data } = useQuery({ queryKey: ["prompt", file.path], queryFn: () => fetchPrompt(file.path) });
	const { data: history } = useQuery({ queryKey: ["prompt-history", file.path], queryFn: () => fetchPromptHistory(file.path) });
	const [text, setText] = useState<string | null>(null);
	const [tab, setTab] = useState<Tab>("edit");
	const [rev, setRev] = useState<string | null>(null);
	const { data: old } = useQuery({
		queryKey: ["prompt-version", file.path, rev],
		queryFn: () => fetchPromptVersion(file.path, rev!),
		enabled: Boolean(rev),
	});
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState("");
	const current = text ?? data?.content ?? "";
	const changed = data != null && text != null && text !== data.content;
	const empty = changed && !current.trim();
	const [name, usedBy] = label(file);
	const picked = history?.find((h) => h.rev === rev);

	async function save() {
		if (!changed || empty || busy) return;
		// JSON 先在本地查一遍，错在哪一行当场看得到；后端也会再校验
		if (file.json) {
			try {
				JSON.parse(current);
			} catch (e) {
				// 浏览器的报错是英文，只取出行列号
				const at = /line (\d+) column (\d+)/.exec((e as Error).message);
				setErr(at ? `JSON 格式有误，在第 ${at[1]} 行第 ${at[2]} 列附近` : "JSON 格式有误");
				return;
			}
		}
		setBusy(true);
		try {
			await post("/api/prompts/save", { path: file.path, content: current });
			toast("已保存，下次运行时生效");
			await qc.invalidateQueries({ queryKey: ["prompt", file.path] });
			// 重新读到文件后，编辑框回到以文件内容为准（换文件时 Editor 按 path 重新挂载，不用另外处理）
			setText(null);
			await qc.invalidateQueries({ queryKey: ["prompts"] });
		} catch (e) {
			toast((e as Error).message, true);
		} finally {
			setBusy(false);
		}
	}
	async function discard() {
		if (await confirmDialog({ title: "放弃未保存的改动？", body: "编辑框会回到文件里现在的内容。", confirmText: "放弃改动" })) {
			setText(null);
			setErr("");
		}
	}
	async function restore() {
		if (old == null) return;
		// 只是载入编辑框，还要保存才写入；编辑框里有没保存的改动时才需要确认，免得被覆盖
		if (
			changed &&
			!(await confirmDialog({ title: "用这个版本替换编辑框里的内容？", body: "你还没保存的改动会丢失。", confirmText: "替换" }))
		)
			return;
		setText(old);
		setErr("");
		setTab("edit");
		toast("已载入这个版本，保存后生效");
	}

	return (
		<Card className="flex min-w-0 flex-1 flex-col p-4">
			<div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
				<h2 className="m-0 text-[14px] font-semibold text-text">{name}</h2>
				<code className="break-all text-muted">{file.path}</code>
				{file.dirty && (
					<span className="text-[12px] text-muted" title="已保存的改动还没提交到 git，需要你自己提交">
						未提交
					</span>
				)}
			</div>
			<div className="mt-0.5 text-[12px] text-muted">{usedBy}</div>
			<div className="mt-3 flex flex-wrap items-center gap-2">
				<Segmented
					value={tab}
					onChange={setTab}
					options={[
						{ value: "edit", label: "编辑" },
						{ value: "diff", label: "改动" },
						{ value: "history", label: "历史版本" },
					]}
				/>
				<div className="ml-auto flex flex-wrap items-center gap-2">
					{changed && (
						<span className={`text-[12px] ${empty ? "text-bad" : "text-muted"}`}>{empty ? "内容不能为空" : "保存后，下次运行时生效"}</span>
					)}
					{changed && (
						<button type="button" className="btn" disabled={busy} onClick={discard}>
							放弃改动
						</button>
					)}
					<button type="button" className="btn primary" disabled={!changed || empty || busy} onClick={save}>
						保存
					</button>
				</div>
			</div>
			<div className="mt-3 min-h-0 flex-1">
				{tab === "edit" && (
					<>
						<textarea
							value={current}
							spellCheck={false}
							// JSON 不折行，缩进才看得清层级
							wrap={file.json ? "off" : undefined}
							aria-label={`${name}的内容`}
							aria-invalid={Boolean(err)}
							onChange={(e) => {
								setText(e.target.value);
								setErr("");
							}}
							onKeyDown={(e) => {
								if ((e.metaKey || e.ctrlKey) && e.key === "s") {
									e.preventDefault();
									void save();
								}
							}}
							// JSON 是配置，用等宽；提示词是自然语言，用正文字体
							className={`h-[62vh] w-full resize-y rounded-md border bg-bg p-3 text-text ${err ? "border-bad" : "border-line"} ${
								file.json ? "code leading-5 [tab-size:2]" : "text-[14px] leading-[1.7] [font-family:inherit]"
							}`}
						/>
						{err && <div className="mt-1 text-[12px] text-bad">{err}</div>}
					</>
				)}
				{tab === "diff" && (
					<Diff from={data?.head ?? ""} to={current} empty={data?.head == null ? "还没有提交过" : "和上次提交的版本相同"} />
				)}
				{tab === "history" && (
					<div className="flex flex-col gap-3">
						<div className="flex flex-col overflow-hidden rounded-md border border-line">
							{history?.map((h) => (
								<button
									key={h.rev}
									type="button"
									aria-pressed={h.rev === rev}
									onClick={() => setRev(h.rev === rev ? null : h.rev)}
									className={`flex cursor-pointer items-baseline gap-3 border-0 border-t border-line px-3 py-2 text-left first:border-t-0 ${
										h.rev === rev ? "bg-accent-soft" : "bg-transparent hover:bg-soft"
									}`}
								>
									<span className="min-w-0 flex-1 text-[14px] text-text">{h.subject}</span>
									<span className="shrink-0 text-[12px] text-muted tabular-nums" title={time(h.at)}>
										{when(h.at)}
									</span>
								</button>
							))}
							{history && !history.length && <div className="py-6 text-center text-[14px] text-muted">还没有提交记录</div>}
						</div>
						{picked && old != null && (
							<>
								<div className="flex flex-wrap items-center gap-2">
									<span className="text-[12px] text-muted">{when(picked.at)} 的版本 → 当前内容</span>
									<button type="button" className="btn ml-auto" onClick={restore}>
										恢复这个版本
									</button>
								</div>
								<Diff from={old} to={current} empty="和当前内容相同" />
							</>
						)}
					</div>
				)}
			</div>
		</Card>
	);
}

/** 提示词：给助手的规则和配置，在这里改、看历史、恢复旧版本；改完下一次运行就生效，改动留在工作区由你提交 */
export function PromptsPage() {
	const { data: files, error } = useQuery({ queryKey: ["prompts"], queryFn: fetchPrompts });
	const [sel, setSel] = useState<string | null>(null);
	const file = files?.find((f) => f.path === sel) ?? files?.[0];
	if (error && !files) return <div className="text-[14px] text-bad">读取失败：{(error as Error).message}</div>;
	if (!files) return <div className="py-10 text-center text-[14px] text-muted">加载中…</div>;
	const groups: Array<[string, PromptFile[]]> = [
		["通用", files.filter((f) => !f.path.startsWith("config/agents/"))],
		["各助手", files.filter((f) => f.path.startsWith("config/agents/"))],
	];
	return (
		<div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:gap-4">
			{/* 窄屏放不下侧栏，换成下拉选择 */}
			<select
				aria-label="选择文件"
				value={file?.path}
				onChange={(e) => setSel(e.target.value)}
				className="rounded-md border border-line bg-panel px-2.5 py-1.5 text-[14px] text-text [font-family:inherit] lg:hidden"
			>
				{groups.map(([g, fs]) => (
					<optgroup key={g} label={g}>
						{fs.map((f) => (
							<option key={f.path} value={f.path}>
								{label(f)[0]}
							</option>
						))}
					</optgroup>
				))}
			</select>
			<Card className="hidden w-64 shrink-0 p-2 lg:block">
				{groups.map(([g, fs]) => (
					<div key={g} className="mt-2 first:mt-0">
						<div className="px-3 pt-1 pb-1 text-[12px] text-muted">{g}</div>
						{fs.map((f) => {
							const on = f.path === file?.path;
							const [n, u] = label(f);
							return (
								<button
									key={f.path}
									type="button"
									aria-current={on}
									onClick={() => setSel(f.path)}
									className={`block w-full cursor-pointer rounded-md border-0 px-3 py-2 text-left ${on ? "bg-accent-soft" : "bg-transparent hover:bg-soft"}`}
								>
									<div className="flex items-baseline gap-2">
										<span className={`text-[14px] font-semibold ${on ? "text-accent" : "text-text"}`}>{n}</span>
										{f.dirty && (
											<span className="ml-auto text-[12px] text-muted" title="已保存的改动还没提交到 git">
												未提交
											</span>
										)}
									</div>
									<div className="mt-0.5 text-[12px] text-muted">{u}</div>
								</button>
							);
						})}
					</div>
				))}
			</Card>
			{file && <Editor key={file.path} file={file} />}
		</div>
	);
}
