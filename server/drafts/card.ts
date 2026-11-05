// 草稿卡片（飞书卡片 JSON 2.0）：待确认时是一张表单，草稿可以在卡片里直接改了再发；
// 处理完（发出、不发、完成、改写、Yi 亲自回复）原地更新成结果，按钮随之消失。纯函数，只读表情包目录。
// 对方的原话用 plain_text 展示，不当 markdown 渲染：不让别人的消息在卡片里伪造出链接或格式。
import { COMMON_EMOJI, PORT } from "../config.ts";
import type { Draft } from "../db/schema.ts";
import type { DraftMr } from "./mr.ts";
import { describeReply, listStickers, NO_REPLY_MARK } from "./format.ts";

/** 飞书输入框 max_length 的上限；更长的草稿卡片里不给编辑框，原样发或 AI 改写 */
export const INPUT_MAX = 1000;
// 卡片请求体上限 30 KB，中文一个字 3 字节，还要再转义一层：各段分别截断
const LIMIT = { source: 800, context: 800, draft: 2500, report: 2500, note: 500, notice: 300 };

const STATE: Record<string, { text: string; template: string }> = {
	pending: { text: "待确认", template: "blue" },
	noreply: { text: "建议不回", template: "wathet" },
	sending: { text: "发送中…", template: "orange" },
	revising: { text: "改写中…", template: "orange" },
	sent: { text: "已发出", template: "green" },
	completed: { text: "已标记完成", template: "grey" },
	discarded: { text: "不发", template: "grey" },
	expired: { text: "你已亲自回复", template: "grey" },
	replaced: { text: "已改写，见新卡片", template: "grey" },
	merged: { text: "对方接着发了，已合到新卡片", template: "grey" },
};

