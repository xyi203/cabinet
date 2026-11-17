// 自动沉淀：一条草稿走完（发 / 不发 / 完成 / Yi 亲自回复作废）时的改稿过程，和一次问答里的工具结果。
// - 材料由程序从草稿、流水和工具调用拼出来；注入的记忆不在材料里，memory 工具的结果也不收，不会被当成新证据
// - 整批 retain 进 Hindsight（document_id 是来源，重试整篇替换），抽什么由 bank 的 retain_mission 管
// - 有 Yi 自己的话时，只把这几段（加一段背景）送进 OpenViking，由它更新 Yi 的偏好与人物
// - 任务先记进 kv，成功才删；失败过一会儿重试，进程重启后接着做
import { and, asc, eq } from "drizzle-orm";
import { MEMORY, OWNER_OPEN_ID } from "../config.ts";
import { conversationLog } from "../agent/driver.ts";
import { db, deleteKv, getKv, listKv, schema, setKv } from "../db/index.ts";
import { log } from "../util.ts";
import { retain } from "./hindsight.ts";
import { normalize, redact } from "./store.ts";
import { commit } from "./viking.ts";

const WINDOW_CHARS = 24_000;
const MAX_ATTEMPTS = 5;
const RETRY_MS = 10 * 60_000;

// ---------- 任务 ----------

export type MemoryJob =
	| {
			type: "draft";
			replyTo: string;
			outcome: "sent" | "discarded" | "completed" | "expired";
			/** Yi 亲自回复导致草稿作废时，他的那条回复 */
			yiReply?: { id: string; text: string; at: number };
	  }
	| {
			type: "qa";
			messageId: string;
			session: string;
			chatId: string;
			askerId: string;
			askerName: string;
			question: string;
			answer: string;
			start: number;
			end: number;
	  };

const jobKey = (j: MemoryJob) => `pending:memory:${j.type === "draft" ? `draft:${j.replyTo}` : `qa:${j.messageId}`}`;

let chain: Promise<unknown> = Promise.resolve();

/** 失败次数单独记，不和任务混在 pending:memory: 前缀下 */
const attemptKey = (key: string) => `memory-attempt:${key}`;

/** 排进后台串行队列；失败只记日志并稍后重试，不影响草稿和问答 */
export function enqueueMemory(job: MemoryJob, attempt = getKv<number>(attemptKey(jobKey(job)), 0)) {
	if (!MEMORY.enabled) return;
	const key = jobKey(job);
	setKv(key, job);
	chain = chain.then(async () => {
		try {
			await processJob(job);
			deleteKv(key);
			deleteKv(attemptKey(key));
		} catch (e) {
			const n = attempt + 1;
			log(`记忆沉淀失败（第 ${n} 次）`, key, String((e as Error).message).slice(0, 300));
			if (n >= MAX_ATTEMPTS) {
				deleteKv(key);
				deleteKv(attemptKey(key));
				return;
			}
			setKv(attemptKey(key), n);
			setTimeout(() => enqueueMemory(job, n), RETRY_MS).unref();
		}
	});
}

export function resumePendingMemory() {
	for (const { value } of listKv<MemoryJob>("pending:memory:")) enqueueMemory(value);
}

/** 测试用 */
export const memoryIdle = () => chain;

// ---------- 材料 ----------

/** yi：Yi 的话，可作 user_statement 的证据；tool：工具结果；其余只是背景 */
export interface Material {
	n: number;
	role: "yi" | "other" | "context" | "draft" | "outcome" | "tool" | "answer";
	label: string;
	text: string;
	ref: string;
	at: number;
}

