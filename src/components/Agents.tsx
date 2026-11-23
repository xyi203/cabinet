import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { type AgentStat, fetchPrompts } from "../lib/api";
import { AGENT_NAME, money, when } from "../lib/format";
import { EFFORT } from "./ModelPicker";
import { PromptEditor } from "./Prompts";
import { TIER_NAME } from "./Stats";
import { PageHead } from "./ui";

/** 所有助手共用的配置文件：模型、档位、工具、技能都在这里改 */
const CONFIG = "config/agents.json";
/** 列表里 open 等于它时，打开的是配置文件而不是某个助手 */
export const CONFIG_KEY = "_config";

const nameOf = (a: string) => AGENT_NAME[a] ?? a;
/** 说明开头的「（手动指派）」这类括号去掉，单独做成标签 */
const descOf = (s: string) => s.replace(/^（[^）]*）/, "");
const tagOf = (s: string) => /^（([^）]*)）/.exec(s)?.[1];
// 「claude/claude-opus-5-5」只留「opus-5-5」
const modelOf = (m: string) => (m.split("/").pop() ?? m).replace(/^claude-/, "");
const effortOf = (t: string) => EFFORT[t] ?? t;
const RUNNER: Record<string, string> = { pi: "Cabinet 内置", codex: "本机 Codex" };
/** skills / mcp / bash：* 是全部，没配是不给 */
const scope = (v: string[] | "*" | null) => (v === "*" ? "全部" : v?.length ? v.join("、") : "不给");

function Avatar({ name, big }: { name: string; big?: boolean }) {
	return (
		<span
			className={`flex shrink-0 items-center justify-center rounded-[8px] bg-soft font-semibold text-text-2 ${big ? "h-10 w-10 text-[16px]" : "h-8 w-8 text-[14px]"}`}
			aria-hidden
		>
			{nameOf(name).slice(0, 1)}
		</span>
	);
}

function Status({ a }: { a: AgentStat }) {
	return a.running.length ? (
		<span className="livedot" title={a.running.map((r) => r.label).join("\n")}>
			运行中 {a.running.length}
		</span>
	) : (
		<span className="text-muted">空闲</span>
	);
}

/** 智能体：有哪些助手、各自在干什么、用什么模型；点进去看配置、改提示词 */
export function AgentsPage({
	agents,
	now,
	open,
	onOpen,
}: {
	agents: AgentStat[];
	now: number;
	open?: string;
	onOpen: (name?: string) => void;
}) {
	if (open === CONFIG_KEY) return <ConfigFile onBack={() => onOpen(undefined)} />;
	const cur = open ? agents.find((a) => a.name === open) : undefined;
	if (cur) return <AgentDetail a={cur} now={now} onBack={() => onOpen(undefined)} onConfig={() => onOpen(CONFIG_KEY)} />;
	const cols = "grid grid-cols-[minmax(220px,2fr)_84px_minmax(120px,1fr)_72px_120px_96px] items-center gap-x-4";
	return (
		<div className="mx-auto max-w-[1080px]">
			<PageHead
				title="智能体"
				finding={agentsFinding(agents)}
				actions={
					<button className="btn" title="新增、删除助手，改模型、档位、工具和技能" onClick={() => onOpen(CONFIG_KEY)}>
						编辑配置文件
					</button>
				}
			/>
			{/* 照设置页排：没有外框和表头色块，只用细线分行 */}
			<div className="overflow-x-auto">
				<div className="min-w-[780px]">
					<div className={`${cols} border-b border-line px-3 pb-2 text-[12px] text-muted`}>
						<span>智能体</span>
						<span>状态</span>
						<span>模型</span>
						<span>权限</span>
						<span>今天</span>
						<span>最近活跃</span>
					</div>
					{agents.map((a) => (
						<button
							key={a.name}
							onClick={() => onOpen(a.name)}
							className={`${cols} w-full cursor-pointer rounded-[8px] border-0 border-b border-line bg-transparent px-3 py-3.5 text-left text-[14px] hover:bg-soft`}
						>
							<span className="flex min-w-0 items-center gap-3">
								<Avatar name={a.name} />
								<span className="min-w-0">
									<span className="flex items-center gap-2">
										<span className="font-medium whitespace-nowrap text-text">{nameOf(a.name)}</span>
										{tagOf(a.desc) && <span className="truncate text-[12px] text-muted">{tagOf(a.desc)}</span>}
									</span>
									<span className="block truncate text-[12px] text-muted" title={descOf(a.desc)}>
										{descOf(a.desc)}
									</span>
								</span>
							</span>
							<Status a={a} />
							<span className="truncate text-text-2" title={a.model}>
								{a.tiers.length ? `按消息分 ${a.tiers.length} 档` : modelOf(a.model)}
								{!a.tiers.length && <span className="text-muted"> · {effortOf(a.thinking)}</span>}
							</span>
							<span className="text-text-2">{a.readOnly ? "只读" : "能改代码"}</span>
							<span className="text-text-2 tabular-nums">
								{a.runs} 次 · {money(a.cost)}
								{a.failed > 0 && <span className="ml-1 text-bad">失败 {a.failed}</span>}
							</span>
							<span className="text-muted tabular-nums">{a.lastActive ? when(a.lastActive, now) : "—"}</span>
						</button>
					))}
				</div>
			</div>
		</div>
	);
}

