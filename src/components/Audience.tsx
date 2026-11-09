import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type Audience, type AudienceData, type AudienceLevel, fetchAudience, post } from "../lib/api";
import { confirmDialog } from "./Confirm";
import { toast } from "./Toast";
import { Card, Segmented, SectionTitle } from "./ui";

const input = "rounded-md border bg-panel px-2.5 py-1.5 text-[14px] text-text [font-family:inherit]";
/** 和后端 saveAudience 的校验一致：飞书用户 ou_、群 oc_ */
const VALID_ID = /^(ou|oc)_[\w-]+$/;
/** 后端只存前 1000 个字，超出的会被悄悄截掉，所以输入时就限住 */
const NOTE_MAX = 1000;

function useSave() {
	const qc = useQueryClient();
	return async (url: string, body: unknown, done: string) => {
		try {
			await post(url, body);
			toast(done);
			await qc.invalidateQueries({ queryKey: ["audience"] });
			return true;
		} catch (e) {
			toast((e as Error).message, true);
			return false;
		}
	};
}

const Kind = ({ kind }: { kind: "person" | "chat" }) => (
	<span className="shrink-0 rounded bg-soft px-1.5 text-[12px] text-text-2">{kind === "chat" ? "群" : "人"}</span>
);

function Entry({ a, levels }: { a: Audience; levels: AudienceData["levels"] }) {
	const save = useSave();
	const [level, setLevel] = useState<AudienceLevel>(a.level);
	const [note, setNote] = useState(a.note);
	const [name, setName] = useState(a.name);
	const [busy, setBusy] = useState(false);
	const changed = level !== a.level || note !== a.note || name !== a.name;
	const run = async (f: () => Promise<unknown>) => {
		setBusy(true);
		await f();
		setBusy(false);
	};
	return (
		<div className="border-t border-line px-4 py-3 first:border-t-0">
			<div className="flex flex-wrap items-center gap-2">
				<Kind kind={a.kind} />
				<input
					value={name}
					onChange={(e) => setName(e.target.value)}
					placeholder={a.id}
					aria-label="名称"
					className={`${input} min-w-40 flex-1 border-line font-semibold sm:max-w-64`}
				/>
				<div className="ml-auto">
					<Segmented
						value={level}
						onChange={setLevel}
						options={(Object.keys(levels) as AudienceLevel[]).map((l) => ({ value: l, label: levels[l].name }))}
					/>
				</div>
			</div>
			<div className="mt-2 text-[12px] text-muted">{levels[level].prompt || "不额外限制，按起草规则写。"}</div>
			<textarea
				value={note}
				maxLength={NOTE_MAX}
				onChange={(e) => setNote(e.target.value)}
				placeholder="补充说明，例如：PM，先说结论和排期"
				aria-label="补充说明"
				rows={2}
				className={`${input} mt-2 w-full resize-y border-line leading-[1.6]`}
			/>
			<div className="mt-2 flex flex-wrap items-center gap-2">
				<code className="min-w-0 flex-1 break-all text-muted">{a.id}</code>
				<button
					type="button"
					className="btn"
					disabled={busy}
					onClick={async () => {
						if (await confirmDialog({ title: `删除「${a.name}」的设定？`, body: "之后起草不再按这个口径写。", confirmText: "删除" }))
							await run(() => save("/api/audience/remove", { id: a.id }, `已删除「${a.name}」的设定`));
					}}
				>
					删除
				</button>
				<button
					type="button"
					className="btn primary"
					disabled={!changed || busy}
					onClick={() => run(() => save("/api/audience/save", { id: a.id, name, level, note }, "已保存，之后起草会照这个口径写"))}
				>
					保存
				</button>
			</div>
		</div>
	);
}

/** 受众：给人或群设披露等级和补充说明，起草回复时作为「关于对方」带上 */
export function AudiencePage() {
	const { data, error } = useQuery({ queryKey: ["audience"], queryFn: fetchAudience });
	const save = useSave();
	const [id, setId] = useState("");
	const [adding, setAdding] = useState<string | null>(null);
	if (error && !data) return <div className="text-[14px] text-bad">读取失败：{(error as Error).message}</div>;
	if (!data) return <div className="py-10 text-center text-[14px] text-muted">加载中…</div>;
	const idOk = VALID_ID.test(id);
	const add = async (key: string, body: object, done: string) => {
		setAdding(key);
		const ok = await save("/api/audience/save", { level: "normal", ...body }, done);
		setAdding(null);
		return ok;
	};
	return (
		<div className="flex flex-col gap-3">
			<p className="m-0 text-[12px] text-muted">给常联系的人或群设定口径，起草回复时会照着写。</p>
			<div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
				<Card>
					<div className="px-4 pt-3 pb-1">
						<SectionTitle extra={data.items.length ? `${data.items.length} 个` : undefined}>已设定</SectionTitle>
					</div>
					{data.items.map((a) => (
						<Entry key={`${a.id}-${a.updated}`} a={a} levels={data.levels} />
					))}
					{!data.items.length && <div className="py-8 text-center text-[14px] text-muted">还没有设定，可以从最近联系你的人里添加</div>}
				</Card>
				<Card className="p-4">
					<SectionTitle>最近联系你的</SectionTitle>
					<div className="flex flex-col">
						{data.candidates.map((c) => (
							<div key={c.id} className="flex items-center gap-2 border-t border-line py-1.5 first:border-t-0">
								<Kind kind={c.kind} />
								<span className="min-w-0 flex-1 text-[14px] break-words text-text">{c.name || c.id}</span>
								<span className="shrink-0 text-[12px] text-muted tabular-nums" title={`最近找过你 ${c.n} 次`}>
									{c.n} 次
								</span>
								<button
									type="button"
									className="btn sm"
									disabled={adding !== null}
									onClick={() => add(c.id, { id: c.id, name: c.name }, `已添加「${c.name || c.id}」`)}
								>
									添加
								</button>
							</div>
						))}
						{!data.candidates.length && <div className="py-4 text-center text-[14px] text-muted">都已添加</div>}
					</div>
					<form
						className="mt-4 border-t border-line pt-3"
						onSubmit={async (e) => {
							e.preventDefault();
							if (idOk && (await add(id, { id }, "已添加"))) setId("");
						}}
					>
						<label htmlFor="audience-id" className="block text-[12px] text-muted">
							按 ID 添加
						</label>
						<div className="mt-1 flex gap-2">
							<input
								id="audience-id"
								value={id}
								onChange={(e) => setId(e.target.value.trim())}
								placeholder="ou_ 或 oc_ 开头"
								spellCheck={false}
								aria-invalid={Boolean(id) && !idOk}
								className={`${input} min-w-0 flex-1 ${id && !idOk ? "border-bad" : "border-line"}`}
							/>
							<button type="submit" className="btn" disabled={!idOk || adding !== null}>
								添加
							</button>
						</div>
						{id && !idOk && <div className="mt-1 text-[12px] text-bad">用户 ID 以 ou_ 开头，群 ID 以 oc_ 开头</div>}
					</form>
				</Card>
			</div>
		</div>
	);
}
