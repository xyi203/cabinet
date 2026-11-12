// 一件事现在能做什么，只在这里定义一次，形式照 Claude 的选择提示：编号选项（1 / 2 / 3、↑ ↓ 回车、Esc 选否定的那项），
// 工作台底部常驻的输入框是最后一项——打字发出就用你写的（草稿：原样以你的身份发出；审批：当拒绝理由；agent 任务：追问 / 插话）。
// 「/改写 xxx」让助手按意见重写草稿。
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { type Draft, type State, type TaskView, post } from "../lib/api";
import { GLYPH, describeDraft } from "../lib/format";
import { toast } from "./Toast";

export type Kind = "text" | "reaction" | "sticker";
/** 发到哪：reply 回原来那条，dm 私聊对方（server/drafts/actions.ts Target） */
export type Target = "reply" | "dm";

/** 返回给提示条的一句话 */
type Run = (note: string, kind?: Kind) => Promise<string>;

export interface PickItem {
	key: string;
	kind: Exclude<Kind, "text">;
}

export interface Option {
	key: string;
	label: React.ReactNode;
	/** Esc 选它 */
	neg?: boolean;
	/** 办完这件事，跳到下一件 */
	advance?: boolean;
	/** 选了以后就地出一排可选的（表情、表情包），选中的 key 和类型交给 run */
	pick?: PickItem[];
	/** 选项右边的附加控件（发到哪），点它不会触发选项本身 */
	extra?: React.ReactNode;
	run: Run;
}
/** 输入框发出时做什么 */
export interface TypeIn {
	hint: string;
	advance?: boolean;
	run: (text: string) => Promise<string>;
}
export interface Slash {
	cmd: string;
	hint: string;
	run: (arg: string) => Promise<string>;
}
export interface Actions {
	options: Option[];
	typeIn?: TypeIn;
	slash: Slash[];
}

export interface TargetChoice {
	key: Target;
	label: string;
}

/** 草稿能发去哪：私聊只有原处；群里和飞书项目评论还能私聊对方。表情是加在原消息上的，没得选 */
export function targetsOf(d: Pick<Draft, "chatMode" | "kind" | "senderName" | "chatName">): TargetChoice[] {
	if (d.chatMode === "p2p" || d.kind === "reaction") return [];
	const dm: TargetChoice = { key: "dm", label: `私聊 ${d.senderName}` };
	if (d.chatMode === "meego") return [{ key: "reply", label: "工作项评论里回复" }, dm];
	return [{ key: "reply", label: `${d.chatName ? `「${d.chatName}」` : "群"}里回复原消息` }, dm];
}

function TargetSwitch({ ts, cur, onChange }: { ts: TargetChoice[]; cur: Target; onChange: (t: Target) => void }) {
	return (
		<span className="chips flex shrink-0 items-center gap-1 text-[12px] text-muted" role="radiogroup" aria-label="发到哪">
			发到
			{ts.map((g) => (
				<button
					key={g.key}
					role="radio"
					aria-checked={cur === g.key}
					className={`chip${cur === g.key ? " on" : ""}`}
					onClick={() => onChange(g.key)}
				>
					{g.label}
				</button>
			))}
		</span>
	);
}

const enc = encodeURIComponent;

export interface Ctx {
	s: State;
	/** 草稿框里正在改的字；没改过就是 undefined，发最新一版 */
	text?: string;
	to: Target;
	setTo: (t: Target) => void;
	picks: PickItem[];
	onMemory: () => void;
}

/** 这件事现在挂着的草稿（最新一版） */
export const draftOf = (t: TaskView, s: State): Draft | undefined => {
	const id = t.drafts.at(-1);
	return id ? s.drafts.find((d) => d.id === id) : undefined;
};
export const devOf = (t: TaskView, s: State) => (t.devTasks.length ? s.devTasks.find((d) => d.id === t.devTasks.at(-1)) : undefined);

