// 云文档评论：评论或回复通知到 Yi（被 @、Yi 参与的评论串有新回复）时，飞书推 drive.notice.comment_add_v1。
// 事件只有标识：评论串另读；回复以 Yi 的身份发回同一个评论串。文档正文里直接 @Yi（不是评论）没有事件，收不到。
// 事件只推不能补拉：cabinet 没在跑的那段时间里的通知就漏了。
import { DRAFT_ENABLED, OWNER_OPEN_ID } from "./config.ts";
import type { DocRef } from "./db/schema.ts";
import { DraftError, inflight } from "./drafts/store.ts";
import { isHandled } from "./handled.ts";
import { addDocComment, docComment, docMeta, replyDocComment, userName } from "./lark/bot.ts";
import type { DocComment, DocNotice } from "./lark/bot.ts";
import type { Chat, Message } from "./lark/types.ts";
import { log } from "./util.ts";

const PATH: Record<string, string> = { doc: "docs", docx: "docx", sheet: "sheets", bitable: "base", slides: "slides", file: "file" };

/** 读不到文档信息时拼一个能打开的链接 */
export const docUrl = (fileType: string, fileToken: string) => `https://www.feishu.cn/${PATH[fileType] ?? fileType}/${fileToken}`;

/** 评论接口里 @ 的人只有 open_id：换成名字 */
async function withNames(text: string): Promise<string> {
	let out = text;
	for (const id of new Set(text.match(/@ou_\w+/g) ?? [])) out = out.replaceAll(id, `@${await userName(id.slice(1))}`);
	return out;
}

/** 通知事件 → 一条待起草的消息；不该处理的（不是给 Yi 的、Yi 自己发的、已经处理过、评论读不到）返回 undefined */
export async function docMessage(n: DocNotice): Promise<{ chat: Chat; msg: Message } | undefined> {
	if (!DRAFT_ENABLED || !n.replyId || n.toId !== OWNER_OPEN_ID || n.fromId === OWNER_OPEN_ID) return;
	const id = `doc_${n.replyId}`;
	if (isHandled([id]).has(id) || inflight.has(id)) return;
	const c = await docComment(n.fileToken, n.fileType, n.commentId);
	const r = c?.replies.find((x) => x.id === n.replyId);
	if (!c || !r) return void log("云文档评论通知：读不到这条评论", n.fileToken, n.commentId, n.replyId);
	const meta = await docMeta(n.fileToken, n.fileType).catch(() => undefined);
	const doc: DocRef = {
		fileToken: n.fileToken,
		fileType: n.fileType,
		commentId: n.commentId,
		replyId: n.replyId,
		url: meta?.url || docUrl(n.fileType, n.fileToken),
		title: meta?.title ?? "",
		quote: c.quote,
		whole: c.whole,
		mention: n.mention,
	};
	return {
		// 一个评论串算一个会话：同一串里接着来的回复排在一起
		chat: { chat_id: `doc-${n.commentId}`, chat_mode: "doc", name: doc.title || "云文档" },
		msg: {
			message_id: id,
			content: await withNames(r.text),
			create_time: r.at * 1000,
			message_position: 0,
			mentions: [],
			sender: { id: n.fromId, name: await userName(n.fromId), sender_type: "user" },
			doc,
		},
	};
}

async function threadText(c: DocComment, upTo?: string): Promise<string> {
	const end = upTo ? c.replies.findIndex((r) => r.id === upTo) : -1;
	const lines: string[] = [];
	for (const r of end < 0 ? c.replies : c.replies.slice(0, end)) lines.push(`${await userName(r.userId)}：${await withNames(r.text)}`);
	return lines.join("\n");
}

/** 给起草看的上下文：哪篇文档、评论划的原文、这条之前的评论串 */
export async function docContext(doc: DocRef): Promise<string> {
	const c = await docComment(doc.fileToken, doc.fileType, doc.commentId);
	const earlier = c ? await threadText(c, doc.replyId) : "";
	return [
		`文档：${doc.title || "（读不到标题）"} ${doc.url}`,
		doc.whole ? "这是一条全文评论（不针对某一段）" : `评论划的原文：\n${doc.quote || "（空）"}`,
		earlier ? `评论串里前面的回复：\n${earlier}` : "",
	]
		.filter(Boolean)
		.join("\n\n");
}

/** 这条之后 Yi 自己回了，或者评论已经解决：草稿不用了。返回原因，还要就是 null */
export async function docStale(doc: DocRef): Promise<string | null> {
	const c = await docComment(doc.fileToken, doc.fileType, doc.commentId);
	if (!c) return null;
	if (c.solved) return "评论已解决";
	const at = c.replies.findIndex((r) => r.id === doc.replyId);
	return at >= 0 && c.replies.slice(at + 1).some((r) => r.userId === OWNER_OPEN_ID) ? "Yi 已亲自回复" : null;
}

/** 以 Yi 的身份回到评论串；全文评论的串回不了，另发一条全文评论 */
export async function sendDocReply(doc: DocRef, text: string) {
	if (!text.trim()) throw new DraftError("回复是空的");
	if (doc.whole) await addDocComment(doc.fileToken, doc.fileType, text);
	else await replyDocComment(doc.fileToken, doc.fileType, doc.commentId, text);
}
