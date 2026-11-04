// 起草：分派 agent、跑一轮、把草稿私聊给 Yi；进程中断后按同一 requestId 接回
import { changed } from "../bus.ts";
import { PATHS } from "../config.ts";
import { deleteKv, listKv, setKv } from "../db/index.ts";
import type { MeegoCard } from "../db/schema.ts";
import type { ImageContent } from "@earendil-works/pi-ai";
import { downloadImage, imageKeys } from "../lark/bot.ts";
import type { Message } from "../lark/types.ts";
import { glabRepo, loadAgents, mrBrief, resolveCwd, route, sessionKey } from "../agent/router.ts";
import { meegoContext } from "../meego.ts";
import { record } from "../records.ts";
import { runPi } from "../agent/driver.ts";
import { isStopping, log, now } from "../util.ts";
import { locks, sem } from "../agent/slots.ts";
import { contextBlock, gatherContext } from "./context.ts";
import { draftLabel, isAckOnly, stickerHint } from "./format.ts";
import { yiReplied } from "./replied.ts";
import { type ChatRef, inflight, pushDraft, type Source } from "./store.ts";

/**
 * attempt 区分手动重试：同一批消息默认用同一个 requestId，进程重启后重新提交会接回原来那次运行；
 * 手动重试要换一个，否则拿回的是上次失败的结果。
 */
export async function makeDraft(chat: ChatRef, msgs: Message[], onDone?: (ids: string[]) => void, attempt?: string) {
	// 起草中的任务记到库里：跑得久时轮询进度会越过这条消息，重启后靠它接回
	const pendingKey = `pending:draft:${msgs.at(-1)!.message_id}`;
	setKv(pendingKey, { chat, msgs, attempt });
	let interrupted = false;
	try {
		await _makeDraft(chat, msgs, attempt);
	} catch (e) {
		if (!isStopping()) throw e;
		interrupted = true;
	} finally {
		if (!interrupted) {
			deleteKv(pendingKey);
			onDone?.(msgs.map((m) => m.message_id));
		}
		for (const m of msgs) inflight.delete(m.message_id);
		changed();
	}
}

