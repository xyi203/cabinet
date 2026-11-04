// 从旧的 lark-pi-bot 导入运行数据：草稿、处理流水、轮询进度、pi 会话、长期记忆、表情包。
// 用法：pnpm import-legacy [旧目录，默认 ~/lark-pi-bot]。可重复执行：已有的草稿和会话跳过，流水只在库为空时导入。
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { PATHS } from "../server/config.ts";
import { db, schema } from "../server/db/index.ts";

const legacy = path.resolve(process.argv[2] ?? path.join(homedir(), "lark-pi-bot"));
const readJson = (p: string, fallback: any) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : fallback);
const camel = (o: any) =>
	o ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k.replace(/_(\w)/g, (_, c) => c.toUpperCase()), v])) : null;
const toMessage = (m: any) => ({
	message_id: m.message_id,
	content: m.content ?? "",
	create_time: 0,
	message_position: 0,
	thread_id: m.thread_id ?? undefined,
	mentions: [],
	sender: { id: m.sender?.id ?? "", name: m.sender?.name ?? "", sender_type: "user" },
	meego: m.meego ? camel(m.meego) : undefined,
});
const toBotEvent = (ev: any) => ({
	messageId: ev.message_id,
	chatId: ev.chat_id,
	chatType: ev.chat_type,
	senderType: ev.sender_type,
	senderId: ev.sender_id,
	rootId: ev.root_id || undefined,
	parentId: ev.reply_to || ev.parent_id || undefined,
	threadId: ev.thread_id || undefined,
	content: ev.content ?? "",
	mentions: (ev.mentions ?? []).map((m: any) => ({ key: m.key ?? "", id: m.id ?? "", name: m.name ?? "" })),
});

const drafts = readJson(path.join(legacy, "state/drafts.json"), {});
let n = 0;
for (const [id, d] of Object.entries<any>(drafts)) {
	n += db()
		.insert(schema.drafts)
		.values({
			id,
			chatId: d.chat_id,
			chatMode: d.chat_mode,
			chatName: d.chat_name ?? "",
			replyTo: d.reply_to,
			threadId: d.thread_id ?? null,
			senderId: d.sender_id ?? "",
			senderName: d.sender_name ?? "",
			text: d.text ?? "",
			meego: camel(d.meego) as any,
			agent: d.agent ?? null,
			session: d.session ?? null,
			route: d.route ?? null,
			kind: d.kind ?? "text",
			draft: d.draft ?? "",
			note: d.note ?? "",
			report: d.report ?? "",
			// 导入时还在处理中的，退回待确认
			status: d.status === "sending" || d.status === "revising" ? "pending" : d.status,
			created: d.created,
		})
		.onConflictDoNothing()
		.run().changes;
}
console.log(`草稿 ${n}/${Object.keys(drafts).length}`);

const recordsFile = path.join(legacy, "logs/records.ndjson");
if (db().select().from(schema.records).limit(1).all().length) console.log("流水：库里已有记录，跳过");
else if (existsSync(recordsFile)) {
	const rows = readFileSync(recordsFile, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));
	db().transaction((tx) => {
		for (const r of rows) {
			const kind = r.kind === "draft" ? "draft" : "qa";
			const retry = r.retry ? { chat: r.retry.chat, msgs: r.retry.msgs.map(toMessage) } : r.ev ? toBotEvent(r.ev) : null;
			tx.insert(schema.records)
				.values({
					ts: Date.parse(r.ts) / 1000,
					kind,
					status: r.status,
					chatId: r.chat_id ?? null,
					source: kind === "draft" ? (r.source ?? null) : (r.message_id ?? null),
					dm: r.dm ?? null,
					session: r.session ?? null,
					agent: r.agent ?? null,
					label: r.label ?? null,
					seconds: r.seconds ?? null,
					usage: r.usage ?? null,
					question: r.question ?? r.text ?? null,
					answer: r.answer ?? null,
					error: r.error ?? null,
					reason: r.reason ?? null,
					retry,
				})
				.run();
		}
	});
	console.log(`流水 ${rows.length}`);
}

const poll = readJson(path.join(legacy, "state/poll.json"), {});
if (poll.since)
	db()
		.insert(schema.kv)
		.values({ key: "poll_since", value: poll.since })
		.onConflictDoUpdate({ target: schema.kv.key, set: { value: poll.since } })
		.run();
const at = Date.now() / 1000;
for (const messageId of poll.handled ?? []) db().insert(schema.handled).values({ messageId, at }).onConflictDoNothing().run();
console.log(
	`轮询进度 since=${poll.since ? new Date(poll.since * 1000).toLocaleString("sv-SE") : "-"}，已处理 ${(poll.handled ?? []).length}`,
);

function copyDir(from: string, to: string, filter: (f: string) => boolean) {
	if (!existsSync(from)) return 0;
	mkdirSync(to, { recursive: true });
	let c = 0;
	for (const f of readdirSync(from).filter(filter)) {
		if (existsSync(path.join(to, f))) continue;
		copyFileSync(path.join(from, f), path.join(to, f));
		c++;
	}
	return c;
}
console.log(`会话 ${copyDir(path.join(legacy, "sessions"), PATHS.sessions, (f) => f.endsWith(".jsonl"))}`);
console.log(`表情包 ${copyDir(path.join(legacy, "stickers"), PATHS.stickers, (f) => !f.startsWith(".") && f !== "README.md")}`);
const mem = path.join(legacy, "memory/MEMORY.md");
if (existsSync(mem) && !existsSync(PATHS.memory)) {
	mkdirSync(path.dirname(PATHS.memory), { recursive: true });
	copyFileSync(mem, PATHS.memory);
	console.log("记忆 已导入");
}
