// MR 预审的评论台账（server/drafts/mr.ts 的 MrLedger）按评论列出来：时间线、草稿抽屉、执行日志里都用这一份，不再直接露 JSON
import { type ReactNode, useState } from "react";
import type { MrLedger } from "../lib/api";
import { Markdown } from "./Markdown";

/** 折起来的一段：展开时才渲染内容，免得时间线上每版草稿都去拉一遍执行日志 */
export function Fold({ summary, open = false, children }: { summary: ReactNode; open?: boolean; children: ReactNode }) {
	const [shown, setShown] = useState(open);
	return (
		<details className="ctxwrap" open={shown} onToggle={(e) => setShown(e.currentTarget.open)}>
			<summary>{summary}</summary>
			{shown && children}
		</details>
	);
}

/** 评论是写给 GitLab 的：去掉 HTML 注释标记，<details> 折叠块摊开成普通段落（看板的 Markdown 不渲染原始 HTML） */
const gitlabMd = (s: string) =>
	s
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<summary>([\s\S]*?)<\/summary>/g, "**$1**")
		.replace(/<\/?details>/g, "")
		.trim();

export const ledgerTitle = (l: MrLedger) =>
	`准备发到 MR 的评论（行内 ${l.inline.length} 条${l.threads?.length ? `，旧线程 ${l.threads.length} 条` : ""}）`;

export function MrComments({ ledger }: { ledger: MrLedger }) {
	const inline = ledger.inline ?? [];
	return (
		<>
			{inline.map((c, i) => (
				<div key={i} className="kv">
					<span>{i + 1}</span>
					<div>
						<code>
							{c.new_path}:{c.new_line ?? c.old_line}
						</code>
						<Markdown text={gitlabMd(c.body)} />
					</div>
				</div>
			))}
			{ledger.threads?.map((th, i) => (
				<div key={th.discussion_id} className="kv">
					<span>{inline.length + i + 1}</span>
					<div>
						<code>{th.action === "resolve" ? "关闭旧线程" : "回复旧线程"}</code>
						{th.body && <Markdown text={gitlabMd(th.body)} />}
					</div>
				</div>
			))}
			{ledger.summary && (
				<div className="kv">
					<span>总结</span>
					<Markdown text={gitlabMd(ledger.summary)} />
				</div>
			)}
		</>
	);
}

/**
 * agent 的回答末尾带着【MR评论】JSON 台账（config 里 mr 档的输出格式）：拆成前面的正文和解析出的台账。
 * 解析不了（运行中只推来了前 3000 字、格式不对）就原样当正文
 */
export function splitLedger(text: string): { body: string; ledger?: MrLedger } {
	const at = text.indexOf("【MR评论】");
	if (at < 0) return { body: text };
	const raw = text
		.slice(at + "【MR评论】".length)
		.trim()
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/```\s*$/, "");
	try {
		const ledger = JSON.parse(raw) as MrLedger;
		if (!Array.isArray(ledger?.inline)) return { body: text };
		return { body: text.slice(0, at).trimEnd(), ledger };
	} catch {
		return { body: text };
	}
}
