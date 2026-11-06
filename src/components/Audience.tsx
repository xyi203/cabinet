import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type Audience, type AudienceData, type AudienceLevel, fetchAudience, post } from "../lib/api";
import { confirmDialog } from "./Confirm";
import { toast } from "./Toast";
import { Card, SectionTitle } from "./ui";

const LEVEL_CLS: Record<AudienceLevel, string> = {
	trusted: "bg-ok-soft text-ok",
	normal: "bg-soft text-muted",
	careful: "bg-warn-soft text-warn",
};
const input = "rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] text-text";

function useSave() {
	const qc = useQueryClient();
	return async (url: string, body: unknown, done: string) => {
		try {
			await post(url, body);
			toast(done);
			await qc.invalidateQueries({ queryKey: ["audience"] });
		} catch (e) {
			toast((e as Error).message, true);
		}
	};
}

function Entry({ a, levels }: { a: Audience; levels: AudienceData["levels"] }) {
	const save = useSave();
	const [level, setLevel] = useState<AudienceLevel>(a.level);
	const [note, setNote] = useState(a.note);
	const [name, setName] = useState(a.name);
	const changed = level !== a.level || note !== a.note || name !== a.name;
	return (
		<div className="border-t border-line px-4 py-3 first:border-t-0">
			<div className="flex flex-wrap items-center gap-2">
				<span className="rounded bg-soft px-1.5 py-0.5 text-[11px] text-muted">{a.kind === "chat" ? "群" : "人"}</span>
				<input value={name} onChange={(e) => setName(e.target.value)} className={`${input} w-40 font-semibold`} />
				<code className="text-[11px] text-muted">{a.id}</code>
				<div className="ml-auto flex gap-1">
					{(Object.keys(levels) as AudienceLevel[]).map((l) => (
						<button
							key={l}
							type="button"
							title={levels[l].prompt || "不额外约束"}
							onClick={() => setLevel(l)}
							className={`cursor-pointer rounded-md border px-2.5 py-1 text-[12px] ${l === level ? `border-transparent ${LEVEL_CLS[l]} font-semibold` : "border-line bg-panel text-muted"}`}
						>
							{levels[l].name}
						</button>
					))}
				</div>
			</div>
			<textarea
				value={note}
				onChange={(e) => setNote(e.target.value)}
				placeholder="处理说明：起草时原样带上，例如「PM，先说结论和排期；技术细节放后面」「外部商家，别提内部系统名」"
				className={`${input} mt-2 h-16 w-full resize-y`}
			/>
			<div className="mt-1.5 flex items-center gap-2 text-[12px] text-muted">
				<span className="min-w-0 flex-1 truncate">{levels[level].prompt}</span>
				<button
					type="button"
					className="cursor-pointer rounded-md border border-line bg-panel px-2.5 py-1 text-[12px] text-bad"
					onClick={async () => {
						if (await confirmDialog({ title: `删除对「${a.name}」的设定？`, body: "之后起草不再带这段口径。", confirmText: "删除" }))
							void save("/api/audience/remove", { id: a.id }, "已删除");
					}}
				>
					删除
				</button>
				<button
					type="button"
					disabled={!changed}
					onClick={() => save("/api/audience/save", { id: a.id, name, level, note }, "已保存，之后起草按这个口径")}
					className="cursor-pointer rounded-md border border-accent bg-accent px-2.5 py-1 text-[12px] text-white disabled:cursor-default disabled:opacity-40"
				>
					保存
				</button>
			</div>
		</div>
	);
}

/** 受众：给人或群设披露等级和处理说明，起草回复时作为「关于对方」带上 */
export function AudiencePage() {
	const { data, error } = useQuery({ queryKey: ["audience"], queryFn: fetchAudience });
	const save = useSave();
	const [id, setId] = useState("");
	if (error && !data) return <div className="text-[13px] text-bad">读取失败：{(error as Error).message}</div>;
	if (!data) return <div className="text-[13px] text-muted">加载中…</div>;
	return (
		<div className="grid items-start gap-4 xl:grid-cols-[1fr_340px]">
			<Card>
				<div className="border-b border-line px-4 py-3">
					<SectionTitle extra={`${data.items.length} 个`}>已设定</SectionTitle>
					<div className="text-[12px] text-muted">
						{(Object.keys(data.levels) as AudienceLevel[]).map((l) => (
							<div key={l}>
								<b className="text-text">{data.levels[l].name}</b>：{data.levels[l].prompt || "不额外约束，按起草规则来"}
							</div>
						))}
					</div>
				</div>
				{data.items.map((a) => (
					<Entry key={`${a.id}-${a.updated}`} a={a} levels={data.levels} />
				))}
				{!data.items.length && <div className="py-8 text-center text-[13px] text-muted">还没有设定，从右边最近找你的人里挑</div>}
			</Card>
			<Card className="p-4">
				<SectionTitle>最近找你的</SectionTitle>
				<div className="flex flex-col">
					{data.candidates.map((c) => (
						<div key={c.id} className="flex items-center gap-2 border-t border-line py-1.5 first:border-t-0">
							<span className="rounded bg-soft px-1.5 py-0.5 text-[11px] text-muted">{c.kind === "chat" ? "群" : "人"}</span>
							<span className="min-w-0 flex-1 truncate text-[13px] text-text">{c.name || c.id}</span>
							<span className="text-[12px] text-muted tabular-nums">{c.n} 次</span>
							<button
								type="button"
								onClick={() =>
									save("/api/audience/save", { id: c.id, name: c.name, level: "normal" }, `已添加 ${c.name}，在左边设等级和说明`)
								}
								className="cursor-pointer rounded-md border border-line bg-panel px-2 py-0.5 text-[12px] text-accent hover:bg-soft"
							>
								添加
							</button>
						</div>
					))}
					{!data.candidates.length && <div className="py-4 text-center text-[13px] text-muted">没有新的</div>}
				</div>
				<div className="mt-3 flex gap-2">
					<input
						value={id}
						onChange={(e) => setId(e.target.value.trim())}
						placeholder="或填 ou_ / oc_ 开头的 ID"
						className={`${input} min-w-0 flex-1`}
					/>
					<button
						type="button"
						disabled={!id}
						onClick={async () => {
							await save("/api/audience/save", { id, level: "normal" }, "已添加");
							setId("");
						}}
						className="cursor-pointer rounded-md border border-line bg-panel px-2.5 py-1 text-[12px] text-text disabled:opacity-40"
					>
						添加
					</button>
				</div>
			</Card>
		</div>
	);
}
