// 一份结论：agent 用 show_ui 交了结构化报告（A2UI v1.0 消息）就按报告显示，可以切回文字结论；没有就是原来的 Markdown。
// 报告只是另一种排版，文字结论始终保留：下一轮巡检、飞书私聊都只读文字。
//
// 消息在服务端已经按 server/a2ui/catalog.ts 校验过，这里直接按组件列表渲染成看板自己的组件，不用 @a2ui/react：
// 它判断哪个属性是子组件引用时依赖 zod 3 的内部结构（web_core 的 reference-map），项目统一用 zod 4 后子组件全是空的，上游也没有修复。
import { useQueryClient } from "@tanstack/react-query";
import { Component, type ReactNode, useMemo, useState } from "react";
import { REPLY_EVENT } from "../../server/a2ui/protocol.ts";
import { type AgentUi, post } from "../lib/api";
import { Markdown } from "./Markdown";
import { toast } from "./Toast";

type Level = "ok" | "watch" | "bad";
type Node = { id: string; component: string } & Record<string, unknown>;
type Child = (id: string) => ReactNode;
type Reply = (text: string) => Promise<void>;

// 只认字面量；万一出现绑定这类对象，按空串处理，不把对象渲染成 [object Object]
const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const LEVEL: Record<Level, { label: string; dot: string; text: string }> = {
	ok: { label: "正常", dot: "bg-ok", text: "text-ok" },
	watch: { label: "关注", dot: "bg-warn", text: "text-warn" },
	bad: { label: "异常", dot: "bg-bad", text: "text-bad" },
};

function Stack({ node, child }: { node: Node; child: Child }) {
	return <div className="flex flex-col gap-4">{ids(node.children).map(child)}</div>;
}

function Verdict({ node }: { node: Node }) {
	const l = LEVEL[node.level as Level] ?? LEVEL.watch;
	return (
		<div>
			<div className="flex items-start gap-2">
				<span className={`mt-[9px] inline-block size-2 shrink-0 rounded-full ${l.dot}`} />
				<div className="text-[16px] leading-relaxed font-semibold text-text">
					<span className={`mr-2 text-[12px] font-semibold ${l.text}`}>{l.label}</span>
					{str(node.title)}
				</div>
			</div>
			{str(node.detail) && <Markdown text={str(node.detail)} className="mt-1 pl-4" />}
		</div>
	);
}

type Option = { label?: unknown; action?: { event?: { name?: unknown; context?: { text?: unknown } } } };

function Decision({ node, reply }: { node: Node; reply: Reply }) {
	const [sent, setSent] = useState<number | null>(null);
	const options = (Array.isArray(node.options) ? node.options : []) as Option[];
	async function choose(i: number, text: string) {
		setSent(i);
		try {
			await reply(text);
		} catch (e) {
			setSent(null);
			toast((e as Error).message, true);
		}
	}
	return (
		<div className="rounded-[10px] border border-line px-4 py-3">
			<div className="text-[14px] font-semibold text-text">{str(node.title)}</div>
			{str(node.detail) && <Markdown text={str(node.detail)} className="mt-1" />}
			{options.length > 0 && (
				<div className="mt-3 flex flex-wrap gap-2">
					{options.map((o, i) => {
						// 只支持「回到这个会话说一句话」：别的动作名不出按钮，免得点了没反应
						const text = o.action?.event?.name === REPLY_EVENT ? str(o.action.event.context?.text) : "";
						if (!text) return null;
						return (
							<button key={i} type="button" className="btn sm" title={text} disabled={sent != null} onClick={() => void choose(i, text)}>
								{sent === i ? "已发给助手" : str(o.label)}
							</button>
						);
					})}
				</div>
			)}
		</div>
	);
}

type Metric = { label?: unknown; value?: unknown; base?: unknown; level?: Level; note?: unknown };

function Metrics({ node }: { node: Node }) {
	const items = (Array.isArray(node.items) ? node.items : []) as Metric[];
	return (
		<div>
			{str(node.title) && <div className="mb-2 text-[14px] font-semibold text-text">{str(node.title)}</div>}
			<div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2">
				{items.map((m, i) => (
					<div key={i} className="rounded-[10px] border border-line px-3 py-2">
						<div className="text-[12px] text-muted">{str(m.label)}</div>
						<div
							className={`mt-1 text-[20px] leading-tight font-semibold tabular-nums ${m.level && m.level !== "ok" ? LEVEL[m.level].text : "text-text"}`}
						>
							{str(m.value)}
						</div>
						{(str(m.base) || str(m.note)) && (
							<div className="mt-1 text-[12px] text-muted">
								{[str(m.base) && `对照 ${str(m.base)}`, str(m.note)].filter(Boolean).join("，")}
							</div>
						)}
					</div>
				))}
			</div>
		</div>
	);
}