export function actionsOf(t: TaskView | undefined, c: Ctx): Actions {
	const none: Actions = { options: [], slash: [] };
	if (!t) return none;
	const { s } = c;
	const draft = draftOf(t, s);
	const dev = devOf(t, s);
	const devRunning = dev && (dev.status === "running" || dev.status === "pushing");
	const done: Option = {
		key: "done",
		label: "完成（已经在别处处理了）",
		advance: true,
		run: () => post(`/api/tasks/${enc(t.id)}/done`).then(() => "好的，算你已处理"),
	};
	const talk: TypeIn | undefined = dev
		? {
				hint: devRunning ? "或者插一句，它会在下一步之前看到" : "或者接着问、补充要求",
				run: (v) =>
					post<{ mode: string }>(`/api/dev/${dev.id}/message`, { text: v }).then((r) =>
						r.mode === "steered" ? "已发送，它会在下一步之前看到" : "已发送，助手开始处理",
					),
			}
		: undefined;

	if (t.status === "in_review" && t.need === "send" && draft && (draft.status === "pending" || draft.status === "noreply")) {
		const d = draft;
		// 在草稿框里写了字：不管助手建议的是表情还是不回复，「发送」发的都是你写的
		const typed = c.text?.trim();
		const emoji = d.kind !== "text" && d.status === "pending" && !typed;
		const ts = targetsOf({ ...d, kind: emoji ? d.kind : "text" });
		const to = ts.length ? c.to : "reply";
		const where = ts.find((g) => g.key === to)?.label ?? (d.chatMode === "p2p" ? `和 ${d.senderName} 的私聊` : "原处");
		const send = (text: string, kind: Kind) =>
			post(`/api/drafts/${d.id}/send`, { text, kind, to: kind === "reaction" ? "reply" : to }).then(() =>
				to === "dm" && kind !== "reaction" ? `已私聊发给 ${d.senderName}` : "已发送",
			);
		const meego = d.chatMode === "meego";
		const options: Option[] = [];
		if (d.status === "pending" || typed)
			options.push(
				emoji
					? { key: "send", label: `回${describeDraft(d)}`, advance: true, run: () => send(d.draft, d.kind) }
					: {
							key: "send",
							label: `发送给 ${d.senderName}`,
							extra: ts.length > 1 ? <TargetSwitch ts={ts} cur={to} onChange={c.setTo} /> : undefined,
							advance: true,
							// 草稿框被清空了就别把助手的原稿发出去
							run: () =>
								typed || c.text === undefined ? send(typed || d.draft, "text") : Promise.reject(new Error("回复是空的，写点什么再发")),
						},
			);
		if (!meego && c.picks.length)
			options.push({
				key: "pick",
				label: emoji ? "换一个表情或表情包" : "回表情或表情包",
				pick: c.picks,
				advance: true,
				run: (key, kind) => send(key, kind ?? "reaction"),
			});
		options.push(
			{
				key: "discard",
				label: d.status === "noreply" ? "不回复（助手也这么建议）" : "不回复",
				neg: true,
				advance: true,
				run: () => post(`/api/drafts/${d.id}/discard`).then(() => "好的，这条不回复"),
			},
			{
				key: "complete",
				label: "完成（已经在别处回过了）",
				advance: true,
				run: () => post(`/api/drafts/${d.id}/complete`).then(() => "已完成"),
			},
		);
		return {
			options,
			// 输入框里写的就是要发的：原样以你的身份发出，不用助手的稿
			typeIn: { hint: `或者自己写，回车直接发到${where}`, advance: true, run: (v) => send(v, "text") },
			slash: [
				{
					cmd: "/改写",
					hint: "让助手按你的意见重写",
					run: (arg) => post(`/api/drafts/${d.id}/revise`, { text: arg || "再改改" }).then(() => "正在改写，好了会回到「等你」"),
				},
			],
		};
	}
	const apv = t.need === "approve" ? s.approvals.find((a) => t.approvals.includes(a.id)) : undefined;
	if (apv) {
		return {
			options: [
				{
					key: "approve",
					label: "批准",
					advance: true,
					run: () => post(`/api/approvals/${apv.id}/approve`, {}).then(() => "已批准，正在执行"),
				},
				...(apv.learn
					? [
							{
								key: "remember",
								// learn 是后端写好的一句：「glab 的 mr list 记成只读」「新建规则 x，放行 y」
								label: (
									<>
										批准，以后不再问 <span className="text-[12px] text-muted">（{apv.learn}）</span>
									</>
								),
								advance: true,
								run: () => post(`/api/approvals/${apv.id}/remember`, {}).then(() => "已批准，以后同类命令直接执行"),
							},
						]
					: []),
				{
					key: "reject",
					label: "拒绝",
					neg: true,
					advance: true,
					run: () => post(`/api/approvals/${apv.id}/reject`, {}).then(() => "已拒绝"),
				},
			],
			typeIn: {
				hint: "或者告诉它换个做法（等于拒绝）",
				advance: true,
				run: (v) => post(`/api/approvals/${apv.id}/reject`, { note: v }).then(() => "已拒绝，理由已转给它"),
			},
			slash: [],
		};
	}
	if (t.need === "decide" && t.memories)
		return { options: [{ key: "memory", label: "去记忆页处理", run: async () => (c.onMemory(), "") }], slash: [] };
	if (t.need === "retry" && t.status === "blocked") {
		if (t.retryId)
			return {
				options: [
					{ key: "retry", label: "重试", advance: true, run: () => post(`/api/tasks/${t.retryId}/retry`).then(() => "正在重试") },
					{
						key: "dismiss",
						label: "忽略",
						neg: true,
						advance: true,
						run: () => post(`/api/tasks/${t.retryId}/dismiss`).then(() => "已忽略"),
					},
				],
				slash: [],
			};
		if (dev)
			return {
				options: [
					{
						key: "retry",
						label: "重试",
						advance: true,
						run: () => post(`/api/dev/${dev.id}/message`, { text: "上一轮失败了，接着把这个任务做完" }).then(() => "正在重试"),
					},
				],
				typeIn: talk,
				slash: [],
			};
	}
	if (dev && devRunning)
		return {
			options: [{ key: "stop", label: "停止", neg: true, run: () => post(`/api/dev/${dev.id}/stop`).then(() => "已停止") }],
			typeIn: talk,
			slash: [],
		};
	if (dev && t.need === "read" && t.status === "in_review")
		return {
			options: [{ key: "close", label: "完成", advance: true, run: () => post(`/api/dev/${dev.id}/close`).then(() => "已完成") }],
			typeIn: talk,
			slash: [],
		};
	// 有改动等推送的开发任务：推送要看 diff，在上面任务里点；这里只能接着说
	if (dev && t.status === "in_review") return { options: [], typeIn: talk, slash: [] };
	if (t.status === "in_progress" && !dev)
		return {
			options: [
				...(t.runId
					? [{ key: "stop", label: "停止", neg: true, run: () => post("/api/runs/stop", { key: t.runId }).then(() => "已停止") }]
					: []),
				done,
			],
			slash: [],
		};
	if (t.status === "todo")
		return {
			options: [
				...(t.id.startsWith("q:") && t.hold
					? [{ key: "now", label: "不等了，现在起草", run: () => post("/api/poll", { id: t.id.slice(2) }).then(() => "开始起草") }]
					: []),
				{ ...done, label: "完成（不用做了）", neg: true },
			],
			slash: [],
		};
	return none;
}

