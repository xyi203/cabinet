// 起草：分派 agent、跑一轮、把草稿私聊给 Yi；进程中断后按同一 requestId 接回
import { changed } from "../bus.ts";
import { PATHS, SESSION_MAX_TOKENS, YI_ACTIVE_DELAY, YI_ACTIVE_WINDOW } from "../config.ts";
import { and, eq, inArray } from "drizzle-orm";
import { db, deleteKv, getKv, listKv, schema, setKv } from "../db/index.ts";
import type { MeegoCard } from "../db/schema.ts";
import { imageKeys, imagesNote, listMessages, saveImage } from "../lark/bot.ts";
import type { Message } from "../lark/types.ts";
import {
	ASSISTANT,
	LEGACY_TIER,
	glabRepo,
	loadAgents,
	mrBrief,
	resolveCwd,
	route,
	type RouteInfo,
	sessionKey,
	withTier,
} from "../agent/router.ts";
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
import { abortRun, forgetRun, hasRun, runKeyFor, runPi, running } from "../agent/driver.ts";
import { isStopping, log, now } from "../util.ts";
import { locks, sem } from "../agent/slots.ts";
import { contextBlock, gatherContext } from "./context.ts";
import { where as whereOf } from "./card.ts";
import { notifyFailure } from "./failure.ts";
import { draftLabel, isAckOnly, stickerHint } from "./format.ts";
import { ownerActive, ownerReplyCovers, staleReason } from "./replied.ts";
import { type ChatRef, claim, inflight, LIVE, pushDraft, type Source } from "./store.ts";

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
	/** assistant 的档位；改版前的 stage 没有，按旧 agent 名推（LEGACY_TIER） */
	tier?: string;
	/** ack 档写出文字、升到 answer 档之后的那次运行：requestId 带这个后缀 */
	suffix?: string;
	/** 对方在这批之前连着发、Yi 还没回的消息：一起起草，推出去之后它们各自的旧草稿标成已合并 */
	earlier?: Message[];
}

/** stage 实际用哪个 agent、哪一档：改版前接回的旧分派（ask、cr…）交给 assistant 的对应档位 */
export function stageAgent(stage: Pick<Stage, "source" | "tier">): { name: string; tier?: string } {
	const name = stage.source.agent ?? "";
	const legacy = LEGACY_TIER[name];
	return legacy ? { name: ASSISTANT, tier: stage.tier ?? legacy } : { name, tier: stage.tier };
}

interface Pending {
	chat: ChatRef;
	msgs: Message[];
	attempt?: string;
	stage?: Stage;
}

/**
 * 正在起草的（按聊天，同一聊天的起草排队，最多一条）：轮询看到 Yi 亲自回了就中止这次运行，不再花钱把用不上的草稿写完。
 * key 是当前那次运行的会话 key，交给 agent 之后才有
 */
interface Drafting {
	msgs: Message[];
	key?: string;
	aborted?: boolean;
}
const drafting = new Map<string, Drafting>();

/** 轮询看到 Yi 在这个聊天里发了消息：正在起草、而且这条算回复了那几条消息，就中止起草 */
export function abortIfYiReplied(chat: ChatRef, m: Message) {
	const d = drafting.get(chat.chat_id);
	if (!d?.key || d.aborted || m.create_time < d.msgs.at(-1)!.create_time || !ownerReplyCovers(chat.chat_mode, m, d.msgs)) return;
	// 订阅接续的会话可能被别的聊天共用：只停这个聊天自己的那次运行
	if (running.get(d.key)?.chatId !== chat.chat_id) return;
	d.aborted = true;
	log("起草期间 Yi 已亲自回复，中止运行", chat.chat_id, d.key);
	abortRun(d.key).catch((e) => log("中止起草失败", d.key, e));
}

