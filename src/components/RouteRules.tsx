// 设置 → 分派规则：消息进来后的几个可调阈值（server/rules.ts），保存后写 config/routes.json，下一条消息就按新的走，不用重启
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { type RouteRules, fetchRoutes, saveRoutes } from "../lib/api";
import { confirmDialog } from "./Confirm";
import { toast } from "./Toast";
import { Card } from "./ui";

/**
 * 可调的数值项。后端一律按秒（巡检是 0–1 的比例）存，界面按量级换成天、小时、分钟、秒或百分比，
 * min / max 是界面单位下的范围，和 server/rules.ts 的校验对齐（个别下限按界面单位取整，比后端略严）
 */
interface NumField {
	unit: string;
	/** 1 个界面单位等于多少存储单位 */
	scale: number;
	min: number;
	max: number;
	/** 只收整数 */
	int?: boolean;
	get: (r: RouteRules) => number;
	put: (r: RouteRules, v: number) => void;
}

type Key = "reopen" | "continue" | "window" | "delay" | "check" | "p2p" | "deep" | "quiet" | "maxWait" | "follow" | "patrol";
const FIELDS: Record<Key, NumField> = {
	reopen: { unit: "天", scale: 86400, min: 0, max: 30, get: (r) => r.reopen, put: (r, v) => void (r.reopen = v) },
	continue: { unit: "分钟", scale: 60, min: 0, max: 1440, get: (r) => r.continueGap, put: (r, v) => void (r.continueGap = v) },
	window: { unit: "分钟", scale: 60, min: 0, max: 60, get: (r) => r.yiActive.window, put: (r, v) => void (r.yiActive.window = v) },
	delay: { unit: "秒", scale: 1, min: 0, max: 600, int: true, get: (r) => r.yiActive.delay, put: (r, v) => void (r.yiActive.delay = v) },
	check: { unit: "秒", scale: 1, min: 1, max: 60, int: true, get: (r) => r.yiActive.check, put: (r, v) => void (r.yiActive.check = v) },
	p2p: { unit: "秒", scale: 1, min: 0, max: 1800, int: true, get: (r) => r.yiActive.p2p, put: (r, v) => void (r.yiActive.p2p = v) },
	deep: { unit: "分钟", scale: 60, min: 0, max: 60, get: (r) => r.yiActive.deep, put: (r, v) => void (r.yiActive.deep = v) },
	quiet: { unit: "秒", scale: 1, min: 10, max: 3600, int: true, get: (r) => r.alert.quiet, put: (r, v) => void (r.alert.quiet = v) },
	maxWait: { unit: "分钟", scale: 60, min: 1, max: 120, get: (r) => r.alert.maxWait, put: (r, v) => void (r.alert.maxWait = v) },
	follow: { unit: "小时", scale: 3600, min: 0, max: 24, get: (r) => r.alert.follow, put: (r, v) => void (r.alert.follow = v) },
	patrol: {
		unit: "%",
		scale: 0.01,
		min: 0,
		max: 100,
		int: true,
		get: (r) => r.cron.patrolPauseAt,
		put: (r, v) => void (r.cron.patrolPauseAt = v),
	},
};

type Form = Record<Key, string> & { senders: string; chats: string };
type Errors = Partial<Record<keyof Form, string>>;

/** 存储值 → 输入框里的字：最多两位小数，0.5 天这类不会显示成 0.49999 */
const show = (f: NumField, v: number) => String(Math.round((v / f.scale) * 100) / 100);

function toForm(r: RouteRules): Form {
	const out = { senders: r.alert.senders.join("\n"), chats: r.alert.chats.join("\n") } as Form;
	for (const k of Object.keys(FIELDS) as Key[]) out[k] = show(FIELDS[k], FIELDS[k].get(r));
	return out;
}

const list = (s: string) =>
	s
		.split(/[\s,，]+/)
		.map((x) => x.trim())
		.filter(Boolean);

/** 校验输入并换回存储单位；有错的项不写进 rules */
function parse(form: Form, base: RouteRules): { rules: RouteRules; errors: Errors } {
	const rules = structuredClone(base);
	const errors: Errors = {};
	for (const k of Object.keys(FIELDS) as Key[]) {
		const f = FIELDS[k];
		const s = form[k].trim();
		const v = Number(s);
		const range = `填 ${f.min} 到 ${f.max} 之间的${f.int ? "整数" : "数字"}`;
		if (!s) errors[k] = "不能留空";
		else if (!/^\d+(\.\d+)?$/.test(s) || v < f.min || v > f.max || (f.int && !Number.isInteger(v))) errors[k] = range;
		// 百分比存成比例（除以 100 而不是乘 0.01，免得 57% 变成 0.5700000000000001）；其余按秒取整
		else f.put(rules, f.scale < 1 ? v / Math.round(1 / f.scale) : Math.round(v * f.scale));
	}
	if (!errors.quiet && !errors.maxWait && rules.alert.maxWait < rules.alert.quiet) errors.maxWait = "不能短于「收齐一批」的时长";
	rules.alert.senders = list(form.senders);
	rules.alert.chats = list(form.chats);
	const bad = rules.alert.chats.find((c) => !/^oc_[\w-]+$/.test(c));
	if (bad) errors.chats = `群 ID 以 oc_ 开头，「${bad}」不是群 ID`;
	return { rules, errors };
}

