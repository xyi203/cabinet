// 草稿卡片（飞书卡片 JSON 2.0）：待确认时是一张表单，草稿可以在卡片里直接改了再发；
// 处理完（发出、不发、完成、改写、Yi 亲自回复）原地更新成结果，按钮随之消失。纯函数，只读表情包目录。
// 对方的原话用 plain_text 展示，不当 markdown 渲染：不让别人的消息在卡片里伪造出链接或格式。
import { COMMON_EMOJI, EMOJI_ALIASES, PORT } from "../config.ts";
import type { Draft } from "../db/schema.ts";
import type { DraftMr, MrLedger } from "./mr.ts";
import { listStickers, NO_REPLY_MARK } from "./format.ts";

/** 飞书输入框 max_length 的上限；更长的草稿卡片里不给编辑框，原样发或 AI 改写 */
export const INPUT_MAX = 1000;
// 卡片请求体上限 30 KB，中文一个字 3 字节，还要再转义一层：各段分别截断
const LIMIT = { source: 800, context: 800, draft: 2500, report: 2500, note: 500, notice: 300, comment: 600, comments: 4000 };

// 颜色只分两种：还要你处理的（含处理中）青绿，处理完的灰；结果写在副标题里
const STATE: Record<string, { text: string; template: string }> = {
	pending: { text: "待发送", template: "turquoise" },
	noreply: { text: "建议不回复", template: "turquoise" },
	sending: { text: "正在发送…", template: "turquoise" },
	revising: { text: "正在改写…", template: "turquoise" },
	sent: { text: "已发送", template: "grey" },
	completed: { text: "已完成", template: "grey" },
	discarded: { text: "不回复", template: "grey" },
	expired: { text: "你已亲自回复", template: "grey" },
	replaced: { text: "已改写，新草稿在下一张卡片", template: "grey" },
	merged: { text: "对方又发了消息，已合到下一张卡片", template: "grey" },
};

/** 草稿状态给人看的叫法（报错提示里用） */
export const draftStateText = (status: string) => (STATE[status]?.text ?? status).replace(/，.*$/, "");

/** 表情类型的中文叫法：取 EMOJI_ALIASES 里的第一个别名，没有就原样（THUMBSUP -> 赞） */
const EMOJI_NAME = new Map<string, string>();
for (const [name, type] of Object.entries(EMOJI_ALIASES)) if (!EMOJI_NAME.has(type)) EMOJI_NAME.set(type, name);
export const emojiName = (type: string) => EMOJI_NAME.get(type) ?? type;
/** 卡片上怎么说这条草稿：表情、表情包写成人话，文字原样 */
const replyText = (kind: string, content: string) =>
	kind === "reaction" ? `回一个「${emojiName(content)}」表情` : kind === "sticker" ? `发表情包「${content}」` : content;

const isLive = (status: string) => status === "pending" || status === "noreply";
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…（太长了，完整内容在看板里）` : s);
const BOARD = `http://127.0.0.1:${PORT}/`;
const plain = (content: string) => ({ tag: "plain_text", content });
const text = (content: string, color?: string, size?: string) => ({
	tag: "div",
	text: { tag: "plain_text", content, ...(color ? { text_color: color } : {}), ...(size ? { text_size: size } : {}) },
});
const md = (content: string) => ({ tag: "markdown", content });
/** 卡片底部的灰色小字，可以带一个「在看板查看」链接 */
export const footnote = (content: string, link?: string) => ({
	tag: "markdown",
	text_size: "notation",
	content: [content && `<font color='grey'>${content}</font>`, link && `[在看板查看](${link})`].filter(Boolean).join("　"),
});
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

/** 这条消息从哪来，和看板一致：和 张三 的私聊、「订单组」里 张三 @你 */
export function where(d: Pick<Draft, "chatMode" | "chatName" | "senderName">) {
	if (d.chatMode === "p2p") return `和 ${d.senderName} 的私聊`;
	return d.chatMode === "meego" ? `飞书项目「${d.chatName}」里 ${d.senderName} @你` : `「${d.chatName}」里 ${d.senderName} @你`;
}

/** 草稿是一段可以直接在卡片里改的文字（不是表情、不是建议不回、不超过输入框上限） */
export const editable = (d: Pick<Draft, "kind" | "status" | "draft">) =>
	d.kind === "text" && d.status !== "noreply" && d.draft.length <= INPUT_MAX;

/** GitLab 评论里的折叠块和隐藏标记卡片不认，换成卡片能看的样子 */
const cardMd = (s: string) =>
	s
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<summary>([\s\S]*?)<\/summary>/g, "*$1*")
		.replace(/<\/?details>/g, "")
		.trim();

/** 将要发到 MR 的评论（台账原样）：Yi 确认的就是这些，要改用「改写」 */
function ledgerPanel(ledger: MrLedger): object {
	let budget = LIMIT.comments;
	const take = (s: string) => {
		const out = cut(cardMd(s), Math.min(LIMIT.comment, Math.max(budget, 80)));
		budget -= out.length;
		return out;
	};
	const items = ledger.inline.map((c, i) => md(`**${i + 1}. \`${c.new_path}:${c.new_line ?? c.old_line}\`**\n${take(c.body)}`));
	const threads = (ledger.threads ?? []).map((t) =>
		md(
			`**${t.action === "resolve" ? "resolve 线程" : "回复线程"}** \`${t.discussion_id.slice(0, 8)}\`${t.body ? `\n${take(t.body)}` : ""}`,
		),
	);
	const tCount = threads.length ? `，旧线程 ${threads.length} 个动作` : "";
	return panel(`**要发到 MR 的评论**：代码行上 ${ledger.inline.length} 条${tCount}，总结 1 条`, [
		...items,
		...threads,
		md(`**总结评论**\n${take(ledger.summary)}`),
	]);
}

