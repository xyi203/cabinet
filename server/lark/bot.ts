// 飞书：全部走官方 node-sdk。
// - 机器人身份（tenant token，SDK 自动管理）：长连接收消息、回复 @机器人、私聊草稿给 Yi、上传图片
// - 用户身份（Yi 的 user token）：轮询 Yi 的私聊和 @Yi、以 Yi 的名义发出确认过的草稿。
//   令牌由看板上的「授权飞书」走 OAuth 授权码流程拿到，refresh_token 存在 SQLite，到期前自动刷新。
import * as lark from "@larksuiteoapi/node-sdk";
import { createReadStream, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FEISHU_APP_ID, FEISHU_APP_SECRET, OAUTH_REDIRECT } from "../config.ts";
import { getKv, setKv } from "../db/index.ts";
import { log, now } from "../util.ts";
import { cardUserIds, renderCard } from "./card.ts";
import type { BotEvent, Chat, Mention, Message, UserTarget } from "./types.ts";

let _client: lark.Client | undefined;
const client = () =>
	(_client ??= new lark.Client({
		appId: FEISHU_APP_ID,
		appSecret: FEISHU_APP_SECRET,
		domain: lark.Domain.Feishu,
		loggerLevel: lark.LoggerLevel.warn,
	}));

/** 飞书接口报错：带上错误码和说明，看板和私聊回执直接显示 */
export class LarkError extends Error {}

function larkError(e: unknown, what: string): Error {
	const data = (e as any)?.response?.data;
	if (data?.code) {
		const hint = data.code === 230027 ? "（应用缺少「以用户身份发送消息」im:message.send_as_user 权限，开通后需在看板重新授权）" : "";
		return new LarkError(`${what}失败 code=${data.code}: ${data.msg}${hint}`);
	}
	return e as Error;
}

// OpenAPI 业务错误码不抛异常，统一在这里转成异常
function check<T extends { code?: number; msg?: string; data?: any }>(res: T, what: string): NonNullable<T["data"]> {
	if (res.code) throw new Error(`${what} 失败 code=${res.code}: ${res.msg}`);
	return res.data ?? ({} as NonNullable<T["data"]>);
}

// ---------- 用户授权 ----------

// 读 Yi 的私聊/群消息、以 Yi 身份发消息和表情回复；offline_access 才会下发 refresh_token
export const USER_SCOPES = [
	"im:chat:read",
	"im:message",
	"im:message.send_as_user",
	"im:message:readonly",
	"im:message.p2p_msg:get_as_user",
	"im:message.group_msg:get_as_user",
	"im:message.reactions:write_only",
	"contact:user.base:readonly",
	"offline_access",
];

interface UserToken {
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
	refreshExpiresAt: number;
	scope: string;
}

export function authorizeUrl(state: string) {
	const q = new URLSearchParams({
		client_id: FEISHU_APP_ID,
		response_type: "code",
		redirect_uri: OAUTH_REDIRECT,
		scope: USER_SCOPES.join(" "),
		state,
	});
	return `https://accounts.feishu.cn/open-apis/authen/v1/authorize?${q}`;
}

async function tokenRequest(body: Record<string, string>): Promise<UserToken> {
	const res = await fetch("https://open.feishu.cn/open-apis/authen/v2/oauth/token", {
		method: "POST",
		headers: { "Content-Type": "application/json; charset=utf-8" },
		body: JSON.stringify({ client_id: FEISHU_APP_ID, client_secret: FEISHU_APP_SECRET, ...body }),
	});
	const d: any = await res.json();
	if (d.code || !d.access_token) throw new Error(`用户授权失败 code=${d.code}: ${d.error_description ?? d.msg ?? res.status}`);
	const t = now();
	const token = {
		accessToken: d.access_token,
		refreshToken: d.refresh_token ?? "",
		expiresAt: t + (d.expires_in ?? 7200),
		refreshExpiresAt: t + (d.refresh_token_expires_in ?? 0),
		scope: d.scope ?? "",
	};
	setKv("user_token", token);
	return token;
}

export const exchangeCode = (code: string) => tokenRequest({ grant_type: "authorization_code", code, redirect_uri: OAUTH_REDIRECT });

let refreshing: Promise<UserToken> | undefined;