const same = (a: RouteRules, b: RouteRules) =>
	a.reopen === b.reopen &&
	a.continueGap === b.continueGap &&
	a.yiActive.window === b.yiActive.window &&
	a.yiActive.delay === b.yiActive.delay &&
	a.yiActive.check === b.yiActive.check &&
	a.yiActive.p2p === b.yiActive.p2p &&
	a.yiActive.deep === b.yiActive.deep &&
	a.alert.quiet === b.alert.quiet &&
	a.alert.maxWait === b.alert.maxWait &&
	a.alert.follow === b.alert.follow &&
	a.alert.senders.join("\n") === b.alert.senders.join("\n") &&
	a.alert.chats.join("\n") === b.alert.chats.join("\n") &&
	a.cron.patrolPauseAt === b.cron.patrolPauseAt;

function Section({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
	return (
		<section className="mt-6 first:mt-0">
			<h2 className="m-0 text-[14px] font-semibold text-text">{title}</h2>
			{desc && <p className="m-0 mt-0.5 text-[12px] text-muted">{desc}</p>}
			<Card className="mt-2">{children}</Card>
		</section>
	);
}

/** 一项设置：左边名称和一句「它决定什么」，右边控件；wide 时控件另起一行占满 */
function Row({ id, label, desc, wide, children }: { id?: string; label: string; desc?: string; wide?: boolean; children?: ReactNode }) {
	return (
		<div
			className={`flex flex-col gap-2 border-t border-line px-4 py-3 first:border-t-0 ${wide ? "" : "sm:flex-row sm:items-center sm:gap-6"}`}
		>
			<div className="min-w-0 flex-1">
				<label htmlFor={id} className="block text-[14px] text-text">
					{label}
				</label>
				{desc && <div className="mt-0.5 text-[12px] text-muted">{desc}</div>}
			</div>
			{children}
		</div>
	);
}

export function RouteRulesPage() {
	const qc = useQueryClient();
	const { data, error } = useQuery({ queryKey: ["routes"], queryFn: fetchRoutes });
	const [draft, setDraft] = useState<Form | null>(null);
	const [busy, setBusy] = useState(false);
	if (error && !data) return <div className="text-[14px] text-bad">读取失败：{(error as Error).message}</div>;
	if (!data) return <div className="py-10 text-center text-[14px] text-muted">加载中…</div>;
	const form = draft ?? toForm(data.rules);
	const { rules, errors } = parse(form, data.rules);
	const invalid = Object.keys(errors).length > 0;
	const dirty = draft !== null && (invalid || !same(rules, data.rules));
	const atDefault = !invalid && same(rules, data.defaults);
	const edit = (k: keyof Form) => (e: { target: { value: string } }) => setDraft({ ...form, [k]: e.target.value });

	const num = (k: Key, label: string, desc: string) => {
		const id = `rule-${k}`;
		const err = errors[k];
		return (
			<Row id={id} label={label} desc={desc}>
				<div className="flex shrink-0 flex-col items-start gap-1 sm:items-end">
					<span className="inline-flex items-center gap-2 text-[14px] text-text-2">
						<input
							id={id}
							inputMode={FIELDS[k].int ? "numeric" : "decimal"}
							value={form[k]}
							onChange={edit(k)}
							aria-invalid={Boolean(err)}
							aria-describedby={err ? `${id}-err` : undefined}
							className={`w-20 rounded-md border bg-panel [font-family:inherit] px-2.5 py-1 text-right text-[14px] text-text tabular-nums ${err ? "border-bad" : "border-line"}`}
						/>
						<span className="w-8">{FIELDS[k].unit}</span>
					</span>
					{err && (
						<span id={`${id}-err`} className="text-[12px] text-bad">
							{err}
						</span>
					)}
				</div>
			</Row>
		);
	};
	const ids = (k: "senders" | "chats", label: string, desc: string, placeholder: string) => {
		const id = `rule-${k}`;
		return (
			<Row id={id} label={label} desc={desc} wide>
				<textarea
					id={id}
					value={form[k]}
					onChange={edit(k)}
					placeholder={placeholder}
					spellCheck={false}
					rows={Math.min(6, Math.max(2, form[k].split("\n").length))}
					aria-invalid={Boolean(errors[k])}
					className={`code w-full resize-y rounded-md border bg-panel px-2.5 py-1.5 text-[12px] leading-5 text-text ${errors[k] ? "border-bad" : "border-line"}`}
				/>
				{errors[k] && <div className="text-[12px] text-bad">{errors[k]}</div>}
			</Row>
		);
	};

	async function save() {
		setBusy(true);
		try {
			await saveRoutes(rules);
			await qc.invalidateQueries({ queryKey: ["routes"] });
			setDraft(null);
			toast("已保存，从下一条消息开始生效");
		} catch (e) {
			toast((e as Error).message, true);
		} finally {
			setBusy(false);
		}
	}
	async function discard() {
		if (await confirmDialog({ title: "放弃未保存的改动？", confirmText: "放弃改动" })) setDraft(null);
	}

	return (
		<div className="max-w-[880px]">
			<Section title="已完成的事">
				{num("reopen", "重新打开的期限", "话题、工作项或 MR 完成后，这段时间内来了新消息，会重新打开原来那件事，不另起一件。")}
				{num(
					"continue",
					"接着聊的间隔",
					"私聊和群里不在话题中的消息：上一件事完成后，同一个人在这段时间内又来消息，算接着聊，并回原来那件事。填 0 表示每次都新起一件。",
				)}
			</Section>

			<Section title="你正在聊天时" desc="你多半会自己回，所以先等一会儿再起草。">
				{num("window", "怎样算正在聊天", "你在这段时间内，在同一个聊天里说过话。")}
				{num("delay", "最多等多久", "填 0 表示不等，直接起草。")}
				{num("check", "检查间隔", "等的时候，每隔这么久看一次你回了没有。")}
			</Section>

			<Section title="私聊" desc="私聊大多是你自己回，草稿常常还没用上就作废了，所以不管你在不在聊，都先等一会儿。">
				{num("p2p", "起草前先等", "从消息到达算起，你在这段时间里回了就不起草。填 0 表示不等。")}
				{num("deep", "要查资料的再等", "分诊判断要查日志、数据库才能回的（更贵），从消息到达算起等到这么久再起草。填 0 表示不另外等。")}
			</Section>

			<Section title="告警" desc="群里机器人 @你 的消息算作告警。同一个群的告警攒成一批，交给助手一起分析。">
				{num("quiet", "收齐一批", "这么久没有新告警，就认为这一批到齐了。")}
				{num("maxWait", "最长等待", "告警一直不停时，等到这么久也开始分析。")}
				{num("follow", "并入上一批", "同一个群在这段时间内又来告警，且上一批还没完成，就并到一起分析。")}
				{ids("chats", "告警群", "只有这些群里的算告警，留空表示不限。", "每行一个群 ID，以 oc_ 开头")}
				{ids("senders", "告警机器人", "只有这些机器人发的算告警，留空表示不限。", "每行一个机器人 ID")}
			</Section>

			<Section title="定时任务">
				{num("patrol", "额度紧张时跳过巡检", "Claude 5 小时额度用到这个比例，自动巡检就跳过这一轮；手动运行不受影响。")}
			</Section>

			<Section title="固定规则">
				<Row label="不处理" desc="你自己发的消息、机器人自己发的卡片、PagerDuty 的确认和恢复通知，以及你已经回复过的消息。" />
				<Row label="你的操作" desc="引用卡片回复，或在看板上操作，都算对原来那件事的处理，不会当成新消息。" />
				<Row label="分派" desc="带 MR 链接的消息交给助手预审；其他消息由模型判断是回个表情、简单回答，还是深入排查。" />
			</Section>

			{/* 有改动时贴在窗口底部，长页面不用滚到底找保存 */}
			<div className={`${dirty ? "sticky bottom-0" : ""} mt-6 flex flex-wrap items-center gap-2 border-t border-line bg-bg py-3`}>
				<button type="button" className="btn primary" disabled={!dirty || invalid || busy} onClick={save}>
					保存
				</button>
				{dirty && (
					<button type="button" className="btn" disabled={busy} onClick={discard}>
						放弃改动
					</button>
				)}
				{invalid && <span className="text-[12px] text-bad">有设置填得不对，改好后才能保存</span>}
				{!atDefault && (
					<button type="button" className="btn ghost ml-auto" disabled={busy} onClick={() => setDraft(toForm(data.defaults))}>
						恢复默认
					</button>
				)}
			</div>
		</div>
	);
}
