import assert from "node:assert/strict";
import { test } from "node:test";
const { renderCard } = await import("../server/lark/card.ts");

const text = (content: string, bold = false) => ({
	tag: "plain_text",
	property: { content, ...(bold ? { textStyle: { attributes: ["bold"] } } : {}) },
});
const md = (...elements: object[]) => ({ tag: "markdown", property: { elements } });

test("新版卡片（告警卡）：正文、副标题、列表、折叠面板都读出来", () => {
	const card = {
		schema: "2.0",
		header: { tag: "card_header", property: { title: text("P1 需跟进"), subtitle: text("已恢复") } },
		body: {
			tag: "body",
			property: {
				elements: [
					md(text("影响", true), text("：1 位商家")),
					{
						tag: "list",
						property: {
							items: [
								{ type: "ul", level: 0, elements: [text("排除 A")] },
								{ type: "ol", level: 1, elements: [text("细节")] },
							],
						},
					},
					{
						tag: "collapsible_panel",
						property: { header: { title: md(text("证据", true), text("（1 条）")) }, elements: [md(text("日志 1 条 500"))] },
					},
				],
			},
		},
	};
	const out = renderCard({ json_card: JSON.stringify(card) }, []);
	assert.match(out, /^<card title="P1 需跟进" subtitle="已恢复">/);
	assert.match(out, /\*\*影响\*\*：1 位商家/);
	assert.match(out, /- 排除 A\n {2}2\. 细节/);
	assert.match(out, /\*\*证据\*\*（1 条）\n日志 1 条 500/);
});

test("旧版卡片：正文在 body.elements", () => {
	const out = renderCard({ json_card: { header: { property: { title: text("草稿") } }, body: { elements: [md(text("内容"))] } } }, []);
	assert.equal(out, '<card title="草稿">\n内容\n</card>');
});
