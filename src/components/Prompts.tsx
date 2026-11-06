import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type PromptFile, fetchPrompt, fetchPromptHistory, fetchPromptVersion, fetchPrompts, post } from "../lib/api";
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
	if (!lines.some((l) => l.t !== " ")) return <div className="py-6 text-center text-[13px] text-muted">{empty}</div>;
	const near = new Set<number>();
	lines.forEach((l, i) => {
		if (l.t !== " ") for (let k = i - 3; k <= i + 3; k++) near.add(k);
	});
	return (
		<pre className="m-0 max-h-[60vh] overflow-auto rounded-lg border border-line bg-bg p-2 font-mono text-[12px] leading-5">
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
	const current = text ?? data?.content ?? "";
	const changed = data != null && text != null && text !== data.content;
	async function save() {
		setBusy(true);
		try {
			await post("/api/prompts/save", { path: file.path, content: current });
			toast("已保存，下一次运行生效");
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
	return (
		<Card className="flex min-w-0 flex-1 flex-col p-4">
			<div className="flex flex-wrap items-center gap-2">
				<b className="text-[15px] text-text">{file.name}</b>
				<code className="text-[12px] text-muted">{file.path}</code>
				{file.dirty && <span className="rounded bg-warn-soft px-1.5 py-0.5 text-[11px] text-warn">有未提交的改动</span>}
				<span className="ml-auto text-[12px] text-muted">{file.usedBy}</span>
			</div>
			<div className="mt-3 flex items-center gap-2">
				<Segmented
					value={tab}
					onChange={setTab}
					options={[
						{ value: "edit", label: "编辑" },
						{ value: "diff", label: "和已提交的对比" },
						{ value: "history", label: `历史 ${history?.length ?? ""}` },
					]}
				/>
				<div className="ml-auto flex gap-2">
					{changed && (
						<button
							type="button"
							className="cursor-pointer rounded-md border border-line bg-panel px-3 py-1 text-[13px] text-text"
							onClick={() => setText(null)}
						>
							撤销修改
						</button>
					)}
					<button
						type="button"
						disabled={!changed || busy}
						onClick={save}
						className="cursor-pointer rounded-md border border-accent bg-accent px-3 py-1 text-[13px] text-white disabled:cursor-default disabled:opacity-40"
					>
						保存
					</button>
				</div>
			</div>
			<div className="mt-3 min-h-0 flex-1">
				{tab === "edit" && (
					<textarea
						value={current}
						spellCheck={false}
						onChange={(e) => setText(e.target.value)}
						onKeyDown={(e) => {
							if ((e.metaKey || e.ctrlKey) && e.key === "s") {
								e.preventDefault();
								if (changed) void save();
							}
						}}
						className="h-[62vh] w-full resize-y rounded-lg border border-line bg-bg p-3 font-mono text-[12.5px] leading-5 text-text"
					/>
				)}
				{tab === "diff" && <Diff from={data?.head ?? ""} to={current} empty={data?.head == null ? "还没提交过" : "和已提交的版本一样"} />}
				{tab === "history" && (
					<div className="flex flex-col gap-3">
						<div className="flex flex-col">
							{history?.map((h) => (
								<button
									key={h.rev}
									type="button"
									onClick={() => setRev(h.rev === rev ? null : h.rev)}
									className={`flex cursor-pointer items-center gap-3 border-0 border-t border-line px-2 py-1.5 text-left text-[13px] first:border-t-0 ${h.rev === rev ? "bg-accent-soft" : "bg-transparent hover:bg-soft"}`}
								>
									<code className="text-[12px] text-accent">{h.rev}</code>
									<span className="min-w-0 flex-1 truncate text-text">{h.subject}</span>
									<span className="text-[12px] text-muted">
										{new Date(h.at * 1000).toLocaleString("zh-CN", {
											hour12: false,
											month: "2-digit",
											day: "2-digit",
											hour: "2-digit",
											minute: "2-digit",
										})}
									</span>
								</button>
							))}
							{!history?.length && <div className="py-4 text-center text-[13px] text-muted">没有提交记录</div>}
						</div>
						{rev && old != null && (
							<>
								<div className="flex items-center gap-2 text-[12px] text-muted">
									<span>{rev} 的版本 → 编辑框里的内容（红色是这个版本有、现在没有的）</span>
									<button
										type="button"
										className="ml-auto cursor-pointer rounded-md border border-line bg-panel px-2.5 py-1 text-[12px] text-text"
										onClick={async () => {
											if (
												await confirmDialog({
													title: `把编辑框换成 ${rev} 的版本？`,
													body: "只是载入编辑框，点保存才写入文件。",
													confirmText: "载入",
												})
											) {
												setText(old);
												setTab("edit");
												toast(`已载入 ${rev} 的版本，保存后生效`);
											}
										}}
									>
										回滚到这个版本
									</button>
								</div>
								<Diff from={old} to={current} empty="和编辑框里的一样" />
							</>
						)}
					</div>
				)}
			</div>
		</Card>
	);
}

/** 提示词：给 agent 的规则和配置，在这里改、看历史、回滚；改完下一次运行就生效，改动留在工作区由你提交 */
export function PromptsPage() {
	const { data: files, error } = useQuery({ queryKey: ["prompts"], queryFn: fetchPrompts });
	const [sel, setSel] = useState<string | null>(null);
	const file = files?.find((f) => f.path === sel) ?? files?.[0];
	if (error && !files) return <div className="text-[13px] text-bad">读取失败：{(error as Error).message}</div>;
	return (
		<div className="flex items-start gap-4">
			<Card className="w-72 shrink-0 p-2">
				{files?.map((f) => (
					<button
						key={f.path}
						type="button"
						onClick={() => setSel(f.path)}
						className={`block w-full cursor-pointer rounded-lg border-0 px-3 py-2 text-left ${f.path === file?.path ? "bg-accent-soft" : "bg-transparent hover:bg-soft"}`}
					>
						<div className="flex items-center gap-2">
							<span className={`text-[13px] font-semibold ${f.path === file?.path ? "text-accent" : "text-text"}`}>{f.name}</span>
							{f.dirty && <span className="h-1.5 w-1.5 rounded-full bg-warn" title="有未提交的改动" />}
						</div>
						<div className="mt-0.5 truncate text-[12px] text-muted">{f.usedBy}</div>
					</button>
				))}
			</Card>
			{file && <Editor key={file.path} file={file} />}
		</div>
	);
}
