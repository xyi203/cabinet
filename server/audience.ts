// 受众：按人或群设定披露等级和处理说明（比如「跨团队，只给结论」「PM，先说排期」），起草回复时作为「关于对方」带进提示。
// 只影响起草的口径；等级之外的细节写在处理说明里。参考 ace-cli 的受众页。
import { desc } from "drizzle-orm";
import { changed } from "./bus.ts";
import { db, deleteKv, getKv, listKv, schema, setKv } from "./db/index.ts";
import { DraftError } from "./drafts/store.ts";
import { now } from "./util.ts";

export type Level = "trusted" | "normal" | "careful";

export const LEVELS: Record<Level, { name: string; prompt: string }> = {
	trusted: { name: "可信", prompt: "可以直接给内部链接、数据和实现细节。" },
	normal: { name: "一般", prompt: "" },
	careful: {
		name: "谨慎",
		prompt: "只给结论，不贴内部数据、日志、链接和店铺信息；涉及承诺、排期、上线时间的，在【备注】里请 Yi 先确认，正文不替他答应。",
	},
};

export interface Audience {
	/** 人：飞书 open_id；群：chat_id */
	id: string;
	kind: "person" | "chat";
	name: string;
	level: Level;
	/** 处理说明：起草时原样带上 */
	note: string;
	updated: number;
}

const KEY = (id: string) => `audience:${id}`;

export const listAudience = () =>
	listKv<Audience>("audience:")
		.map((x) => x.value)
		.toSorted((a, b) => b.updated - a.updated);

export function saveAudience(input: Partial<Audience> & { id: string }): Audience {
	const id = input.id.trim();
	if (!/^(ou|oc)_[\w-]+$/.test(id)) throw new DraftError("只支持飞书用户（ou_）或群（oc_）");
	const old = getKv<Audience | null>(KEY(id), null);
	const level = (input.level ?? old?.level ?? "normal") as Level;
	if (!LEVELS[level]) throw new DraftError(`没有等级 ${level}`);
	const row: Audience = {
		id,
		kind: id.startsWith("oc_") ? "chat" : "person",
		name: (input.name ?? old?.name ?? "").trim() || id,
		level,
		note: (input.note ?? old?.note ?? "").trim().slice(0, 1000),
		updated: now(),
	};
	setKv(KEY(id), row);
	changed();
	return row;
}

export function removeAudience(id: string) {
	deleteKv(KEY(id));
	changed();
}

/** 起草时带上的「关于对方」：发消息的人和所在群各一条；都没设定（或都是一般且没写说明）返回空 */
export function audienceBlock(senderId?: string, chatId?: string): string {
	const lines: string[] = [];
	for (const id of [senderId, chatId]) {
		if (!id) continue;
		const a = getKv<Audience | null>(KEY(id), null);
		if (!a) continue;
		const text = [LEVELS[a.level]?.prompt, a.note].filter(Boolean).join(" ");
		if (text) lines.push(`- ${a.kind === "chat" ? `群「${a.name}」` : a.name}（${LEVELS[a.level]?.name ?? a.level}）：${text}`);
	}
	return lines.length ? `关于对方（Yi 设定的口径，照着写）：\n${lines.join("\n")}` : "";
}

/** 还没登记的候选：最近给 Yi 发过消息的人、@过 Yi 的群，按次数排 */
export function audienceCandidates(limit = 30) {
	const known = new Set(listAudience().map((a) => a.id));
	const drafts = db()
		.select({
			senderId: schema.drafts.senderId,
			senderName: schema.drafts.senderName,
			chatId: schema.drafts.chatId,
			chatName: schema.drafts.chatName,
			chatMode: schema.drafts.chatMode,
		})
		.from(schema.drafts)
		.orderBy(desc(schema.drafts.created))
		.limit(500)
		.all();
	const count = new Map<string, { id: string; kind: "person" | "chat"; name: string; n: number }>();
	const bump = (id: string, kind: "person" | "chat", name: string) => {
		if (!id || known.has(id) || !/^(ou|oc)_/.test(id)) return;
		const c = count.get(id) ?? { id, kind, name, n: 0 };
		c.n++;
		count.set(id, c);
	};
	for (const d of drafts) {
		bump(d.senderId, "person", d.senderName);
		if (d.chatMode === "group") bump(d.chatId, "chat", d.chatName);
	}
	return [...count.values()].toSorted((a, b) => b.n - a.n).slice(0, limit);
}