/** MR 预审的后续动作：GitLab 上 approve、评审意见发到 MR；草稿发没发都能点，做过的显示成已完成 */
function mrActions(d: Draft, mr: DraftMr): object[] {
	const btn = (a: "approve" | "note" | "rereview", label: string, doneLabel: string) =>
		mr.done.includes(a)
			? [text(doneLabel, "grey", "notation")]
			: [
					{
						tag: "button",
						name: `btn_mr_${a}`,
						text: plain(label),
						type: a === "approve" ? "primary" : "default",
						behaviors: [{ type: "callback", value: { a: `mr_${a}` } }],
					},
				];
	const cols: Array<[object]> = [[btn("approve", "批准 MR", "已批准 MR")[0]]];
	if (mr.ledger) cols.push([btn("note", "发送评论", "评论已发到 MR")[0]]);
	else if (d.report.trim()) cols.push([btn("note", "发送评审意见", "评审意见已发到 MR")[0]]);
	// 评论发出去之后：对方改完了想马上再看一轮，不等轮询
	if (mr.done.includes("note")) cols.push([btn("rereview", "复审", "")[0]]);
	const out: object[] = [md(`**MR**：[${mr.project}!${mr.iid}](${mr.url})`)];
	if (mr.ledger && !mr.done.includes("note")) out.push(ledgerPanel(mr.ledger));
	return [...out, columns(...cols)];
}

export function draftCard(d: Draft, notice = "", mr?: DraftMr): object {
	const state = STATE[d.status] ?? { text: d.status, template: "grey" };
	const live = isLive(d.status);
	const elements: object[] = [];
	if (notice) elements.push(text(cut(notice, LIMIT.notice), "red"));
	if (d.chatMode === "meego" && d.meego?.url) elements.push(md(`[在飞书项目查看](${d.meego.url})`));
	else if (d.context && live) elements.push(panel("前面的消息", [text(cut(d.context.slice(-LIMIT.context), LIMIT.context), "grey")]));
	elements.push(text(cut(d.text, LIMIT.source)));
	if (live && d.report) elements.push(panel("**评审报告**（只给你看）", [md(cut(d.report, LIMIT.report))]));
	if (live && d.note) elements.push(text(`备注（只给你看）：${cut(d.note, LIMIT.note)}`, "grey", "notation"));
	elements.push({ tag: "hr" });
	if (mr) elements.push(...mrActions(d, mr));

	if (!live) {
		// 结果态：只留发出去的（或当时的）草稿，没有按钮
		const reply = d.draft.startsWith(NO_REPLY_MARK)
			? `建议不回复：${d.draft.slice(NO_REPLY_MARK.length).trim()}`
			: replyText(d.kind, d.draft);
		elements.push(md(`**${d.status === "sent" ? "已发送" : "草稿"}**\n${cut(reply, LIMIT.draft)}`));
	} else {
		const form: object[] = [];
		if (d.status === "noreply") {
			form.push(text(cut(d.draft.slice(NO_REPLY_MARK.length).trim() || "建议不回复", LIMIT.draft), "grey"));
			form.push(input("text", "要回复的话写在这里，再点「发送」", "", 3));
		} else if (editable(d)) {
			form.push(input("text", "回复内容", d.draft, 3));
		} else if (d.kind === "text") {
			form.push(md(cut(d.draft, LIMIT.draft)));
			form.push(text("草稿太长，卡片里改不了。可以直接发送、写意见让 AI 改写，或者到看板里改。", "grey", "notation"));
		} else {
			form.push(md(`**草稿**：${replyText(d.kind, d.draft)}`));
			form.push(input("text", "想回文字就写在这里；空着点「发送」，就发上面这个", "", 2));
		}
		form.push(columns([submit("send", "发送", "primary_filled")], [submit("discard", "不回复")], [submit("complete", "完成")]));
		form.push(columns([input("opinion", "想怎么改？例如：语气软一点"), 3], [submit("revise", "改写")]));
		form.push(
			columns(
				[
					select(
						"emoji",
						"选一个表情",
						COMMON_EMOJI.map((e) => [e, emojiName(e)]),
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
		elements.push(footnote("也可以引用这张卡片回复「发送」「不回复」「完成」「改写 语气软一点」「表情 赞」", BOARD));
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
		if (!t) throw new CardInputError("回复内容是空的；不想回复请点「不回复」");
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
	retrying: { text: "正在重新起草，好了会另发一张卡片", template: "grey" },
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
	const elements: object[] = [text(cut(f.text, LIMIT.source)), text(`失败原因：${cut(f.error, LIMIT.notice)}`, "grey", "notation")];
	if (status === "failed") {
		elements.push(columns([button("retry", "重试", "primary_filled")], [button("ignore", "忽略")]));
		elements.push(footnote("", BOARD));
	}
	return {
		schema: "2.0",
		config: { update_multi: true, summary: { content: `起草失败：${f.where}` } },
		header: { title: plain(f.where), subtitle: plain(state.text), template: state.template },
		body: { elements },
	};
}