const isLive = (status: string) => status === "pending" || status === "noreply";
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…（未完，完整内容见看板）` : s);
const plain = (content: string) => ({ tag: "plain_text", content });
const text = (content: string, color?: string, size?: string) => ({
	tag: "div",
	text: { tag: "plain_text", content, ...(color ? { text_color: color } : {}), ...(size ? { text_size: size } : {}) },
});
const md = (content: string) => ({ tag: "markdown", content });
const panel = (title: string, elements: object[]) => ({
	tag: "collapsible_panel",
	expanded: false,
	header: { title: md(title) },
	elements,
});
const columns = (...cols: Array<[object, number?]>) => ({
	tag: "column_set",
	horizontal_spacing: "8px",
	columns: cols.map(([el, weight]) => ({
		tag: "column",
		width: weight ? "weighted" : "auto",
		...(weight ? { weight } : {}),
		vertical_align: "center",
		elements: [el],
	})),
});
/** 表单里的按钮都是提交按钮：点哪个都带上整张表单的值，按 value.a 区分。
 * 按钮自己的 name 加前缀：卡片里 name 不能重复，「回表情」按钮和表情下拉框撞名（都叫 emoji）飞书直接拒发整张卡 */
const submit = (name: string, label: string, type = "default") => ({
	tag: "button",
	name: `btn_${name}`,
	text: plain(label),
	type,
	form_action_type: "submit",
	behaviors: [{ type: "callback", value: { a: name } }],
});
const select = (name: string, placeholder: string, options: Array<[string, string]>) => ({
	tag: "select_static",
	name,
	placeholder: plain(placeholder),
	width: "fill",
	options: options.map(([value, label]) => ({ text: plain(label), value })),
});
const input = (name: string, placeholder: string, value = "", rows = 1) => ({
	tag: "input",
	name,
	placeholder: plain(placeholder),
	max_length: INPUT_MAX,
	width: "fill",
	...(rows > 1 ? { input_type: "multiline_text", rows, auto_resize: true, max_rows: 12 } : {}),
	...(value ? { default_value: value } : {}),
});

export function where(d: Pick<Draft, "chatMode" | "chatName" | "senderName">) {
	const at = d.chatMode === "p2p" ? "私聊" : d.chatMode === "meego" ? `飞书项目「${d.chatName}」@你` : `群「${d.chatName}」@你`;
	return `${at} · ${d.senderName}`;
}

/** 草稿是一段可以直接在卡片里改的文字（不是表情、不是建议不回、不超过输入框上限） */
export const editable = (d: Pick<Draft, "kind" | "status" | "draft">) =>
	d.kind === "text" && d.status !== "noreply" && d.draft.length <= INPUT_MAX;

/** MR 预审的后续动作：GitLab 上 approve、评审报告发成 MR 评论；草稿发没发都能点，做过的显示成已完成 */
function mrActions(d: Draft, mr: DraftMr): object[] {
	const btn = (a: "approve" | "note", label: string, doneLabel: string) =>
		mr.done.includes(a)
			? [text(`✓ ${doneLabel}`, "green", "notation")]
			: [
					{
						tag: "button",
						name: `btn_mr_${a}`,
						text: plain(label),
						type: a === "approve" ? "primary" : "default",
						behaviors: [{ type: "callback", value: { a: `mr_${a}` } }],
					},
				];
	const cols: Array<[object]> = [[btn("approve", "GitLab 通过（approve）", "已在 GitLab approve")[0]]];
	if (d.report.trim()) cols.push([btn("note", "评审意见发到 MR", "评审意见已发到 MR")[0]]);
	return [md(`**MR**：[${mr.project}!${mr.iid}](${mr.url})`), columns(...cols)];
}

export function draftCard(d: Draft, notice = "", mr?: DraftMr): object {
	const state = STATE[d.status] ?? { text: d.status, template: "grey" };
	const live = isLive(d.status);
	const elements: object[] = [];
	if (notice) elements.push(text(cut(notice, LIMIT.notice), "red"));
	if (d.chatMode === "meego" && d.meego?.url) elements.push(md(`[打开飞书项目](${d.meego.url})`));
	else if (d.context && live) elements.push(panel("前文", [text(cut(d.context.slice(-LIMIT.context), LIMIT.context), "grey")]));
	elements.push(text(cut(d.text, LIMIT.source)));
	if (live && d.report) elements.push(panel("**评审报告**（不会发出）", [md(cut(d.report, LIMIT.report))]));
	if (live && d.note) elements.push(text(`备注（不会发出）：${cut(d.note, LIMIT.note)}`, "grey", "notation"));
	elements.push({ tag: "hr" });
	if (mr) elements.push(...mrActions(d, mr));

	if (!live) {
		// 结果态：只留发出去的（或当时的）草稿，没有按钮
		const reply = d.draft.startsWith(NO_REPLY_MARK)
			? `建议不回复：${d.draft.slice(NO_REPLY_MARK.length).trim()}`
			: describeReply(d.kind, d.draft);
		elements.push(md(`**${d.status === "sent" ? "已发出" : "草稿"}**\n${cut(reply, LIMIT.draft)}`));
	} else {
		const form: object[] = [];
		if (d.status === "noreply") {
			form.push(text(cut(d.draft.slice(NO_REPLY_MARK.length).trim() || "建议不回复", LIMIT.draft), "grey"));
			form.push(input("text", "需要回复就写在这里，点「发送」", "", 3));
		} else if (editable(d)) {
			form.push(input("text", "草稿", d.draft, 3));
		} else if (d.kind === "text") {
			form.push(md(cut(d.draft, LIMIT.draft)));
			form.push(text("草稿超过卡片输入框的长度，这里改不了：可以原样发送、AI 改写，或在看板里改。", "grey", "notation"));
		} else {
			form.push(md(`**草稿**：${describeReply(d.kind, d.draft)}`));
			form.push(input("text", "想改成文字回复就写在这里；留空点「发送」发上面的", "", 2));
		}
		form.push(columns([submit("send", "发送", "primary_filled")], [submit("discard", "不发")], [submit("complete", "完成")]));
		form.push(columns([input("opinion", "改写意见，例如：语气软一点"), 3], [submit("revise", "AI 改写")]));
		form.push(
			columns(
				[
					select(
						"emoji",
						"选一个表情",
						COMMON_EMOJI.map((e) => [e, e]),
					),
					3,
				],
				[submit("emoji", "回表情")],
			),
		);
		const stickers = listStickers().slice(0, 100);
		if (stickers.length)
			form.push(
				columns(
					[
						select(
							"sticker",
							"选一个表情包",
							stickers.map((s) => [s, s]),
						),
						3,
					],
					[submit("sticker", "发表情包")],
				),
			);
		elements.push({ tag: "form", name: "draft", elements: form });
		elements.push(
			text(
				`也可以引用本条回复：发 / 改 <意见> / 表情 <类型> / 表情包 <名字> / 完成 / 不发。看板 http://127.0.0.1:${PORT}`,
				"grey",
				"notation",
			),
		);
	}
	return {
		schema: "2.0",
		config: { update_multi: true, summary: { content: `${where(d)}：${d.text.slice(0, 40)}` } },
		header: { title: plain(where(d)), subtitle: plain(state.text), template: state.template },
		body: { elements },
	};
}