/** 输入框里发出的一句话：先匹配 /命令，否则交给这件事的 typeIn；没执行时返回给用户看的提示 */
export function matchText(actions: Actions, v: string): { run?: () => Promise<string>; advance?: boolean; hint?: string } {
	const { typeIn, slash } = actions;
	const sl = slash.find((x) => v === x.cmd || v.startsWith(`${x.cmd} `));
	if (sl) return { run: () => sl.run(v.slice(sl.cmd.length).trim()) };
	if (v.startsWith("/"))
		return { hint: slash.length ? `可以用：${slash.map((x) => `${x.cmd}（${x.hint}）`).join("、")}` : "这件事没有可用的命令" };
	if (!typeIn) return { hint: "这件事现在不需要你写什么，选上面的一项就行" };
	return { run: () => typeIn.run(v), advance: typeIn.advance };
}

/** 跑一个动作：提示条报结果、刷新看板；成功才算办完（跳下一件） */
export function useRunner() {
	const qc = useQueryClient();
	const [busy, setBusy] = useState(false);
	async function exec(run: () => Promise<string>): Promise<boolean> {
		if (busy) return false;
		setBusy(true);
		try {
			const msg = await run();
			if (msg) toast(msg);
			void qc.invalidateQueries({ queryKey: ["state"] });
			return true;
		} catch (e) {
			toast((e as Error).message, true);
			return false;
		} finally {
			setBusy(false);
		}
	}
	return { busy, exec };
}