/** Yi 正在这个聊天里聊：先等一会儿再起草，多半他自己就回了（之后起草前照常再查一次是否已回复） */
async function waitIfYiActive(chat: ChatRef, msgs: Message[]) {
	if (YI_ACTIVE_DELAY <= 0 || chat.chat_mode === "meego") return;
	let recent: Message[];
	try {
		recent = await listMessages({ chatId: chat.chat_id }, { order: "desc", pageSize: 30 });
	} catch (e) {
		log("检查 Yi 是否在聊失败", chat.chat_id, e);
		return;
	}
	if (!ownerActive(recent, msgs, YI_ACTIVE_WINDOW * 1000)) return;
	log(`Yi 正在聊，等 ${YI_ACTIVE_DELAY}s 再起草`, chat.chat_id);
	await new Promise((r) => setTimeout(r, YI_ACTIVE_DELAY * 1000));
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
	const requestId = requestIdOf(msgs, attempt);
	await locks.run(`draft-${chat.chat_id}`, async () => {
		const saved = getKv<Pending | null>(pendingKey, null)?.stage;
		const resuming = Boolean(saved && hasRun(`${requestId}${saved.suffix ?? ""}`));
		// 重启接回、手动重试不等：前者已经在跑，后者是 Yi 自己点的。等的时候不占并发名额
		if (!resuming && !attempt) await waitIfYiActive(chat, msgs);
		const self: Drafting = { msgs };
		drafting.set(chat.chat_id, self);
		try {
			await sem.run(() => draftLocked(self));
		} finally {
			drafting.delete(chat.chat_id);
		}
	});

	/** 拿到聊天锁和并发名额之后的起草 */
	async function draftLocked(self: Drafting) {
		const onError = (e: unknown) => {
			if (isStopping()) throw e;
			if (self.aborted) yiRepliedMidway(chat, source, label, routeId);
			else failed(chat, msgs, source, label, started, routeId, e);
		};
		const open = openRoute(triggerIds, "draft");
		// 上次进程已经把草稿推给 Yi，只是没来得及记成已处理：不再推第二张
		if (open?.actionId) {
			log("已经起草过，跳过", chat.chat_id, open.actionId);
			return;
		}
		const saved = getKv<Pending | null>(pendingKey, null)?.stage;
		if (saved && hasRun(`${requestId}${saved.suffix ?? ""}`)) {
			// 重启接回：上次已经交给 agent 了，直接挂回那次运行
			log("接回起草", chat.chat_id, requestId);
			routeId = saved.routeId;
			Object.assign(source, saved.source);
			try {
				await finish(chat, msgs, saved, requestId, pendingKey, attempt);
			} catch (e) {
				onError(e);
			}
			return;
		}
		const stale = await staleReason(chat, msgs);
		if (stale) {
			log(
				`${stale}，跳过起草`,
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
				reason: stale,
			});
			decide(triggerIds, { rule: `跳过：${stale}`, actionKind: "none" });
			return;
		}
		try {
			let ctx: string;
			let earlier: Message[] = [];
			if (chat.chat_mode === "meego" && source.meego) {
				ctx = await meegoContext(source.meego);
				source.context = ctx.slice(-2000);
			} else {
				const got = await gatherContext(chat, msgs);
				const { related, recent } = got;
				earlier = got.earlier;
				if (earlier.length) source.text = [...earlier, ...msgs].map((m) => m.content).join("\n");
				source.context = related;
				ctx = contextBlock(recent, related, source.text);
			}
			// 订阅接续：同一个话题 / 工作项、或提到的 MR 已经挂在某个会话上，档位照常分诊，会话接着用
			const thread = triggerOf(chat, last).thread;
			const keys = subscribable(thread, refsOf(source.text));
			const agents = loadAgents().agents;
			const sub = subscriber(keys);
			let name: string;
			let info: RouteInfo;
			let sid: string | null;
			const openName = open?.agent && (LEGACY_TIER[open.agent] ? ASSISTANT : open.agent);
			if (open && openName && agents[openName]) {
				// 重启接回：沿用上次的分派（同一个会话），durable 才接得回原来那次运行；改版前的旧 agent 名换成 assistant 的对应档位
				name = openName;
				info = { ...open.info, rule: open.rule, tier: open.info?.tier ?? LEGACY_TIER[open.agent!] };
				sid = open.session;
			} else {
				[name, info] = await route(source);
				// 寒暄档看不到图：消息带截图时至少按 answer 档，把图交给 agent 看（否则只能回「看不到图」）
				if (info.tier === "ack" && msgs.some((m) => imageKeys(m.content).length))
					info = { ...info, tier: "answer", rule: `${info.rule}（带截图，升到 answer）` };
				// 寒暄确认不需要前文，不接续也不挂订阅
				if (sub && info.tier !== "ack") {
					const { mrProject, mrIid } = (sub.info ?? {}) as Record<string, string>;
					// 挂在 MR 上的会话：后续消息按 MR 预审档接着看
					if (mrIid) info = { ...info, tier: "mr", mrProject, mrIid };
					info = { ...info, rule: `${info.rule}；接续 ${sub.key}` };
					sid = sub.session;
				} else sid = sessionKey(name, withTier(agents[name] ?? {}, info.tier), chat.chat_id, info);
			}
			const agent = withTier(agents[name] ?? {}, info.tier);
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
			if (sid && info.tier !== "ack") subscribe(keys, { agent: name, session: sid, info: routeExtra as Record<string, string>, routeId });
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
				tier: info.tier,
				prompt: info.tier === "ack" ? prompt : `${prompt}${await imageHint([...earlier, ...msgs])}`,
				basePrompt: prompt,
				cwd: resolveCwd(agent, info),
				label,
				routeId,
				triggerIds,
				started,
				earlier,
			};
			setKv(pendingKey, { chat, msgs, attempt, stage } satisfies Pending);
			await finish(chat, msgs, stage, requestId, pendingKey, attempt);
		} catch (e) {
			onError(e);
		}
	}
}

/** 审批卡片上的来源：谁、在哪发的消息 */
export function originLabel(chat: Pick<ChatRef, "chat_mode" | "name">, source: Pick<Source, "senderName">) {
	if (chat.chat_mode === "p2p") return `${source.senderName} 私聊你的消息`;
	if (chat.chat_mode === "meego") return `${source.senderName} 在飞书项目「${chat.name}」的评论`;
	return `${source.senderName} 在群「${chat.name}」@你的消息`;
}

