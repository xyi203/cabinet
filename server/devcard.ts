// agent 任务的通知卡片（飞书卡片 JSON 2.0）：每轮结束发一张，带这一轮的结论和能做的操作。
// 开发任务：推送 / 放弃 / 停止；只读 agent（告警、咨询……）：完成 / 停止；都能在卡片里直接给 agent 发话。
// 状态变了（推送中、已推送、完成、放弃）最新那张原地更新；新一轮的卡片发出后，上一张收起按钮。纯函数。
import path from "node:path";
import { PORT } from "./config.ts";
import type { DevTask } from "./db/schema.ts";
import { footnote } from "./drafts/card.ts";

export interface Round {
	/** 第 N 轮完成 / 第 N 轮失败 */
	what: string;
	body: string;
	failed?: boolean;
}

const BODY_MAX = 3000;
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…（太长了，完整内容在看板里）` : s);
const BOARD = `http://127.0.0.1:${PORT}/`;
const plain = (content: string) => ({ tag: "plain_text", content });
const note = (content: string, color = "grey") => ({
	tag: "div",
	text: { tag: "plain_text", content, text_color: color, text_size: "notation" },
});
const button = (id: string, a: string, label: string, type = "default", confirm?: { title: string; text: string }) => ({
	tag: "button",
	text: plain(label),
	type,
	...(confirm ? { confirm: { title: plain(confirm.title), text: plain(confirm.text) } } : {}),
	behaviors: [{ type: "callback", value: { k: "dev", a, t: id } }],
});
const row = (...els: object[]) => ({
	tag: "column_set",
	horizontal_spacing: "8px",
	columns: els.map((el) => ({ tag: "column", width: "auto", vertical_align: "center", elements: [el] })),
});

const isDev = (t: Pick<DevTask, "agent">) => t.agent === "dev";

/** 卡片标题。任务标题是存好的（「定时 · 名字」「告警 · 群名 · 3 条」），老数据也在：只在卡片上换成不带 · 的说法 */
export function devTitle(t: DevTask) {
	if (isDev(t)) return `开发任务：${path.basename(t.repo)}（${t.branch}）`;
	const alert = /^告警 · (.+) · (\d+) 条$/.exec(t.title);
	if (alert) return `告警：${alert[1]}（${alert[2]} 条）`.slice(0, 60);
	const cron = /^定时 · (.+)$/.exec(t.title);
	if (cron) return `定时任务：${cron[1]}`.slice(0, 60);
	return t.title.slice(0, 60);
}

const STATUS: Record<string, string> = {
	running: "进行中…",
	pushing: "正在推送…",
	pushed: "已推送",
	done: "已完成",
	discarded: "已放弃",
};
/** 任务状态给人看的叫法（报错提示里用） */
export const devStatusText = (status: string) =>
	status === "review" ? "等你查看" : status === "failed" ? "失败" : (STATUS[status] ?? status);

// 颜色：出错红，结束和被新卡片接替的灰，其余（等你看、进行中）青绿
function header(t: DevTask, round: Round, latest: boolean) {
	if (!latest) return { subtitle: `${round.what}，后续在新卡片里`, template: "grey" };
	const subtitle = t.status === "review" || t.status === "failed" ? round.what : (STATUS[t.status] ?? t.status);
	const template = t.status === "failed" ? "red" : t.status === "done" || t.status === "discarded" ? "grey" : "turquoise";
	return { subtitle, template };
}

/** latest：是不是这个任务最新的那张通知；只有最新的带按钮 */
export function devCard(t: DevTask, round: Round, latest = true, notice = "", link = BOARD): object {
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
						placeholder: plain(isDev(t) ? "补充要求或提问；进行中也可以发" : "继续追问；进行中也可以发"),
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
						text: plain("发送"),
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
			if (t.status === "review") buttons.push(button(t.id, "push", "推送并创建 MR", "primary_filled"));
			if (t.status === "pushed") buttons.push(button(t.id, "push", "推送更新"), button(t.id, "complete", "完成"));
			// 放弃会删掉本地工作目录和分支，删了找不回来：唯一要二次确认的按钮
			buttons.push(
				button(t.id, "discard", "放弃", "default", {
					title: "放弃这个任务？",
					text:
						t.status === "pushed"
							? "会删除本地的工作目录。已推送的分支和 MR 不受影响。"
							: "会删除本地的工作目录和分支，没推送的改动找不回来。",
				}),
			);
		} else buttons.push(button(t.id, "complete", "完成", "primary_filled"));
		elements.push(row(...buttons));
	}
	elements.push(
		footnote(
			latest && open
				? `也可以引用这张卡片回复：直接写的话会发给${isDev(t) ? "开发助手" : "助手"}；回「${isDev(t) ? "推送」「停止」「放弃" : "停止」「完成"}」就照做`
				: "",
			link,
		),
	);
	return {
		schema: "2.0",
		config: { update_multi: true, summary: { content: `${devTitle(t)}：${round.what}` } },
		header: { title: plain(devTitle(t)), subtitle: plain(h.subtitle), template: h.template },
		body: { elements },
	};
}
