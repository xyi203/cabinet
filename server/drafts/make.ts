// 起草：分派 agent、跑一轮、把草稿私聊给 Yi；进程中断后按同一 requestId 接回
import { changed } from "../bus.ts";
import { PATHS } from "../config.ts";
import { deleteKv, getKv, listKv, setKv } from "../db/index.ts";
import type { MeegoCard } from "../db/schema.ts";
import { imageKeys, imagesNote, saveImage } from "../lark/bot.ts";
import type { Message } from "../lark/types.ts";
import { glabRepo, loadAgents, mrBrief, resolveCwd, route, type RouteInfo, sessionKey } from "../agent/router.ts";
import { meegoContext } from "../meego.ts";
import {
	decide,
	linkAction,
	openRoute,
	receive,
	refsOf,
	settle,
	subscribable,
	subscribe,
	subscriber,
	type TriggerInput,
} from "../pipeline.ts";
import { record } from "../records.ts";
import { forgetRun, hasRun, runPi } from "../agent/driver.ts";
import { isStopping, log, now } from "../util.ts";
import { locks, sem } from "../agent/slots.ts";
import { contextBlock, gatherContext } from "./context.ts";
import { where as whereOf } from "./card.ts";
import { notifyFailure } from "./failure.ts";
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
	// 重启接回时保留上次记下的这一步（stage），只更新消息和 attempt
	const prev = getKv<Pending | null>(pendingKey, null);
	setKv(pendingKey, { chat, msgs, attempt, stage: prev?.attempt === attempt ? prev?.stage : undefined } satisfies Pending);
	let interrupted = false;
	try {
		await _makeDraft(chat, msgs, pendingKey, attempt);
	} catch (e) {
		if (!isStopping()) throw e;
		interrupted = true;
	} finally {
		if (!interrupted) {
			const suffix = getKv<Pending | null>(pendingKey, null)?.stage?.suffix;
			deleteKv(pendingKey);
			forgetRun(requestIdOf(msgs, attempt));
			if (suffix) forgetRun(`${requestIdOf(msgs, attempt)}${suffix}`);
			onDone?.(msgs.map((m) => m.message_id));
		}
		for (const m of msgs) inflight.delete(m.message_id);
		changed();
	}
}

/**
 * 交给 agent 之前记下的这一步：分派、前文、提示都已经定了。重启后有它、而且这次提交还在（driver 的 hasRun），
 * 就直接挂回原来那次运行，不重新拉前文、不重新分派、不重新查 MR。
 */
interface Stage {
	source: Source;
	/** 交给 agent 的提示（带上截图路径）；basePrompt 不带，改派时给新 agent 重新附图 */
	prompt: string;
	basePrompt: string;
	cwd: string;
	label: string;
	routeId: number;
	triggerIds: string[];
	started: number;
	/** chat 写出文字、改派之后的那次运行：requestId 带这个后缀 */
	suffix?: string;
}

interface Pending {
	chat: ChatRef;
	msgs: Message[];
	attempt?: string;
	stage?: Stage;
}

/** 同一批消息默认同一个 requestId，进程重启后接回原来那次运行；手动重试带 attempt，换一个 */
const requestIdOf = (msgs: Message[], attempt?: string) => `draft:${msgs.at(-1)!.message_id}${attempt ? `:${attempt}` : ""}`;

/** 轮询到的消息（飞书私聊 / @Yi、飞书项目评论 @Yi）就是 trigger：过了轮询里的程序规则才会到这里 */
function triggerOf(chat: ChatRef, m: Message): TriggerInput {
	const meego = m.meego as MeegoCard | undefined;
	return {
		channel: chat.chat_mode === "meego" ? "meego" : "lark",
		externalId: m.message_id,
		thread: meego ? `meego:${meego.workItemId}` : `lark:${chat.chat_id}${m.thread_id ? `#${m.thread_id}` : ""}`,
		actorId: m.sender.id,
		actorName: m.sender.name || m.sender.id,
		text: m.content,
		url: meego?.url,
		at: m.create_time / 1000,
	};
}