/** 当前可用的 user token；快过期时刷新（refresh_token 一次性，并发刷新只发一个请求） */
async function userToken(): Promise<string> {
	const t = getKv<UserToken | null>("user_token", null);
	if (!t) throw new UserAuthError("还没有授权飞书用户身份，请在看板上点「授权飞书」");
	if (t.expiresAt - 300 > now()) return t.accessToken;
	if (!t.refreshToken || (t.refreshExpiresAt && t.refreshExpiresAt < now()))
		throw new UserAuthError("飞书用户授权已过期，请在看板上重新授权");
	refreshing ??= tokenRequest({ grant_type: "refresh_token", refresh_token: t.refreshToken }).finally(() => (refreshing = undefined));
	return (await refreshing).accessToken;
}

export class UserAuthError extends Error {}

export function userAuthStatus() {
	const t = getKv<UserToken | null>("user_token", null);
	if (!t) return { authorized: false as const };
	return {
		authorized: t.refreshExpiresAt === 0 || t.refreshExpiresAt > now(),
		expiresAt: t.expiresAt,
		refreshExpiresAt: t.refreshExpiresAt,
		scope: t.scope,
	};
}

const asUser = async () => lark.withUserAccessToken(await userToken());

// ---------- 消息 ----------

/** Markdown 包成 post 消息的 md 节点，<at user_id="ou_xxx"></at> 在 md 里同样生效 */
export const postContent = (md: string) => JSON.stringify({ zh_cn: { content: [[{ tag: "md", text: md }]] } });

const replaceMentions = (text: string, mentions: Mention[]) => mentions.reduce((t, m) => t.split(m.key).join(`@${m.name}`), text);

// 图片带上 image_key，起草时按 key 下载到本地（见 saveImage）
const imageTag = (key?: string) => (key ? `[图片 ${key}]` : "[图片]");

/** 消息里引用的图片 key：自己渲染的 `[图片 img_xxx]`，以及飞书正文里原样带出的 `![Image](img_xxx)` */
export const imageKeys = (text: string) => [...new Set(text.match(/\bimg_v\d+_[\w-]+/g) ?? [])];

