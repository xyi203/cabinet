// agent 任务的通知卡片（飞书卡片 JSON 2.0）：每轮结束发一张，带这一轮的结论和能做的操作。
// 开发任务：推送 / 放弃 / 停止；只读 agent（告警、咨询……）：完成 / 停止；都能在卡片里直接给 agent 发话。
// 状态变了（推送中、已推送、完成、放弃）最新那张原地更新；新一轮的卡片发出后，上一张收起按钮。纯函数。
import path from "node:path";
import { ALERT_AGENT, PORT } from "./config.ts";
import type { DevTask } from "./db/schema.ts";

export interface Round {
	/** 第 N 轮完成 / 第 N 轮失败 */
	what: string;
	body: string;
	failed?: boolean;
}

const BODY_MAX = 3000;
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…（未完，完整内容见看板）` : s);
const plain = (content: string) => ({ tag: "plain_text", content });
const note = (content: string, color = "grey") => ({
	tag: "div",
	text: { tag: "plain_text", content, text_color: color, text_size: "notation" },
});
const button = (id: string, a: string, label: string, type = "default") => ({
	tag: "button",
	text: plain(label),
	type,
	behaviors: [{ type: "callback", value: { k: "dev", a, t: id } }],
});
const row = (...els: object[]) => ({
	tag: "column_set",
	horizontal_spacing: "8px",
	columns: els.map((el) => ({ tag: "column", width: "auto", vertical_align: "center", elements: [el] })),
});

const isDev = (t: Pick<DevTask, "agent">) => t.agent === "dev";

export function devTitle(t: DevTask) {
	if (isDev(t)) return `开发任务 · ${path.basename(t.repo)} · ${t.branch}`;
	if (t.agent === ALERT_AGENT) return t.title.slice(0, 60);
	return `Agent 任务 · ${t.agent} · ${t.title.slice(0, 40)}`;
}

const STATUS: Record<string, string> = {
	running: "运行中…",
	pushing: "推送中…",
	pushed: "已推送",
	done: "已完成",
	discarded: "已放弃",
};

function header(t: DevTask, round: Round, latest: boolean) {
	if (!latest) return { subtitle: `${round.what} · 后续见新卡片`, template: "grey" };
	const subtitle = t.status === "review" || t.status === "failed" ? round.what : (STATUS[t.status] ?? t.status);
	const template =
		t.status === "failed"
			? "red"
			: t.status === "done" || t.status === "discarded"
				? "grey"
				: t.status === "pushed"
					? "green"
					: t.status === "running" || t.status === "pushing"
						? "wathet"
						: t.agent === ALERT_AGENT
							? "orange"
							: "blue";
	return { subtitle, template };
}

/** latest：是不是这个任务最新的那张通知；只有最新的带按钮 */
export function devCard(t: DevTask, round: Round, latest = true, notice = ""): object {
	const h = header(t, round, latest);
	const elements: object[] = [];
	if (notice) elements.push(note(notice, "red"));
	elements.push(round.failed ? note(cut(round.body, 800), "red") : { tag: "markdown", content: cut(round.body, BODY_MAX) });
	if (t.mrUrl) elements.push({ tag: "markdown", content: `MR：[${t.mrUrl}](${t.mrUrl})` });
	const open = ["review", "failed", "running", "pushed"].includes(t.status);
	if (latest && open) {
		elements.push({ tag: "hr" });
		if (t.status !== "pushing") {
			elements.push({
				tag: "form",
				name: "say",
				elements: [
					{
						tag: "input",
						name: "msg",
						placeholder: plain(isDev(t) ? "给 agent 的要求或问题；运行中会插进当前这一轮" : "继续追问；运行中会插进当前这一轮"),
						max_length: 1000,
						width: "fill",
						input_type: "multiline_text",
						rows: 2,
						auto_resize: true,
					},
					{
						tag: "button",
						// 卡片里 name 不能重复（和外面的 form 撞名飞书直接拒发）；回调看的是 value.a，不看 name
						name: "say_submit",
						text: plain("发给 agent"),
						type: "primary",
						form_action_type: "submit",
						behaviors: [{ type: "callback", value: { k: "dev", a: "say", t: t.id } }],
					},
				],
			});
		}
		const buttons: object[] = [];
		if (t.status === "running") buttons.push(button(t.id, "stop", "停止"));
		else if (isDev(t)) {
			if (t.status === "review") buttons.push(button(t.id, "push", "推送并建 MR", "primary_filled"));
			if (t.status === "pushed") buttons.push(button(t.id, "push", "推送更新"), button(t.id, "complete", "完成"));
			buttons.push(button(t.id, "discard", "放弃", "danger"));
		} else buttons.push(button(t.id, "complete", "完成", "primary_filled"));
		elements.push(row(...buttons));
	}
	elements.push(
		note(
			latest && open
				? `也可以引用本条回复：直接写的话发给 agent；${isDev(t) ? "推送 / 停止 / 放弃" : "停止 / 完成"}。看板 http://127.0.0.1:${PORT}/?view=agents`
				: `看板 http://127.0.0.1:${PORT}/?view=agents`,
		),
	);
	return {
		schema: "2.0",
		config: { update_multi: true, summary: { content: `${devTitle(t)}：${round.what}` } },
		header: { title: plain(devTitle(t)), subtitle: plain(h.subtitle), template: h.template },
		body: { elements },
	};
}