async function _makeDraft(chat: ChatRef, msgs: Message[], pendingKey: string, attempt?: string) {
	const last = msgs.at(-1)!;
	// 重启接回、手动重试会再走一遍：trigger 已经记过就不动
	const triggerIds = msgs.map((m) => receive(triggerOf(chat, m)));
	let routeId: number | undefined;
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
			const open = openRoute(triggerIds, "draft");
			// 上次进程已经把草稿推给 Yi，只是没来得及记成已处理：不再推第二张
			if (open?.actionId) {
				log("已经起草过，跳过", chat.chat_id, open.actionId);
				return;
			}
			const requestId = requestIdOf(msgs, attempt);
			const saved = getKv<Pending | null>(pendingKey, null)?.stage;
			if (saved && hasRun(`${requestId}${saved.suffix ?? ""}`)) {
				// 重启接回：上次已经交给 agent 了，直接挂回那次运行
				log("接回起草", chat.chat_id, requestId);
				routeId = saved.routeId;
				Object.assign(source, saved.source);
				try {
					await finish(chat, msgs, saved, requestId, pendingKey, attempt);
				} catch (e) {
					if (isStopping()) throw e;
					failed(chat, msgs, source, label, started, routeId, e);
				}
				return;
			}
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
				decide(triggerIds, { rule: "跳过：Yi 已亲自回复", actionKind: "none" });
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
				// 订阅直通（Fast Path）：同一个话题 / 工作项、或提到的 MR 已经挂在某个会话上，直接进那个会话，不再分诊
				const thread = triggerOf(chat, last).thread;
				const keys = subscribable(thread, refsOf(source.text));
				const agents = loadAgents().agents;
				const sub = subscriber(keys);
				let name: string;
				let info: RouteInfo;
				let sid: string | null;
				if (open?.agent && agents[open.agent]) {
					// 重启接回：沿用上次的分派（同一个 agent、同一个会话），durable 才接得回原来那次运行
					name = open.agent;
					info = { ...open.info, rule: open.rule };
					sid = open.session;
				} else if (sub && agents[sub.agent]) {
					name = sub.agent;
					info = { ...sub.info, rule: `订阅直通：${sub.key}` };
					sid = sub.session;
				} else {
					[name, info] = await route(source);
					sid = sessionKey(name, agents[name] ?? {}, chat.chat_id, info);
				}
				const agent = agents[name] ?? {};
				const { rule: _rule, ...routeExtra } = info;
				routeId =
					open?.id ??
					decide(triggerIds, {
						agent: name,
						rule: info.rule,
						session: sid,
						info: routeExtra as Record<string, string>,
						actionKind: "draft",
					});
				// 之后同一件事（这个话题、这个 MR）的消息都进这个会话，跨渠道也接得上
				if (sid) subscribe(keys, { agent: name, session: sid, info: routeExtra as Record<string, string>, routeId });
				Object.assign(source, { agent: name, session: sid, route: info.rule, routeId });
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
				// 链式召回的起点：这条消息和它所在事件流的 ID，需要以前的来龙去脉时用 lookup 查
				const ids = `（这条消息的 ID：${triggerIds.at(-1)}；所在事件流：thread:${thread}${refsOf(source.text)
					.map((r) => `；提到 ${r}`)
					.join("")}）`;
				const prompt = `[代回复草稿] ${where}，来自 ${source.senderName}\n\n${ctx}${extra}\n\n${hint}\n\n${ids}\n\n请按草稿规则起草 Yi 的回复。`;
				// 截图常常就是问题本身：存到本地，把路径给 agent 用 read 查看；chat 没有工具、只回表情，不用看
				const stage: Stage = {
					source: { ...source },
					prompt: name === "chat" ? prompt : `${prompt}${await imageHint(msgs)}`,
					basePrompt: prompt,
					cwd: resolveCwd(agent, info),
					label,
					routeId,
					triggerIds,
					started,
				};
				setKv(pendingKey, { chat, msgs, attempt, stage } satisfies Pending);
				await finish(chat, msgs, stage, requestId, pendingKey, attempt);
			} catch (e) {
				if (isStopping()) throw e;
				failed(chat, msgs, source, label, started, routeId, e);
			}
		}),
	);
}

/** 跑（或接回）这一步的 agent 运行 */
function runStage(chat: ChatRef, stage: Stage, requestId: string) {
	const { source } = stage;
	const name = source.agent ?? "";
	return runPi({
		cwd: stage.cwd,
		sessionId: source.session,
		requestId,
		prompt: stage.prompt,
		extraSystem: [PATHS.draftRules],
		label: stage.label,
		agent: loadAgents().agents[name] ?? {},
		agentName: name,
		chatId: chat.chat_id,
		lookup: true,
		memory: {
			// 只有 @ 的消息意思在前文里，召回也带上最后一段前文
			query: `${source.text}\n${(source.context ?? "").slice(-300)}`,
			scope: { personId: chat.chat_mode === "meego" ? undefined : source.senderId, chatId: chat.chat_id },
		},
	});
}