/** 跑（或接回）这一步的 agent 运行 */
function runStage(chat: ChatRef, stage: Stage, requestId: string) {
	const { source } = stage;
	const { name, tier } = stageAgent(stage);
	const d = drafting.get(chat.chat_id);
	if (d) {
		// ack 档升到 answer 之前 Yi 已经回了：不再起第二次运行
		if (d.aborted) throw new Error("起草期间 Yi 已亲自回复");
		d.key = runKeyFor(source.session, requestId);
	}
	return runPi({
		cwd: stage.cwd,
		sessionId: source.session,
		requestId,
		prompt: stage.prompt,
		extraSystem: [PATHS.draftRules],
		label: stage.label,
		agent: withTier(loadAgents().agents[name] ?? {}, tier),
		agentName: name,
		origin: { label: originLabel(chat, source), draftReplyTo: source.replyTo },
		chatId: chat.chat_id,
		lookup: true,
		maxContext: SESSION_MAX_TOKENS,
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
	// ack 档用的是便宜模型、不查任何资料，写出文字就可能编事实（替 Yi 确认店铺、猜原因）：只收表情和「无需回复」，否则升到 answer 档重写
	if (stageAgent(stage).tier === "ack" && !stage.suffix && !isAckOnly(draft)) {
		const { name } = stageAgent(stage);
		const next = "answer";
		log("ack 档输出了文字，升到", next, chat.chat_id);
		const agent = withTier(loadAgents().agents[name] ?? {}, next);
		const info: RouteInfo = { tier: next, rule: `${stage.source.route ?? ""}（ack 档输出文字，升到 ${next}）` };
		const sid = sessionKey(name, agent, chat.chat_id, info);
		// 四段模型里是一次新的分派；ack 那次记成「改派」
		settle({
			actionKind: "draft",
			routeId: stage.routeId,
			outcome: "rerouted",
			effect: "internal",
			detail: `ack 档输出文字，升到 ${next}`,
		});
		const routeId = decide(stage.triggerIds, { agent: name, rule: info.rule, session: sid, info: { tier: next }, actionKind: "draft" });
		stage = {
			...stage,
			tier: next,
			source: { ...stage.source, agent: name, session: sid, route: info.rule, routeId },
			prompt: `${stage.basePrompt}${await imageHint([...(stage.earlier ?? []), ...msgs])}`,
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
	// 起草可能跑了好几分钟：这期间 Yi 自己回了，草稿就没用了（轮询看到 Yi 的回复时这张草稿还没推，作废不到它）；
	// 对方又接着发了也不推，后面那条会把这几条一起起草
	const stale = await staleReason(chat, msgs);
	if (stale) {
		log(`起草期间${stale}，不推草稿`, chat.chat_id, requestId);
		record({
			kind: "draft",
			status: "skipped",
			chatId: chat.chat_id,
			source: source.replyTo,
			label,
			question: source.text,
			reason: `起草期间${stale}`,
		});
		const outcome = stale.startsWith("Yi") ? "expired" : "merged";
		settle({ actionKind: "draft", routeId, outcome, effect: "internal", detail: `起草期间${stale}` });
		return;
	}
	const dm = await pushDraft(source, draft);
	linkAction(routeId, dm, sessionId);
	mergeEarlier(chat, stage.earlier ?? [], dm);
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

/** 新草稿已经把前面连着发的几条一起回了：那几条还没处理的旧草稿标成已合并，免得 Yi 对着几张卡片各回一遍 */
function mergeEarlier(chat: ChatRef, earlier: Message[], into: string) {
	if (!earlier.length) return;
	const ids = earlier.map((m) => m.message_id);
	const old = db()
		.select()
		.from(schema.drafts)
		.where(and(eq(schema.drafts.chatId, chat.chat_id), inArray(schema.drafts.replyTo, ids), inArray(schema.drafts.status, LIVE)))
		.all();
	for (const d of old) {
		if (!claim(d.id, LIVE, "merged")) continue;
		log("草稿合并到新草稿", d.id, "->", into);
		settle({ actionKind: "draft", actionId: d.id, routeId: d.routeId, outcome: "merged", effect: "internal", ref: into });
	}
}

/** 运行被 abortIfYiReplied 中止：和起草完才发现 Yi 已回复一样记成跳过、草稿作废，不当失败提醒 */
function yiRepliedMidway(chat: ChatRef, source: Source, label: string, routeId: number | undefined) {
	const reason = "起草期间Yi 已亲自回复";
	log(`${reason}，已中止`, chat.chat_id, source.replyTo);
	record({ kind: "draft", status: "skipped", chatId: chat.chat_id, source: source.replyTo, label, question: source.text, reason });
	settle({ actionKind: "draft", routeId, outcome: "expired", effect: "internal", detail: reason });
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