function Table({ node }: { node: Node }) {
	const columns = Array.isArray(node.columns) ? node.columns.map(str) : [];
	const rows = (Array.isArray(node.rows) ? node.rows : []) as unknown[];
	return (
		<div>
			{str(node.title) && <div className="mb-2 text-[14px] font-semibold text-text">{str(node.title)}</div>}
			<div className="md">
				<div className="md-table">
					<table>
						<thead>
							<tr>
								{columns.map((c, i) => (
									<th key={i}>{c}</th>
								))}
							</tr>
						</thead>
						<tbody>
							{rows.map((r, i) => (
								<tr key={i}>
									{columns.map((_, j) => (
										<td key={j} className="tabular-nums">
											{str(Array.isArray(r) ? r[j] : "")}
										</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</div>
			{str(node.note) && <div className="mt-1 text-[12px] text-muted">{str(node.note)}</div>}
		</div>
	);
}

function Section({ node, child }: { node: Node; child: Child }) {
	return (
		<details open={!node.collapsed}>
			<summary className="cursor-pointer text-[14px] font-semibold text-text select-none">{str(node.title)}</summary>
			<div className="mt-3 flex flex-col gap-4 border-l border-line pl-4">{ids(node.children).map(child)}</div>
		</details>
	);
}

/** 和 server/a2ui/catalog.ts 的组件一一对应 */
const RENDER: Record<string, (p: { node: Node; child: Child; reply: Reply }) => ReactNode> = {
	Stack,
	Verdict,
	Decision,
	Metrics,
	Table,
	Section,
	Markdown: ({ node }) => <Markdown text={str(node.text)} />,
};

/** 取出报告的组件（后来的 updateComponents 按 id 覆盖前面的）；没有 root 就当没有报告 */
function componentsOf(ui: AgentUi | null | undefined) {
	const map = new Map<string, Node>();
	for (const m of ui?.messages ?? []) {
		const list = (m as { updateComponents?: { components?: unknown } }).updateComponents?.components;
		if (!Array.isArray(list)) continue;
		for (const c of list) if (c && typeof c.id === "string" && typeof c.component === "string") map.set(c.id, c as Node);
	}
	return map.has("root") ? map : null;
}

/** 渲染出错就退回文字结论，不让一份报告把整个抽屉弄白 */
class Boundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
	state = { failed: false };
	static getDerivedStateFromError() {
		return { failed: true };
	}
	componentDidCatch(e: unknown) {
		console.error("结构化报告渲染失败", e);
	}
	render() {
		return this.state.failed ? this.props.fallback : this.props.children;
	}
}

function Report({ nodes, reply }: { nodes: Map<string, Node>; reply: Reply }) {
	// 服务端校验过引用都存在；这里再挡一下环和过深的嵌套，免得坏数据把页面卡死
	const render = (id: string, path: string[]): ReactNode => {
		const node = nodes.get(id);
		const View = node && RENDER[node.component];
		if (!View || path.includes(id) || path.length > 8) return null;
		return (
			<div key={id}>
				<View node={node} reply={reply} child={(c) => render(c, [...path, id])} />
			</div>
		);
	};
	return render("root", []);
}

/**
 * 有报告按报告显示，可以切回文字结论。报告里的按钮把一句话发回 devId 这个任务的会话，
 * 和在对话框里说一样，写操作照样要审批。
 */
export function Conclusion({ text, ui, devId }: { text: string; ui?: AgentUi | null; devId?: string | null }) {
	const qc = useQueryClient();
	const [raw, setRaw] = useState(false);
	const nodes = useMemo(() => componentsOf(ui), [ui]);
	const plain = <Markdown text={text} />;
	if (!nodes) return plain;
	const reply: Reply = async (said) => {
		if (!devId) throw new Error("找不到这件事的会话，没法发");
		await post(`/api/dev/${devId}/message`, { text: said });
		toast(`已发给助手：${said}`);
		qc.invalidateQueries({ queryKey: ["state"] });
	};
	return (
		<div>
			<div className="mb-3 flex justify-end">
				<button type="button" className="btn ghost sm" onClick={() => setRaw(!raw)}>
					{raw ? "查看报告" : "查看原文"}
				</button>
			</div>
			{raw ? (
				plain
			) : (
				<Boundary fallback={plain}>
					<Report nodes={nodes} reply={reply} />
				</Boundary>
			)}
		</div>
	);
}