/** 跑（或接回）起草这一轮，推草稿给 Yi。起草期间 Yi 已经亲自回了的，不再推 */
async function finish(chat: ChatRef, msgs: Message[], first: Stage, requestId: string, pendingKey: string, attempt?: string) {
	let stage = first;
	let { text: draft, usage, sessionId } = await runStage(chat, stage, `${requestId}${stage.suffix ?? ""}`);
	// chat 用的是便宜模型、不查任何资料，写出文字就可能编事实（替 Yi 确认店铺、猜原因）：只收表情和「无需回复」，否则交给兜底 agent 重写
	if (stage.source.agent === "chat" && !stage.suffix && !isAckOnly(draft)) {
		const { router, agents } = loadAgents();
		const next = router.fallback && agents[router.fallback] ? router.fallback : "general";
		log("chat 输出了文字，改派", next, chat.chat_id);
		const agent = agents[next] ?? {};
		const info: RouteInfo = { rule: `${stage.source.route ?? ""}（chat 输出文字，改派 ${next}）` };
		const sid = sessionKey(next, agent, chat.chat_id, info);
		// 四段模型里是一次新的分派；chat 那次记成「改派」
		settle({ actionKind: "draft", routeId: stage.routeId, outcome: "rerouted", effect: "internal", detail: `chat 输出文字，改派 ${next}` });
		const routeId = decide(stage.triggerIds, { agent: next, rule: info.rule, session: sid, actionKind: "draft" });
		stage = {
			...stage,
			source: { ...stage.source, agent: next, session: sid, route: info.rule, routeId },
			prompt: `${stage.basePrompt}${await imageHint(msgs)}`,
			cwd: resolveCwd(agent, info),
			routeId,
			suffix: `:${next}`,
		};
		// 改派之后的这一步也记下：这次运行里重启也接得回
		setKv(pendingKey, { chat, msgs, attempt, stage } satisfies Pending);
		({ text: draft, usage, sessionId } = await runStage(chat, stage, `${requestId}${stage.suffix}`));
	}
	const { source, label, routeId, started } = stage;
	const name = source.agent ?? "";
	source.session = sessionId;
	// 起草可能跑了好几分钟：这期间 Yi 自己回了，草稿就没用了（轮询看到 Yi 的回复时这张草稿还没推，作废不到它）
	if (await yiReplied(chat, msgs)) {
		log("起草期间 Yi 已亲自回复，不推草稿", chat.chat_id, requestId);
		record({
			kind: "draft",
			status: "skipped",
			chatId: chat.chat_id,
			source: source.replyTo,
			label,
			question: source.text,
			reason: "起草期间 Yi 已亲自回复",
		});
		settle({ actionKind: "draft", routeId, outcome: "expired", effect: "internal", detail: "起草期间 Yi 已亲自回复" });
		return;
	}
	const dm = await pushDraft(source, draft);
	linkAction(routeId, dm, sessionId);
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
}

function failed(chat: ChatRef, msgs: Message[], source: Source, label: string, started: number, routeId: number | undefined, e: unknown) {
	log("起草失败", chat.chat_id, e);
	settle({ actionKind: "draft", routeId, outcome: "failed", effect: "internal", detail: String((e as Error).message) });
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
	// 对方的消息没人回：私聊提醒一次，可以直接重试或忽略（重试后又失败会再提醒）
	void notifyFailure({ taskId: `fail-${source.replyTo}`, where: whereOf(source), text: source.text, error: String((e as Error).message) });
}

const MAX_IMAGES = 4;

/** 把要回复的那几条消息里的图片存到本地，返回附在提示后面的路径清单 */
async function imageHint(msgs: Message[]): Promise<string> {
	const wanted = msgs.flatMap((m) => imageKeys(m.content).map((key) => ({ id: m.message_id, key }))).slice(-MAX_IMAGES);
	const saved = await Promise.all(wanted.map(async ({ id, key }) => [key, await saveImage(id, key, PATHS.images)] as const));
	return imagesNote(saved);
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