export interface Batch {
	source: string;
	query: string;
	person?: { id: string; name: string };
	chat?: { id: string; name: string };
	materials: Material[];
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

async function toolMaterials(session: string | null | undefined, windows: Array<[number, number]>): Promise<Omit<Material, "n">[]> {
	if (!session) return [];
	const out: Omit<Material, "n">[] = [];
	const seen = new Set<string>();
	for (const [start, end] of windows) {
		for (const s of (await conversationLog(session, start, end)) ?? []) {
			// 记忆查询的结果是已有记忆，不是新证据
			if (s.kind !== "call" || !s.result || s.tool === "memory") continue;
			const sig = `${s.t}:${s.tool}`;
			if (seen.has(sig)) continue;
			seen.add(sig);
			out.push({
				role: "tool",
				label: `工具 ${s.tool}(${clip(JSON.stringify(s.args ?? {}), 200)})${s.error ? " 出错" : ""}`,
				text: clip(s.result, 1500),
				ref: `${session}@${s.t}`,
				at: s.t,
			});
		}
	}
	return out;
}

/** 一条草稿从起草、改稿到发出（或不发）的全过程 */
async function draftBatch(job: Extract<MemoryJob, { type: "draft" }>): Promise<Batch | undefined> {
	const drafts = db().select().from(schema.drafts).where(eq(schema.drafts.replyTo, job.replyTo)).orderBy(asc(schema.drafts.created)).all();
	if (!drafts.length) return;
	const first = drafts[0];
	const last = drafts.at(-1)!;
	const recs = db()
		.select()
		.from(schema.records)
		.where(and(eq(schema.records.source, job.replyTo), eq(schema.records.kind, "draft")))
		.orderBy(asc(schema.records.ts))
		.all();
	const m: Omit<Material, "n">[] = [];
	const where =
		first.chatMode === "p2p" ? "私聊" : first.chatMode === "meego" ? `飞书项目「${first.chatName}」` : `群「${first.chatName}」`;
	if (first.context) m.push({ role: "context", label: "前文", text: clip(first.context, 1500), ref: job.replyTo, at: first.created });
	m.push({ role: "other", label: `${first.senderName}（${where}）的消息`, text: first.text, ref: job.replyTo, at: first.created });
	for (const d of drafts) {
		m.push({ role: "draft", label: `助理的草稿${d.agent ? `（${d.agent}）` : ""}`, text: d.draft || d.note, ref: d.id, at: d.created });
		const opinion = recs.find((r) => r.status === "revised" && r.dm === d.id && r.question);
		if (opinion) m.push({ role: "yi", label: "Yi 的改稿意见", text: opinion.question!, ref: `revise:${d.id}`, at: opinion.ts });
	}
	const sent = recs.findLast((r) => r.status === "sent");
	if (job.outcome === "sent") {
		const text = sent?.answer ?? last.draft;
		if (sent?.answer && normalize(sent.answer) !== normalize(last.draft))
			m.push({ role: "yi", label: "Yi 改过之后发出的内容", text, ref: `sent:${last.id}`, at: sent.ts });
		else
			m.push({
				role: "outcome",
				label: "处理结果",
				text: "Yi 原样发出了最后一版草稿",
				ref: `sent:${last.id}`,
				at: sent?.ts ?? last.created,
			});
	} else if (job.outcome === "expired" && job.yiReply) {
		m.push({ role: "yi", label: "Yi 没用草稿，自己回复的内容", text: job.yiReply.text, ref: job.yiReply.id, at: job.yiReply.at });
	} else {
		const text = { discarded: "Yi 选择不发", completed: "Yi 标记为已处理（自己处理了）", expired: "Yi 自己处理了", sent: "" }[job.outcome];
		m.push({ role: "outcome", label: "处理结果", text, ref: `${job.outcome}:${last.id}`, at: last.created });
	}
	const windows = recs.filter((r) => r.seconds != null).map((r) => [r.ts - r.seconds!, r.ts] as [number, number]);
	m.push(...(await toolMaterials(last.session, windows)));
	// 没有 Yi 的话、也没有工具结果：原样发出或直接不发，学不到东西，不花一次模型调用
	if (!m.some((x) => x.role === "yi" || x.role === "tool")) return;
	return {
		source: `draft:${job.replyTo}`,
		query: `${first.text}\n${m
			.filter((x) => x.role === "yi")
			.map((x) => x.text)
			.join("\n")}`,
		person: first.chatMode === "meego" ? undefined : { id: first.senderId, name: first.senderName },
		chat: { id: first.chatId, name: first.chatName || where },
		materials: number(m),
	};
}

async function qaBatch(job: Extract<MemoryJob, { type: "qa" }>): Promise<Batch | undefined> {
	const byYi = job.askerId === OWNER_OPEN_ID;
	const tools = await toolMaterials(job.session, [[job.start, job.end]]);
	if (!byYi && !tools.length) return;
	const m: Omit<Material, "n">[] = [
		{
			role: byYi ? "yi" : "other",
			label: byYi ? "Yi 的提问" : `${job.askerName} 的提问`,
			text: job.question,
			ref: job.messageId,
			at: job.start,
		},
		...tools,
		{ role: "answer", label: "助理的回答", text: clip(job.answer, 2000), ref: `answer:${job.messageId}`, at: job.end },
	];
	return {
		source: `qa:${job.messageId}`,
		query: job.question,
		person: byYi ? undefined : { id: job.askerId, name: job.askerName },
		chat: { id: job.chatId, name: job.chatId },
		materials: number(m),
	};
}

/** 超出窗口时 Yi 的话一条不丢，从最旧的工具结果删起，再截背景 */
function number(items: Omit<Material, "n">[]): Material[] {
	const size = () => items.reduce((s, x) => s + x.text.length + x.label.length, 0);
	while (size() > WINDOW_CHARS) {
		const i = items.findIndex((x) => x.role === "tool");
		if (i < 0) break;
		items.splice(i, 1);
	}
	for (const x of items) if (size() > WINDOW_CHARS && x.role !== "yi") x.text = clip(x.text, 300);
	return items.map((x, i) => ({ ...x, n: i + 1 }));
}

// ---------- 写出去 ----------

const ROLE_LABEL: Record<Material["role"], string> = {
	yi: "Yi",
	other: "对方",
	context: "背景",
	draft: "草稿",
	outcome: "结果",
	tool: "工具",
	answer: "回答",
};

const iso = (t: number) => new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ");

export function renderBatch(b: Batch): string {
	const head = [b.person ? `对方：${b.person.name}` : "", b.chat ? `会话：${b.chat.name}` : ""].filter(Boolean).join("；");
	const body = b.materials.map((x) => `[${x.n}] ${ROLE_LABEL[x.role]} · ${x.label}（${iso(x.at)}）\n${x.text}`).join("\n\n");
	return redact(`${head}\n\n${body}`);
}

export const batchTags = (b: Pick<Batch, "person" | "chat">) => [
	"personal",
	...(b.person ? [`person:${b.person.id}`] : []),
	...(b.chat ? [`chat:${b.chat.id}`] : []),
];

/** 送进 OpenViking 的：Yi 的每句话一条 user 消息，前面一条 assistant 消息交代背景（不带对方原话） */
export function vikingMessages(b: Batch) {
	const yi = b.materials.filter((x) => x.role === "yi");
	if (!yi.length) return [];
	const where = [b.person ? `回复 ${b.person.name}` : "", b.chat ? `在「${b.chat.name}」` : ""].filter(Boolean).join("，");
	return [
		{ role: "assistant" as const, content: `〔cabinet 飞书助理〕下面是 Yi ${where}时对助理草稿的修改或自己写的回复。`, at: yi[0].at },
		...yi.map((x) => ({ role: "user" as const, content: redact(`${x.label}：${x.text}`), at: x.at })),
	];
}

export async function store(b: Batch) {
	const at = Math.max(...b.materials.map((x) => x.at));
	await retain([
		{
			content: renderBatch(b),
			context: b.source.startsWith("draft:")
				? "cabinet 代回复：一条消息从起草、Yi 改稿到处理完的全过程"
				: "cabinet 问答：一次提问和查证过程",
			documentId: b.source,
			at,
			tags: batchTags(b),
			metadata: { source: b.source },
		},
	]);
	const messages = vikingMessages(b);
	if (messages.length) await commit(b.source, messages);
	log(`记忆沉淀 ${b.source}：Hindsight 已收${messages.length ? "，Yi 的话已送 OpenViking" : ""}`);
}

async function processJob(job: MemoryJob) {
	const batch = job.type === "draft" ? await draftBatch(job) : await qaBatch(job);
	if (batch) await store(batch);
}