/** 设置式的一行：左边名称和说明，右边当前值 */
function Row({ k, hint, children }: { k: string; hint?: string; children: React.ReactNode }) {
	return (
		<div className="flex items-center gap-6 border-b border-line py-3.5 last:border-b-0">
			<div className="min-w-0 flex-1">
				<div className="text-[14px] text-text">{k}</div>
				{hint && <div className="mt-0.5 text-[12px] text-muted">{hint}</div>}
			</div>
			<div className="max-w-[55%] text-right text-[14px] break-words text-text-2">{children}</div>
		</div>
	);
}

function Section({ title, extra, children }: { title: string; extra?: React.ReactNode; children: React.ReactNode }) {
	return (
		<section className="mt-8 first:mt-0">
			<div className="mb-1 flex items-center gap-2">
				<h2 className="m-0 text-[16px] font-semibold">{title}</h2>
				<div className="ml-auto">{extra}</div>
			</div>
			{children}
		</section>
	);
}

function AgentDetail({ a, now, onBack, onConfig }: { a: AgentStat; now: number; onBack: () => void; onConfig: () => void }) {
	// 这个助手用到的提示词：自己的，加上各档位单独配的（如简单回应的 ack.md）
	const files = [
		...(a.prompt ? [{ path: `config/${a.prompt}`, label: "通用" }] : []),
		...a.tiers.filter((t) => t.prompt).map((t) => ({ path: `config/${t.prompt}`, label: TIER_NAME[t.name] ?? t.name })),
	];
	const [sel, setSel] = useState(files[0]?.path);
	const { data: prompts } = useQuery({ queryKey: ["prompts"], queryFn: fetchPrompts });
	const file = prompts?.find((f) => f.path === sel);
	return (
		<div className="mx-auto max-w-[860px]">
			<div className="phead">
				<button className="link text-muted" onClick={onBack}>
					← 智能体
				</button>
			</div>
			<div className="mb-8 flex items-center gap-3">
				<Avatar name={a.name} big />
				<div className="min-w-0">
					<h1 className="m-0 flex items-center gap-2 text-[20px] font-semibold">
						{nameOf(a.name)}
						<span className="text-[12px] font-normal">
							<Status a={a} />
						</span>
					</h1>
					<div className="text-[14px] text-muted">{descOf(a.desc)}</div>
				</div>
			</div>
			<Section
				title="配置"
				extra={
					<button className="btn sm" onClick={onConfig}>
						在配置文件里改
					</button>
				}
			>
				{!a.tiers.length && (
					<Row k="模型" hint="看板上派的任务也用它">
						{modelOf(a.model)} · 思考强度{effortOf(a.thinking)}
					</Row>
				)}
				<Row k="运行方式" hint="谁来跑这个助手">
					{RUNNER[a.runner] ?? a.runner}
				</Row>
				<Row k="权限" hint={a.readOnly ? "查代码、日志、数据库，不改文件" : "在独立 worktree 里改，推送前由你审核"}>
					{a.readOnly ? "只读" : "能改代码"}
				</Row>
				<Row k="工具" hint="能调用的内置工具">
					{a.tools ? a.tools.join("、") || "不给" : "默认的只读工具"}
				</Row>
				<Row k="技能" hint="能读的 skill">
					{scope(a.skills)}
				</Row>
				<Row k="MCP" hint="能连的 MCP 服务">
					{scope(a.mcp)}
				</Row>
				<Row k="命令" hint="放行的命令规则，没放行的要你批准">
					{scope(a.bash)}
				</Row>
				<Row k="分派" hint={a.manual ? "分诊不会选它，手动或按规则指派" : "分诊会按消息内容选它"}>
					{a.manual ? "手动指派" : "自动分派"}
				</Row>
				<Row k="最近活跃">{a.lastActive ? when(a.lastActive, now) : "还没运行过"}</Row>
			</Section>
			{a.tiers.length > 0 && (
				<Section title="档位">
					<div className="mb-1 text-[12px] text-muted">分诊按消息难易选一档，档位里的模型和设置覆盖上面的</div>
					{a.tiers.map((t) => (
						<Row key={t.name} k={TIER_NAME[t.name] ?? t.name} hint={t.desc}>
							{modelOf(t.model)} · {effortOf(t.thinking)}
							{t.runner === "codex" && " · 本机 Codex"}
						</Row>
					))}
				</Section>
			)}
			<Section
				title="提示词"
				extra={
					files.length > 1 && (
						<div className="seg" role="group" aria-label="选择提示词">
							{files.map((f) => (
								<button key={f.path} className={f.path === sel ? "on" : ""} aria-pressed={f.path === sel} onClick={() => setSel(f.path)}>
									{f.label}
								</button>
							))}
						</div>
					)
				}
			>
				<div className="mt-2">
					{!files.length ? (
						<div className="text-[14px] text-muted">这个助手没有单独的提示词，只用通用规则。</div>
					) : file ? (
						<PromptEditor key={file.path} file={file} />
					) : (
						<div className="text-[14px] text-muted">{prompts ? `没找到 ${sel}` : "加载中…"}</div>
					)}
				</div>
			</Section>
		</div>
	);
}

function ConfigFile({ onBack }: { onBack: () => void }) {
	const { data: prompts } = useQuery({ queryKey: ["prompts"], queryFn: fetchPrompts });
	const file = prompts?.find((f) => f.path === CONFIG);
	return (
		<div className="mx-auto max-w-[1080px]">
			<div className="phead">
				<button className="link text-muted" onClick={onBack}>
					← 智能体
				</button>
			</div>
			{file ? <PromptEditor file={file} /> : <div className="text-[14px] text-muted">{prompts ? `没找到 ${CONFIG}` : "加载中…"}</div>}
		</div>
	);
}

/** 页头现状：几个助手、今天跑了几次花了多少、几个正在跑 */
function agentsFinding(agents: AgentStat[]) {
	const runs = agents.reduce((n, a) => n + a.runs, 0);
	const cost = agents.reduce((n, a) => n + a.cost, 0);
	const busy = agents.filter((a) => a.running.length > 0).length;
	return `${agents.length} 个助手，今天跑了 ${runs} 次，花费 ${money(cost)}${busy ? `，${busy} 个正在跑` : ""}。`;
}
