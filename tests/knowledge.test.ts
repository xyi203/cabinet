import assert from "node:assert/strict";
import { test } from "node:test";
const { openDb, useDb } = await import("../server/db/index.ts");
useDb(openDb(":memory:"));
const { audienceBlock, saveAudience, listAudience, removeAudience } = await import("../server/audience.ts");
const { describeSkill } = await import("../server/skills.ts");
const { savePrompt, promptPaths } = await import("../server/prompts.ts");
const { dayData, dayMarkdown, dayRange } = await import("../server/journal.ts");

test("受众：人和群各一条口径带进起草；一般等级又没写说明的不带；ID 不对拒绝", () => {
	assert.throws(() => saveAudience({ id: "张三" }), /ou_/);
	saveAudience({ id: "ou_a", name: "张三", level: "careful", note: "PM，先说排期" });
	saveAudience({ id: "oc_g", name: "结账群", level: "trusted" });
	saveAudience({ id: "ou_b", name: "李四" });
	const block = audienceBlock("ou_a", "oc_g");
	assert.match(block, /张三（谨慎）：只给结论[\s\S]*PM，先说排期/);
	assert.match(block, /群「结账群」（可信）：可以直接给内部链接/);
	assert.equal(audienceBlock("ou_b"), "");
	assert.equal(audienceBlock("ou_x"), "");
	// 只改等级时保留原来的名字和说明
	assert.equal(saveAudience({ id: "ou_a", level: "normal" }).note, "PM，先说排期");
	removeAudience("ou_b");
	assert.deepEqual(
		listAudience()
			.map((a) => a.id)
			.toSorted(),
		["oc_g", "ou_a"],
	);
});

test("skill 说明：读 frontmatter 的 description，多行块拼成一行", () => {
	const md = "---\nname: x\ndescription: >\n  第一行\n  第二行\nversion: 1\n---\n正文";
	assert.equal(describeSkill(md), "第一行 第二行");
	assert.equal(describeSkill("---\nname: x\ndescription: 一句话\n---"), "一句话");
});

test("提示词：只能改 config 下那几个文件，JSON 要能解析", () => {
	assert.ok(promptPaths().includes("config/system.md"));
	assert.throws(() => savePrompt("server/main.ts", "x"), /不能编辑/);
	assert.throws(() => savePrompt("../.env", "x"), /不能编辑/);
	assert.throws(() => savePrompt("config/agents.json", "{bad"), /JSON 格式不对/);
});

test("日报：没有数据的一天也能出汇总；日期格式不对报错", () => {
	assert.throws(() => dayRange("11-06"), /YYYY-MM-DD/);
	const md = dayMarkdown(dayData("2026-11-06"));
	assert.match(md, /^# 2026-11-06 工作日报/);
	assert.match(md, /进来 0 条消息，起草 0 份/);
});
