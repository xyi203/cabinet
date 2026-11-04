import type { InboxItem } from "../lib/api";
import { AGENT_NAME, ago } from "../lib/format";

const LEVELS: Array<{ level: InboxItem["level"]; name: string; hint: string }> = [
	{ level: "now", name: "现在", hint: "有人在等：草稿待确认、起草失败、告警结论、Watchdog 发现的问题" },
	{ level: "soon", name: "尽快", hint: "agent 任务待看或失败" },
	{ level: "later", name: "有空", hint: "建议不回的草稿、有冲突的记忆（只在这里，不推送）" },
];
const KIND: Record<InboxItem["kind"], string> = { draft: "草稿", failure: "失败", dev: "任务", memory: "记忆", watch: "系统" };

/** 待你处理：需要你判断的事都在这一页，点一条打开对应的抽屉 */
export function Inbox({ items, now, onOpen }: { items: InboxItem[]; now: number; onOpen: (it: InboxItem) => void }) {
	if (!items.length) return <div className="empty">没有要你处理的事</div>;
	return (
		<div>
			{LEVELS.map(({ level, name, hint }) => {
				const rows = items.filter((it) => it.level === level);
				if (!rows.length) return null;
				return (
					<section key={level} className="inbox-group">
						<h2>
							{name} <span>{rows.length}</span> <small>{hint}</small>
						</h2>
						{rows.map((it) => (
							<div key={`${it.kind}-${it.ref}`} className={`card${it.kind === "watch" ? "" : " click"}`} onClick={() => onOpen(it)}>
								<div className="meta">
									<span className={`tag ${it.kind === "failure" || it.kind === "watch" ? "failed" : it.kind}`}>{KIND[it.kind]}</span>
									<span className="who">{it.why}</span>
									<span>{it.kind === "dev" ? (AGENT_NAME[it.label] ?? it.label) : it.label}</span>
									<span>{ago(now, it.at)}</span>
								</div>
								<blockquote>{it.title.slice(0, 300)}</blockquote>
							</div>
						))}
					</section>
				);
			})}
		</div>
	);
}
