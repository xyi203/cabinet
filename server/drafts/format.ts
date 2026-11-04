// 草稿文本：正文、【评审报告】、【备注】的拆分，表情 / 表情包的识别，给人看的标签。纯函数，只读表情包目录
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { COMMON_EMOJI, EMOJI_ALIASES, EMOJI_TYPES, PATHS } from "../config.ts";

const NOTE_MARK = "【备注】";
const REPORT_MARK = "【评审报告】";
export const NO_REPLY_MARK = "【无需回复】";
const REACTION_MARK = "【表情】";
const STICKER_MARK = "【表情包】";
const STICKER_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

export type Kind = "text" | "reaction" | "sticker";

/** 草稿 = 回复正文 + 【评审报告】（CR agent）+ 【备注】，后两段只给 Yi 看 */
export function splitNote(draft: string): { body: string; note: string; report: string } {
	let [body, note] = partition(draft, NOTE_MARK);
	let report: string;
	[body, report] = partition(body, REPORT_MARK);
	if (note.includes(REPORT_MARK)) [note, report] = partition(note, REPORT_MARK); // 模型把备注写在报告前面时
	// 模型偶尔在正文前写「草稿：」，发出去就露馅了
	return { body: body.trim().replace(/^草稿[:：]\s*/, ""), note: note.trim(), report: report.trim() };
}

function partition(s: string, mark: string): [string, string] {
	const i = s.indexOf(mark);
	return i < 0 ? [s, ""] : [s.slice(0, i), s.slice(i + mark.length)];
}

export function listStickers(): string[] {
	if (!existsSync(PATHS.stickers)) return [];
	return readdirSync(PATHS.stickers, { withFileTypes: true })
		.filter((f) => f.isFile() && !f.name.startsWith(".") && STICKER_EXTS.has(path.extname(f.name).toLowerCase()))
		.map((f) => f.name)
		.toSorted();
}

export function resolveEmoji(name: string): string | undefined {
	name = name.trim();
	if (EMOJI_ALIASES[name]) return EMOJI_ALIASES[name];
	const lower = name.toLowerCase();
	return [...EMOJI_TYPES].find((e) => e.toLowerCase() === lower);
}

const stem = (f: string) => f.slice(0, f.length - path.extname(f).length);

/** 只认表情包目录里真实存在的文件，按文件名或去掉扩展名的名字匹配；防止借文件名读到目录外 */
export function resolveSticker(name: string): string | undefined {
	name = name.trim();
	const files = listStickers();
	const exact = files.find((f) => f === name || stem(f) === name);
	if (exact) return exact;
	const hits = files.filter((f) => name && stem(f).includes(name));
	return hits.length === 1 ? hits[0] : undefined;
}

/** 草稿正文 -> 形态和内容；不合法的表情退回文字 */
export function parseDraftBody(body: string): { kind: Kind; content: string } {
	if (body.startsWith(REACTION_MARK)) {
		const emoji = resolveEmoji(body.slice(REACTION_MARK.length).trim().split(/\s+/)[0] ?? "");
		if (emoji) return { kind: "reaction", content: emoji };
	}
	if (body.startsWith(STICKER_MARK)) {
		const sticker = resolveSticker(body.slice(STICKER_MARK.length));
		if (sticker) return { kind: "sticker", content: sticker };
	}
	return { kind: "text", content: body };
}

/** 草稿正文只是一个表情 / 表情包，或建议不回复 */
export function isAckOnly(draft: string): boolean {
	const { body } = splitNote(draft);
	return body.startsWith(NO_REPLY_MARK) || parseDraftBody(body).kind !== "text";
}

export const describeReply = (kind: string, content: string) =>
	kind === "reaction" ? `表情回复 \`${content}\`` : kind === "sticker" ? `表情包 \`${content}\`` : content;

export function stickerHint() {
	const stickers = listStickers();
	return `可用的表情回复（【表情】后写类型）：${COMMON_EMOJI.join(", ")}，也可以用飞书其他表情类型名。\n可用的表情包（【表情包】后写文件名）：${stickers.length ? stickers.join(", ") : "暂无，不要用表情包"}`;
}

export function draftLabel(s: { chatMode: string; chatName: string; senderName: string }) {
	if (s.chatMode === "meego") return `飞书项目 · ${s.senderName}`;
	return s.chatMode === "p2p" ? s.senderName : `${s.chatName} · ${s.senderName}`;
}