function imageExt(b: Buffer): string | undefined {
	if (b[0] === 0x89 && b[1] === 0x50) return ".png";
	if (b[0] === 0xff && b[1] === 0xd8) return ".jpg";
	if (b.subarray(0, 3).toString() === "GIF") return ".gif";
	if (b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP") return ".webp";
}

/** 把消息里的图片存到本地，返回文件路径；已下载过的直接复用。机器人不在 Yi 的大多数会话里：先 user 后 bot */
export async function saveImage(messageId: string, key: string, dir: string): Promise<string | undefined> {
	mkdirSync(dir, { recursive: true });
	const cached = readdirSync(dir).find((f) => f.startsWith(`${key}.`));
	if (cached) return path.join(dir, cached);
	const buf = await tryIdentities(
		async (as) => {
			const res = await client().im.v1.messageResource.get(
				{ path: { message_id: messageId, file_key: key }, params: { type: "image" } },
				as === "user" ? await asUser() : undefined,
			);
			const chunks: Buffer[] = [];
			for await (const c of res.getReadableStream()) chunks.push(Buffer.from(c));
			return Buffer.concat(chunks);
		},
		["user", "bot"],
		"下载图片",
	);
	const ext = buf && imageExt(buf);
	if (!ext) return;
	const file = path.join(dir, `${key}${ext}`);
	writeFileSync(file, buf);
	return file;
}

/** 消息 content 转成给人和模型看的文字。text/post 里的 @_user_1 换成 @名字；卡片渲染成 Markdown */
export function messageText(type: string, raw: string, mentions: Mention[] = []): string {
	let c: any;
	try {
		c = JSON.parse(raw);
	} catch {
		return raw;
	}
	switch (type) {
		case "text":
			return replaceMentions(c.text ?? "", mentions);
		case "post": {
			const body = c.content ? c : (c.zh_cn ?? c.en_us ?? Object.values(c)[0] ?? {});
			const lines = (body.content ?? []).map((line: any[]) =>
				line
					.map((n) =>
						n.tag === "at"
							? `@${n.user_name ?? mentions.find((m) => m.key === n.user_id)?.name ?? n.user_id}`
							: n.tag === "a"
								? `[${n.text}](${n.href})`
								: n.tag === "img"
									? imageTag(n.image_key)
									: (n.text ?? ""),
					)
					.join(""),
			);
			return replaceMentions([body.title, ...lines].filter(Boolean).join("\n"), mentions);
		}
		case "interactive":
			return renderCard(c, mentions);
		case "image":
			return imageTag(c.image_key);
		case "sticker":
			return "[表情包]";
		case "file":
			return `[文件] ${c.file_name ?? ""}`.trim();
		case "media":
			return "[视频]";
		case "audio":
			return "[语音]";
		case "merge_forward":
			return "[合并转发]";
		case "share_chat":
			return "[群名片]";
		default:
			return `[${type}]`;
	}
}

function toMessage(item: any): Message {
	const mentions: Mention[] = (item.mentions ?? []).map((m: any) => ({ key: m.key, id: m.id, name: m.name }));
	let userIds: Record<string, string> | undefined;
	if (item.msg_type === "interactive" && !item.deleted) {
		try {
			userIds = cardUserIds(JSON.parse(item.body?.content ?? "{}"));
		} catch {}
	}
	return {
		message_id: item.message_id,
		content: item.deleted ? "" : messageText(item.msg_type, item.body?.content ?? "", mentions),
		create_time: Number(item.create_time),
		message_position: Number(item.message_position ?? 0),
		parent_id: item.parent_id || undefined,
		root_id: item.root_id || undefined,
		thread_id: item.thread_id || undefined,
		deleted: item.deleted,
		mentions,
		sender: {
			id: item.sender?.id ?? "",
			name: item.sender?.sender_name ?? item.sender?.id ?? "",
			sender_type: item.sender?.sender_type ?? "",
		},
		userIds,
	};
}

export async function listChats(pageSize: number): Promise<Chat[]> {
	const d = check(
		await client().im.v1.chat.list(
			{ params: { page_size: pageSize, sort_type: "ByActiveTimeDesc", user_id_type: "open_id", types: "p2p,group" } as any },
			await asUser(),
		),
		"会话列表",
	);
	return (d.items ?? []).map((c: any) => ({
		chat_id: c.chat_id,
		chat_mode: c.chat_mode,
		name: c.name ?? "",
		p2p_target_type: c.p2p_target_type,
	}));
}

/** 会话消息（含话题内回复）。start 为 unix 秒 */
export async function listMessages(
	container: { chatId?: string; threadId?: string },
	opts: { start?: number; order?: "asc" | "desc"; pageSize?: number; as?: "user" | "bot" } = {},
): Promise<Message[]> {
	const params: any = {
		container_id_type: container.threadId ? "thread" : "chat",
		container_id: container.threadId ?? container.chatId,
		sort_type: opts.order === "desc" ? "ByCreateTimeDesc" : "ByCreateTimeAsc",
		page_size: opts.pageSize ?? 50,
		card_msg_content_type: "raw_card_content",
		with_sender_name: true,
	};
	if (opts.start) params.start_time = String(Math.floor(opts.start));
	const auth = opts.as === "bot" ? undefined : await asUser();
	const d = check(await client().im.v1.message.list({ params }, auth), "读取消息");
	return (d.items ?? []).map(toMessage);
}

export async function getMessage(messageId: string, as: "user" | "bot" = "user"): Promise<Message | undefined> {
	const params = { card_msg_content_type: "raw_card_content" } as any;
	const d = check(
		await client().im.v1.message.get({ path: { message_id: messageId }, params }, as === "user" ? await asUser() : undefined),
		"读取消息",
	);
	return d.items?.[0] ? toMessage(d.items[0]) : undefined;
}

/** 给模型看的上下文：一行一条，时间 + 发送人 + 内容 */
export function formatMessages(msgs: Message[]): string {
	return msgs
		.filter((m) => !m.deleted)
		.map((m) => {
			const t = new Date(m.create_time).toLocaleString("sv-SE", { hour12: false }).slice(5, 16);
			const tag = m.thread_id && m.root_id ? "（话题回复）" : m.parent_id ? "（回复）" : "";
			return `[${t}] ${m.sender.name}${tag}：${m.content.replace(/\n/g, "\n  ")}`;
		})
		.join("\n");
}

async function tryIdentities<T>(
	fn: (as: "bot" | "user") => Promise<T>,
	idents: Array<"bot" | "user">,
	what: string,
): Promise<T | undefined> {
	const errors: string[] = [];
	for (const as of idents) {
		try {
			return await fn(as);
		} catch (e) {
			errors.push(`${as}: ${String((e as Error).message).slice(0, 200)}`);
		}
	}
	log(`${what}失败`, errors.join(" | "));
}

// 机器人默认没有读话题的权限，也不在 Yi 的大多数会话里：先 bot 后 user
export const threadContext = async (threadId: string, n: number) =>
	formatMessages(
		(
			(await tryIdentities((as) => listMessages({ threadId }, { order: "desc", pageSize: n, as }), ["bot", "user"], "读取话题")) ?? []
		).toReversed(),
	);

export const quotedMessage = async (messageId: string) => {
	const m = await tryIdentities((as) => getMessage(messageId, as), ["bot", "user"], "读取引用消息");
	return m ? formatMessages([m]) : "";
};

// ---------- 机器人身份发送 ----------

export async function replyAsBot(messageId: string, md: string, opts: { inThread?: boolean; uuid?: string } = {}) {
	const res = await client().im.v1.message.reply({
		path: { message_id: messageId },
		data: { msg_type: "post", content: postContent(md), reply_in_thread: opts.inThread, uuid: opts.uuid?.slice(0, 50) },
	});
	return check(res, "回复消息").message_id as string;
}

export async function sendToUserAsBot(openId: string, md: string): Promise<string> {
	const res = await client().im.v1.message.create({
		params: { receive_id_type: "open_id" },
		data: { receive_id: openId, msg_type: "post", content: postContent(md) },
	});
	const id = check(res, "私聊发送").message_id;
	if (!id) throw new Error("私聊发送后拿不到 message_id");
	return id;
}

/** 机器人私聊发一张卡片（JSON 2.0），返回消息 id；之后用 patchCard 原地更新 */
export async function sendCardToUserAsBot(openId: string, card: object): Promise<string> {
	let res;
	try {
		res = await client().im.v1.message.create({
			params: { receive_id_type: "open_id" },
			data: { receive_id: openId, msg_type: "interactive", content: JSON.stringify(card) },
		});
	} catch (e) {
		throw larkError(e, "发送卡片");
	}
	const id = check(res, "发送卡片").message_id;
	if (!id) throw new Error("发送卡片后拿不到 message_id");
	return id;
}

/** 更新已发出的卡片：只能更新 14 天内、update_multi 的卡片，单条消息 5 QPS */
export async function patchCard(messageId: string, card: object) {
	try {
		check(await client().im.v1.message.patch({ path: { message_id: messageId }, data: { content: JSON.stringify(card) } }), "更新卡片");
	} catch (e) {
		throw larkError(e, "更新卡片");
	}
}

const patchQueues = new Map<string, Promise<void>>();

/**
 * 排队更新一张卡片：同一条消息的更新按顺序执行，每次执行时才调 render 取最新内容，乱序到达也以最后一次为准。
 * render 返回 undefined 就不更新。失败只记日志：卡片是界面，状态以库里为准。
 */
export function queuePatch(messageId: string, render: () => object | undefined) {
	const next = (patchQueues.get(messageId) ?? Promise.resolve())
		.then(async () => {
			const card = render();
			if (card) await patchCard(messageId, card);
		})
		.catch((e) => log("更新卡片失败", messageId, e));
	patchQueues.set(messageId, next);
	void next.finally(() => {
		if (patchQueues.get(messageId) === next) patchQueues.delete(messageId);
	});
}

export async function react(messageId: string, emoji: string): Promise<string | undefined> {
	try {
		const res = await client().im.v1.messageReaction.create({
			path: { message_id: messageId },
			data: { reaction_type: { emoji_type: emoji } },
		});
		return check(res, "表情回复").reaction_id;
	} catch (e) {
		log("react 失败", emoji, e);
	}
}

export async function unreact(messageId: string, reactionId?: string) {
	if (!reactionId) return;
	try {
		check(await client().im.v1.messageReaction.delete({ path: { message_id: messageId, reaction_id: reactionId } }), "撤销表情");
	} catch (e) {
		log("unreact 失败", e);
	}
}

// ---------- 以 Yi 身份发出：只在 Yi 确认草稿之后调用 ----------

async function sendAsUser(target: UserTarget, msgType: string, content: string, uuid: string) {
	const auth = await asUser();
	const res = await (
		"chatId" in target
			? client().im.v1.message.create(
					{ params: { receive_id_type: "chat_id" }, data: { receive_id: target.chatId, msg_type: msgType, content, uuid } },
					auth,
				)
			: client().im.v1.message.reply(
					{ path: { message_id: target.replyTo }, data: { msg_type: msgType, content, reply_in_thread: target.inThread, uuid } },
					auth,
				)
	).catch((e) => {
		throw larkError(e, "以 Yi 身份发送");
	});
	return check(res, "以 Yi 身份发送").message_id as string;
}

export const sendTextAsUser = (target: UserTarget, md: string, uuid: string) => sendAsUser(target, "post", postContent(md), uuid);

/** 图片上传只支持应用身份；拿到的 image_key 再以 Yi 的身份发出 */
export async function sendImageAsUser(target: UserTarget, file: string, uuid: string) {
	const up = await client().im.v1.image.create({ data: { image_type: "message", image: createReadStream(file) } });
	const key = (up as any)?.image_key ?? (up as any)?.data?.image_key;
	if (!key) throw new Error("上传图片失败");
	return sendAsUser(target, "image", JSON.stringify({ image_key: key }), uuid);
}

export async function reactAsUser(messageId: string, emoji: string) {
	const res = await client()
		.im.v1.messageReaction.create({ path: { message_id: messageId }, data: { reaction_type: { emoji_type: emoji } } }, await asUser())
		.catch((e) => {
			throw larkError(e, "以 Yi 身份表情回复");
		});
	return check(res, "以 Yi 身份表情回复").reaction_id;
}

// ---------- 事件 ----------

export function toBotEvent(data: any): BotEvent {
	const m = data.message;
	const mentions: Mention[] = (m.mentions ?? []).map((x: any) => ({ key: x.key, id: x.id?.open_id ?? "", name: x.name }));
	return {
		messageId: m.message_id,
		chatId: m.chat_id,
		chatType: m.chat_type,
		senderType: data.sender?.sender_type ?? "",
		senderId: data.sender?.sender_id?.open_id ?? "",
		rootId: m.root_id || undefined,
		parentId: m.parent_id || undefined,
		threadId: m.thread_id || undefined,
		// 保留 @_user_1 这类 key，由调用方按 mentions 去掉
		content: m.message_type === "text" ? (JSON.parse(m.content).text ?? "") : messageText(m.message_type, m.content, []),
		mentions,
	};
}

/**
 * 长连接收 im.message.receive_v1 和卡片回调 card.action.trigger。SDK 自带断线重连；同一应用多条长连接时事件只推给其中一条。
 * 卡片回调的返回值由 SDK 经长连接回传（toast、新卡片），必须 3 秒内返回。
 * 开发者后台要在「事件与回调 → 回调配置」选长连接并订阅「卡片回传交互」，否则点按钮没有反应。
 */
export function startEvents(onMessage: (ev: BotEvent) => void, onCardAction?: (data: unknown) => Promise<unknown>) {
	const ws = new lark.WSClient({
		appId: FEISHU_APP_ID,
		appSecret: FEISHU_APP_SECRET,
		domain: lark.Domain.Feishu,
		loggerLevel: lark.LoggerLevel.warn,
	});
	const dispatcher = new lark.EventDispatcher({}).register({
		"im.message.receive_v1": (data) => {
			// 立即返回、处理放后台：长连接要求 3 秒内确认，否则会重推
			try {
				onMessage(toBotEvent(data));
			} catch (e) {
				log("处理事件失败", e);
			}
		},
		// 类型定义里没有这个回调
		...({
			"card.action.trigger": async (data: unknown) => {
				if (!onCardAction) return;
				try {
					return await onCardAction(data);
				} catch (e) {
					log("处理卡片回调失败", e);
					return { toast: { type: "error", content: "处理失败，详情见日志" } };
				}
			},
		} as any),
	});
	ws.start({ eventDispatcher: dispatcher });
	return () => ws.close();
}
