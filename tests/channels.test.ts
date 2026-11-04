import assert from "node:assert/strict";
import { test } from "node:test";
const { openDb, useDb } = await import("../server/db/index.ts");
useDb(openDb(":memory:"));
const { channelOfDraft, channels } = await import("../server/channels/index.ts");

test("渠道注册：名字不重复，草稿按来源发回对应渠道", () => {
	const names = channels().map((c) => c.name);
	assert.deepEqual(names.toSorted(), ["bot", "lark", "meego"]);
	assert.equal(channelOfDraft({ chatMode: "p2p" }).name, "lark");
	assert.equal(channelOfDraft({ chatMode: "group" }).name, "lark");
	assert.equal(channelOfDraft({ chatMode: "meego" }).name, "meego");
	// 能发出的渠道都有 send，只推送的机器人渠道没有 poll
	for (const c of channels()) assert.ok(c.poll || c.listen, c.name);
	assert.equal(channels().find((c) => c.name === "bot")!.send, undefined);
});