async function _makeDraft(chat: ChatRef, msgs: Message[], attempt?: string) {
	const last = msgs.at(-1)!;
	const source: Source = {
		chatId: chat.chat_id,
		chatMode: chat.chat_mode,
		chatName: chat.name ?? "",
		replyTo: last.message_id,
		threadId: last.thread_id,
		senderId: last.sender.id,
		senderName: last.sender.name || last.sender.id,
		text: msgs.map((m) => m.content).join("\n"),
		meego: (last.meego as MeegoCard) ?? null,
	};
	const label = draftLabel(source);
	const started = now();
	await locks.run(`draft-${chat.chat_id}`, () =>
		sem.run(async () => {
			if (await yiReplied(chat, msgs)) {
				log(
					"Yi 已亲自回复，跳过起草",
					chat.chat_id,
					msgs.map((m) => m.message_id),
				);
				record({
					kind: "draft",
					status: "skipped",
					chatId: chat.chat_id,
					source: source.replyTo,
					label,
					question: source.text,
					reason: "Yi 已亲自回复",
				});
				return;
			}
			try {
				let ctx: string;
				if (chat.chat_mode === "meego" && source.meego) {
					ctx = await meegoContext(source.meego);
					source.context = ctx.slice(-2000);
				} else {
					const { related, recent } = await gatherContext(chat.chat_id, msgs);
					source.context = related;
					ctx = contextBlock(recent, related, source.text);
				}
				let [name, info] = await route(source);
				let agent = loadAgents().agents[name] ?? {};
				let sid = sessionKey(name, agent, chat.chat_id, info);
				Object.assign(source, { agent: name, session: sid, route: info.rule });
				log("分派", chat.chat_id, "->", name, info.rule);
				let where: string;
				let hint: string;
				if (chat.chat_mode === "meego" && source.meego) {
					const mg = source.meego;
					ctx = `${ctx}\n\n需要回复的新评论：\n${source.text}`;
					where = `飞书项目「${source.chatName}」（${mg.url}）的评论里 @Yi`;
					hint =
						"这是飞书项目工作项下的评论，回复会以 Yi 的身份发成一条新评论，只能是文字，不要用【表情】【表情包】；" +
						`可以用 meegle 只读命令查更多信息，例如 \`meegle workitem get --project-key ${mg.projectKey} --work-item-id ${mg.workItemId}\`。`;
				} else {
					where = chat.chat_mode === "p2p" ? "私聊" : `群「${source.chatName}」里 @Yi`;
					hint = stickerHint();
				}
				const extra = info.mrIid
					? `\n\n要预审的 MR：项目 \`${info.mrProject}\`，iid \`${info.mrIid}\`，glab 的 -R 参数用 \`${glabRepo(info.mrProject!)}\`。\nMR 概要（glab mr view）：\n${await mrBrief(info)}`
					: "";
				const prompt = `[代回复草稿] ${where}，来自 ${source.senderName}\n\n${ctx}${extra}\n\n${hint}\n\n请按草稿规则起草 Yi 的回复。`;
				// 截图常常就是问题本身：把要回复的那几条消息里的图片一起给模型；chat 只回表情，不用看
				let images = name === "chat" ? [] : await draftImages(msgs);
				const run = (suffix = "") =>
					runPi({
						cwd: resolveCwd(agent, info),
						sessionId: sid,
						requestId: `draft:${source.replyTo}${attempt ? `:${attempt}` : ""}${suffix}`,
						prompt,
						extraSystem: [PATHS.draftRules],
						label,
						agent,
						agentName: name,
						chatId: chat.chat_id,
						images,
						memory: {
							// 只有 @ 的消息意思在前文里，召回也带上最后一段前文
							query: `${source.text}\n${(source.context ?? "").slice(-300)}`,
							scope: { personId: chat.chat_mode === "meego" ? undefined : source.senderId, chatId: chat.chat_id },
						},
					});
				let { text: draft, usage, sessionId } = await run();
				// chat 用的是便宜模型、不查任何资料，写出文字就可能编事实（替 Yi 确认店铺、猜原因）：只收表情和「无需回复」，否则交给兜底 agent 重写
				if (name === "chat" && !isAckOnly(draft)) {
					const { router, agents } = loadAgents();
					const next = router.fallback && agents[router.fallback] ? router.fallback : "general";
					log("chat 输出了文字，改派", next, chat.chat_id);
					name = next;
					agent = agents[next] ?? {};
					info = { rule: `${info.rule}（chat 输出文字，改派 ${next}）` };
					sid = sessionKey(name, agent, chat.chat_id, info);
					Object.assign(source, { agent: name, session: sid, route: info.rule });
					images = await draftImages(msgs);
					({ text: draft, usage, sessionId } = await run(`:${next}`));
				}
				source.session = sessionId;
				const dm = await pushDraft(source, draft);
				record({
					kind: "draft",
					status: "drafted",
					chatId: chat.chat_id,
					source: source.replyTo,
					dm,
					session: sessionId,
					agent: name,
					label,
					seconds: now() - started,
					usage,
					question: source.text,
					answer: draft,
				});
			} catch (e) {
				if (isStopping()) throw e;
				log("起草失败", chat.chat_id, e);
				record({
					kind: "draft",
					status: "failed",
					chatId: chat.chat_id,
					source: source.replyTo,
					session: source.session,
					agent: source.agent,
					label,
					seconds: now() - started,
					error: String((e as Error).message),
					question: source.text,
					retry: { chat, msgs },
				});
			}
		}),
	);
}

const MAX_IMAGES = 4;

async function draftImages(msgs: Message[]): Promise<ImageContent[]> {
	const wanted = msgs.flatMap((m) => imageKeys(m.content).map((key) => ({ id: m.message_id, key }))).slice(-MAX_IMAGES);
	const got = await Promise.all(wanted.map(({ id, key }) => downloadImage(id, key)));
	return got.filter((x) => x !== undefined).map((x) => ({ type: "image", ...x }));
}

/** 启动时接回上次进程没起草完的消息 */
export function resumePendingDrafts(onDone: (ids: string[]) => void) {
	for (const { value } of listKv<{ chat: ChatRef; msgs: Message[]; attempt?: string }>("pending:draft:")) {
		const { chat, msgs, attempt } = value;
		log(
			"接回未完成的起草",
			chat.chat_id,
			msgs.map((m) => m.message_id),
		);
		for (const m of msgs)
			inflight.set(m.message_id, {
				chatId: chat.chat_id,
				chatMode: chat.chat_mode,
				label: draftLabel({ chatMode: chat.chat_mode, chatName: chat.name, senderName: m.sender.name }),
				text: m.content.slice(0, 300),
				since: now(),
			});
		void makeDraft(chat, msgs, onDone, attempt);
	}
}
