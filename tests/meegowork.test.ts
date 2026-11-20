import assert from "node:assert/strict";
import { test } from "node:test";
const { formatWorkItem } = await import("../server/meego.ts");

const IMG = "https://project.feishu.cn/goapi/v5/platform/file/stream/download/AbC_123-x==";

test("工作项整理成正文：标题、状态、角色、可读字段和描述；内部 id 和空字段不带，截图换成编号", () => {
	const { text, imageUrls } = formatWorkItem({
		work_item_attribute: {
			work_item_name: "KA vikingstu：客户优惠券折扣抵扣失败原因确认",
			work_item_type: { name: "缺陷" },
			template: { name: "线上缺陷" },
			work_item_status: { name: "待处理" },
			create_by: { name: "方周" },
			role_members: [{ name: "技术客服", members: [{ name: "刘家乐", key: "1" }] }, { name: "修复者" }],
		},
		work_item_fields: [
			{ key: "business", name: "业务线", value: "65900ea6d3ed562a03f88873" },
			{ key: "priority", name: "优先级", value: { label: "P2", value: "2" } },
			{ key: "current_status_operator", name: "当前负责人", value: [{ name: "徐佳", key: "2" }] },
			{ key: "archiving_date", name: "完成日期", value: { iso_time: "2026-11-20T17:20:28+08:00", timestamp: 1 } },
			{
				key: "description",
				name: "缺陷描述",
				value: `店铺ID：<span style="font-size: 14px">756371，无授权</span>\n\n\n\nOrder no.: 756371-MS00977216\n\n![](${IMG})<!-- image:{"width":820} -->`,
			},
		],
	});
	assert.deepEqual(imageUrls, [IMG]);
	assert.match(text, /^工作项「KA vikingstu：客户优惠券折扣抵扣失败原因确认」（缺陷 · 线上缺陷），状态：待处理/);
	assert.match(text, /创建人：方周；技术客服：刘家乐/);
	assert.doesNotMatch(text, /修复者|业务线|65900ea6/);
	assert.match(text, /优先级：P2\n当前负责人：徐佳\n完成日期：2026-11-20 17:20/);
	assert.match(text, /描述：\n店铺ID：756371，无授权\n\nOrder no\.: 756371-MS00977216\n\n\[截图 1\]$/);
});

test("返回为空或缺字段时不报错", () => {
	assert.deepEqual(formatWorkItem({}), { text: "工作项「」（），状态：?", imageUrls: [] });
});
