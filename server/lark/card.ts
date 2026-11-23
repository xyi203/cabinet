// 交互卡片（raw_card_content）渲染成 Markdown，格式与 lark-cli 一致：<card title="…">正文</card>。
// 卡片里 @ 的是发卡应用自己的 open_id，要经 json_attachment.at_users 的 mention_key 换成本应用的 open_id。
import type { Mention } from "./types.ts";

export function renderCard(raw: any, mentions: Mention[]): string {
	let card: any;
	try {
		card = typeof raw.json_card === "string" ? JSON.parse(raw.json_card) : raw.json_card;
	} catch {
		return "[卡片]";
	}
	if (!card) return "[卡片]";
	const atUsers: Record<string, { content?: string; mention_key?: string }> = raw.json_attachment?.at_users ?? {};
	const byKey = new Map(mentions.map((m) => [m.key, m]));

	const render = (n: any): string => {
		if (!n || typeof n !== "object") return "";
		if (Array.isArray(n)) return n.map(render).join("");
		const p = n.property ?? {};
		switch (n.tag) {
			case "plain_text": {
				const text = p.content ?? "";
				return p.textStyle?.attributes?.includes("bold") && text.trim() ? `**${text}**` : text;
			}
			case "br":
				return "\n";
			case "link":
				return `[${p.content ?? ""}](${p.url?.url ?? ""})`;
			case "at": {
				const u = atUsers[p.userID] ?? {};
				const m = u.mention_key ? byKey.get(u.mention_key) : undefined;
				const name = m?.name ?? u.content ?? p.userID;
				return m?.id ? `@${name}(${m.id})` : `@${name}`;
			}
			case "markdown":
			case "text":
				return render(p.elements ?? []);
			case "button": {
				const url = p.actions?.find((a: any) => a.type === "open_url")?.action?.url;
				const text = render(p.text);
				return url ? `[${text}](${url})` : `[${text}]`;
			}
			case "action":
				return (p.actions ?? []).map(render).filter(Boolean).join(" ");
			case "div":
				return [render(p.text), ...(p.fields ?? []).map((f: any) => render(f.text ?? f))].filter(Boolean).join("\n");
			case "hr":
				return "---";
			case "img":
				return "[图片]";
			case "list":
				// 无序 / 有序列表：items 各自一行，按 level 缩进
				return (p.items ?? [])
					.map((it: any, i: number) => `${"  ".repeat(it.level ?? 0)}${it.type === "ol" ? `${i + 1}.` : "-"} ${render(it.elements ?? [])}`)
					.join("\n");
			case "collapsible_panel": {
				// 折叠面板（告警卡的「证据」这类）：标题和里面的内容都要，折着的才是细节
				return [render(p.header?.title), blocks(p.elements ?? [])].filter(Boolean).join("\n");
			}
			default:
				return blocks(p.elements ?? p.columns ?? []);
		}
	};
	const blocks = (list: any[]): string =>
		list
			.map(render)
			.filter((s) => s !== "")
			.join("\n");

	const head = card.header?.property ?? {};
	const title = head.title?.property?.content ?? "";
	const subtitle = head.subtitle?.property?.content ?? "";
	// 新版卡片（schema 2.0，告警卡这类）正文在 body.property.elements；旧版在 body.elements
	const body = card.body?.property?.elements ?? card.body?.elements ?? [];
	return `<card title="${title}"${subtitle ? ` subtitle="${subtitle}"` : ""}>\n${blocks(body)}\n</card>`;
}

/** 卡片附带的 @ 用户：名字 -> 飞书 user_id。飞书项目评论里 @人要用它（meegle 输出的 lark_user_id 丢了精度） */
export function cardUserIds(raw: any): Record<string, string> {
	const atUsers: Record<string, { content?: string; user_id?: string }> = raw?.json_attachment?.at_users ?? {};
	return Object.fromEntries(
		Object.values(atUsers)
			.filter((u) => u.content && u.user_id)
			.map((u) => [u.content!, String(u.user_id)]),
	);
}