/**
 * Claude 式的选择：编号选项。数字键 / ↑ ↓ 回车 / Esc 只在没在打字时生效；
 * 打字的输入框在外面（工作台底部常驻），它发出的话由 matchText 处理
 */
export function Choices({ actions, onAdvance }: { actions: Actions; onAdvance: () => void }) {
	const { busy, exec } = useRunner();
	const { options } = actions;
	const [cur, setCur] = useState(0);
	const [open, setOpen] = useState<number>();
	const fire = async (i: number, n = "", kind?: Kind) => {
		const o = options[i];
		setOpen(undefined);
		if ((await exec(() => o.run(n, kind))) && o.advance) onAdvance();
	};
	const pick = (i: number) => {
		if (!options[i] || busy) return;
		setCur(i);
		if (options[i].pick) setOpen(open === i ? undefined : i);
		else void fire(i);
	};
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const el = document.activeElement as HTMLElement | null;
			if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
			if (e.metaKey || e.ctrlKey || e.altKey || document.querySelector("dialog.confirm[open]")) return;
			const n = Number(e.key);
			if (n >= 1 && n <= options.length) pick(n - 1);
			else if (e.key === "ArrowDown") {
				e.preventDefault();
				setCur((x) => Math.min(options.length - 1, x + 1));
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				setCur((x) => Math.max(0, x - 1));
			}
			// 焦点在别的按钮上时回车是点那个按钮，不能顺手批准、发送了
			else if (e.key === "Enter" && el?.tagName !== "BUTTON") pick(cur);
			else if (e.key === "Escape") {
				const i = options.findIndex((o) => o.neg);
				if (i >= 0) pick(i);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	});
	if (!options.length) return null;
	return (
		<div className={`flex flex-col${busy ? " opacity-60" : ""}`}>
			{options.map((o, i) => (
				<div key={o.key}>
					<div className={`flex items-center gap-2 rounded-[6px] pr-2 ${cur === i ? "bg-accent-soft" : ""}`} onMouseEnter={() => setCur(i)}>
						<button
							disabled={busy}
							onClick={() => pick(i)}
							className={`flex flex-1 items-center gap-2 border-0 bg-transparent px-2 py-1.5 text-left text-[14px] ${cur === i ? "text-accent" : "text-text"}`}
						>
							<span className="w-3 text-accent">{cur === i ? "›" : ""}</span>
							<span className="w-4 text-muted tabular-nums">{i + 1}.</span>
							<span>{o.label}</span>
							{o.neg && <span className="ml-auto text-[12px] text-muted">Esc</span>}
						</button>
						{o.extra}
					</div>
					{open === i && o.pick && (
						<div className="my-1 ml-9 flex flex-col gap-2">
							{(["reaction", "sticker"] as const).map((k) => {
								const items = o.pick!.filter((p) => p.kind === k);
								if (!items.length) return null;
								return (
									<div key={k} className="flex items-start gap-2">
										<span className="w-12 shrink-0 pt-2 text-[12px] text-muted">{k === "reaction" ? "表情" : "表情包"}</span>
										<div className="flex flex-wrap gap-1.5">
											{items.map((p) => (
												<button
													key={p.key}
													title={k === "sticker" ? p.key.replace(/\.[^.]+$/, "") : p.key}
													disabled={busy}
													onClick={() => void fire(i, p.key, p.kind)}
													className={`flex items-center justify-center rounded-[6px] border border-line bg-panel hover:bg-soft ${k === "sticker" ? "h-16 w-16 flex-col overflow-hidden p-1" : "h-9 min-w-9 px-1.5 text-[16px]"}`}
												>
													{k === "reaction" ? (
														(GLYPH[p.key] ?? p.key)
													) : (
														<>
															<img src={`/api/stickers/${enc(p.key)}`} alt="" className="max-h-10 max-w-full" />
															<span className="truncate text-[11px] text-muted">{p.key.replace(/\.[^.]+$/, "")}</span>
														</>
													)}
												</button>
											))}
										</div>
									</div>
								);
							})}
						</div>
					)}
				</div>
			))}
		</div>
	);
}
