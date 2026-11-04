// 飞书项目：评论里 @Yi 时「飞书项目」机器人会私聊 Yi 一张卡片；回复用 meegle CLI 以 Yi 身份发评论。
// 卡片示例：标题「💬 有人在评论中提到了你」或「💬 缺陷有新评论」，正文里有工作项链接、评论人 @名字(ou_xxx) 和评论原文
import { MEEGLE_BIN, OWNER_OPEN_ID } from "./config.ts";
import type { MeegoCard } from "./db/schema.ts";
import { exec, log } from "./util.ts";

export class MeegoError extends Error {}

const MEEGO_URL_RE = /https:\/\/project\.feishu\.cn\/([\w-]+)\/(\w+)\/detail\/(\d+)/;
const cache = new Map<string, any>();

async function meegle(args: string[], timeout = 60): Promise<any> {
	return JSON.parse(await exec(MEEGLE_BIN, args, { timeout }));
}

export function parseMeegoCard(content: string, userIds: Record<string, string> = {}): MeegoCard | undefined {
	const title = /<card title="([^"]*)"/.exec(content)?.[1] ?? "";
	const m = MEEGO_URL_RE.exec(content);
	if (!m) return;
	if (!title.includes("评论")) return; // 人员变更、状态流转等通知不是评论，不起草
	const wiTitle = /\[([^\]]+)\]\(https:\/\/project\.feishu\.cn\//.exec(content)?.[1] ?? "";
	let who: RegExpExecArray | null;
	let body: RegExpExecArray | null;
	if (title.includes("提到了你")) {
		// 两种写法：「**在评论中提到了你:**」「**回复了评论:**」
		who = /@([^(\n]+)\((ou_\w+)\)\s*\*\*(?:在评论中提到了你|回复了评论)/.exec(content);
		body = /(?:提到了你|回复了评论):?\*\*:?\s*\n([\s\S]*?)(?:\n\s*\[查看详情\]|$)/.exec(content);
	} else {
		who = /\*\*操作人\*\*:\s*@([^(\n]+)\((ou_\w+)\)/.exec(content);
		body = /\*\*评论内容:?\*\*:?\s*\n([\s\S]*?)(?:\n\s*\[查看详情\]|$)/.exec(content);
	}
	const comment = (body?.[1] ?? "").replace(/\n<\/card>\s*$/, "").trim();
	// 正文里的 @名字(ou_xxx) 去掉 open_id，留名字给模型看
	const readable = comment.replace(/@([^(@\n]+)\(ou_\w+\)/g, "@$1");
	return {
		title,
		mention: Boolean(comment) && (title.includes("提到了你") || comment.includes(OWNER_OPEN_ID)),
		commentId: /tab_item_id=(\d+)/.exec(content)?.[1] ?? "",
		simpleName: m[1],
		workItemType: m[2],
		workItemId: m[3],
		workItemTitle: wiTitle,
		url: `https://project.feishu.cn/${m[1]}/${m[2]}/detail/${m[3]}`,
		senderName: who?.[1].trim() ?? "",
		senderId: who?.[2] ?? "",
		senderLarkId: who ? userIds[who[1].trim()] : undefined,
		comment: readable,
	};
}

export async function projectKey(simpleName: string): Promise<string> {
	const key = `pk:${simpleName}`;
	if (!cache.has(key)) {
		const projects = (await meegle(["project", "search", "--project-key", simpleName])).projects ?? [];
		const hit = projects.find((x: any) => x.simple_name === simpleName);
		if (!hit) throw new MeegoError(`找不到飞书项目空间 ${simpleName}`);
		cache.set(key, hit.project_key);
	}
	return cache.get(key);
}

async function ownerKey(pk: string): Promise<string> {
	const key = `owner:${pk}`;
	if (!cache.has(key)) {
		const users = (await meegle(["user", "search", "--user-keys", "current_login_user()", "--project-key", pk])) ?? [];
		cache.set(key, users[0]?.user_key ?? "");
	}
	return cache.get(key);
}

/** 名字或 user_key -> {userKey, name}。lark_user_id 在 CLI 输出里已丢精度，不能用来 @，只用 user_key 通知 */
async function lookupUsers(keysOrNames: Array<string | undefined>, pk: string) {
	const wanted = [...new Set(keysOrNames.filter((k): k is string => Boolean(k) && !cache.has(`u:${k}`)))];
	for (let i = 0; i < wanted.length; i += 20) {
		for (const u of (await meegle(["user", "search", "--user-keys", wanted.slice(i, i + 20).join(","), "--project-key", pk])) ?? []) {
			for (const k of [u.user_key, u.name_cn]) if (k) cache.set(`u:${k}`, { userKey: u.user_key, name: u.name_cn || u.name_en });
		}
	}
	return (k?: string): { userKey: string; name: string } | undefined => (k ? cache.get(`u:${k}`) : undefined);
}

const comments = async (mg: MeegoCard) =>
	((await meegle(["comment", "list", "--project-key", mg.projectKey!, "--work-item-id", mg.workItemId], 30)).comments ?? []) as any[];

/** 评论正文里 meegle 的 mention / 图片标记（<!-- … -->）只留名字，免得给模型一堆元数据 */
export const plainComment = (content: unknown) => String(content ?? "").replace(/<!--[\s\S]*?-->/g, "");

/** 工作项最近的评论（带评论人名字）作为起草上下文 */
export async function meegoContext(mg: MeegoCard): Promise<string> {
	try {
		const list = await comments(mg);
		const name = await lookupUsers(
			list.map((c) => c.creator),
			mg.projectKey!,
		);
		const lines = list
			.slice(-15)
			.map((c) => `- ${c.created_at} ${name(c.creator)?.name ?? c.creator}：${plainComment(c.content).slice(0, 400)}`);
		return `工作项「${mg.workItemTitle}」最近的评论：\n${lines.toReversed().join("\n")}`;
	} catch (e) {
		log("读取飞书项目评论失败", mg.workItemId, e);
		return "";
	}
}

/** 这条 @ 之后 Yi 在工作项下评论过，就算已亲自回复 */
export async function meegoYiReplied(mg: MeegoCard): Promise<boolean> {
	try {
		const list = await comments(mg);
		const owner = await ownerKey(mg.projectKey!);
		// 找不到被 @ 的那条评论时，用通知卡片的时间兜底
		const at = list.find((c) => String(c.comment_id) === String(mg.commentId))?.created_at ?? mg.notifiedAt ?? "";
		return list.some((c) => c.creator === owner && (c.created_at ?? "") > at);
	} catch (e) {
		log("检查飞书项目是否已回复失败", mg.workItemId, e);
		return false;
	}
}

/** 评论正文里的 @：纯文本「@名字」不会提及，要写成 meegle 的 mention 标记 */
export function meegoMention(name: string, larkUserId?: string) {
	if (!larkUserId) return `@${name}`;
	const meta = JSON.stringify({ id: `lark_user_id_${larkUserId}`, cn_name: name, blockType: "AT_USER_BLOCK" });
	return `@${name}<!-- mention:${meta} -->`;
}

export async function sendMeegoComment(mg: MeegoCard, senderName: string, text: string, larkUserId = mg.senderLarkId) {
	const user = (await lookupUsers([senderName], mg.projectKey!))(senderName);
	const params: Record<string, unknown> = {
		project_key: mg.projectKey,
		work_item_id: mg.workItemId,
		content: `${meegoMention(senderName, larkUserId)} ${text}`,
	};
	if (user) Object.assign(params, { notify_user_type: "user_key", notify_user_list: [user.userKey] });
	await meegle(["comment", "add", "--params", JSON.stringify(params)]);
}
