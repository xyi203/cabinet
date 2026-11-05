import assert from "node:assert/strict";
import { test } from "node:test";
const { openDb, useDb } = await import("../server/db/index.ts");
useDb(openDb(":memory:"));
const { branchFrom, nameBranch } = await import("../server/dev.ts");

test("模型回答里取分支名：去引号和句末标点，不合规的不认", () => {
	assert.equal(branchFrom("fix/embeds"), "fix/embeds");
	assert.equal(branchFrom("`feature/CommentFilter`。"), "feature/commentfilter");
	assert.equal(branchFrom("feature/comment-filter"), undefined);
	assert.equal(branchFrom("chore/x"), undefined);
	assert.equal(branchFrom(""), undefined);
});

test("起的名字重了就在单词后面加数字；模型给的不合规或调用失败时退回 feature/task<时间>", async () => {
	const used = new Set(["fix/embeds", "fix/embeds2"]);
	const taken = async (b: string) => used.has(b);
	assert.equal(await nameBranch("x", taken, async () => "fix/embeds"), "fix/embeds3");
	assert.equal(await nameBranch("x", taken, async () => "feature/commentfilter"), "feature/commentfilter");
	assert.match(await nameBranch("x", taken, async () => "改评论"), /^feature\/task[a-z0-9]+$/);
	assert.match(
		await nameBranch("x", taken, async () => {
			throw new Error("模型不可用");
		}),
		/^feature\/task[a-z0-9]+$/,
	);
});