export interface CardAction {
	operatorId: string;
	messageId: string;
	/** 点的是哪个按钮：send / discard / complete / revise / emoji / sticker */
	name: string;
	form: Record<string, string>;
	/** 按钮回传的 value（非表单按钮靠它带参数） */
	value: Record<string, unknown>;
}

/** card.action.trigger（SDK 已把 v2 的 header / event 摊平到顶层） */
export function parseCardAction(data: any): CardAction | undefined {
	const a = data?.action;
	const messageId = data?.context?.open_message_id ?? data?.open_message_id;
	if (!a || !messageId) return;
	const form: Record<string, string> = {};
	for (const [k, v] of Object.entries(a.form_value ?? {})) if (typeof v === "string") form[k] = v;
	return {
		operatorId: String(data?.operator?.open_id ?? ""),
		messageId: String(messageId),
		name: String(a.value?.a ?? a.name ?? ""),
		form,
		value: a.value && typeof a.value === "object" ? a.value : {},
	};
}

export class CardInputError extends Error {}

/**
 * 「发送」时要发什么：返回 "" 表示原样发草稿，否则是 Yi 在卡片里写的文字。
 * 文字草稿被清空不当成「原样发」，免得 Yi 想清掉重写时误发了原稿。
 */
export function sendText(d: Pick<Draft, "kind" | "status" | "draft">, typed: string | undefined): string {
	const t = (typed ?? "").trim();
	// 可编辑的卡片一定带着输入框：表单里没有这一项，说明被清空了（飞书不回传空输入框）
	if (editable(d)) {
		if (!t) throw new CardInputError("草稿是空的；不回复请点「不发」");
		return t === d.draft.trim() ? "" : t;
	}
	return t;
}

export interface FailureInfo {
	/** 看板上这条失败的任务 id：fail-<原消息 id> */
	taskId: string;
	where: string;
	text: string;
	error: string;
}

const FAILURE_STATE: Record<string, { text: string; template: string }> = {
	failed: { text: "起草失败", template: "red" },
	retrying: { text: "已重新起草，新草稿会另发卡片", template: "grey" },
	dismissed: { text: "已忽略", template: "grey" },
};

/** 起草失败的提醒：对方的消息没人回，带「重试」「忽略」；处理过后原地变灰 */
export function failureCard(f: FailureInfo, status: "failed" | "retrying" | "dismissed" = "failed"): object {
	const state = FAILURE_STATE[status];
	const button = (a: string, label: string, type = "default") => ({
		tag: "button",
		text: plain(label),
		type,
		behaviors: [{ type: "callback", value: { k: "fail", a, t: f.taskId } }],
	});
	const elements: object[] = [text(cut(f.text, LIMIT.source)), text(`原因：${cut(f.error, LIMIT.notice)}`, "red", "notation")];
	if (status === "failed") {
		elements.push(columns([button("retry", "重试", "primary_filled")], [button("ignore", "忽略")]));
		elements.push(text(`看板「待你处理」里也能重试。http://127.0.0.1:${PORT}/?view=todo`, "grey", "notation"));
	}
	return {
		schema: "2.0",
		config: { update_multi: true, summary: { content: `起草失败：${f.where}` } },
		header: { title: plain(f.where), subtitle: plain(state.text), template: state.template },
		body: { elements },
	};
}
