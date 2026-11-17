// 搜 @Yi：没在盯的话题里的回复靠搜索补上；处理过的、私聊、跳过的会话不取；起点按成败推进
import assert from "node:assert/strict";
import { test } from "node:test";
const { openDb, useDb, getKv, setKv } = await import("../server/db/index.ts");
useDb(openDb(":memory:"));
const { pollMentions } = await import("../server/mentions.ts");
const { markHandled } = await import("../server/handled.ts");
const T = 1_800_000_000;

const msg = (id: string, at: number, extra: Record<string, unknown> = {}) =>
	({
		message_id: id,
		content: id,
		create_time: at * 1000,
		message_position: 1,
		mentions: [],
		sender: { id: "ou_a", name: "A", sender_type: "user" },
		...extra,
	}) as any;

function fakeApi(hits: any[], opts: { failChat?: string } = {}) {
	const calls = { search: [] as number[], chats: [] as string[], messages: [] as string[] };
	return {
		calls,
		api: {
			searchAtMe: async (start: number) => (calls.search.push(start), hits),
			getChat: async (id: string) => {
				calls.chats.push(id);
				if (id === opts.failChat) throw new Error("boom");
				return { chat_id: id, chat_mode: "group", name: `群${id}` };
			},
			getMessage: async (id: string) => (calls.messages.push(id), msg(id, 1000, { root_id: "om_root", thread_id: "omt_1" })),
		} as any,
	};
}

test("搜到的 @Yi 按会话交给 routeChat；处理过的、私聊、不取正文", async () => {
	markHandled(["om_old"]);
	const { api, calls } = fakeApi([
		{ messageId: "om_new", chatId: "oc_a", threadId: "omt_1", p2p: false },
		{ messageId: "om_old", chatId: "oc_a", p2p: false },
		{ messageId: "om_dm", chatId: "oc_p", p2p: true },
	]);
	const routed: Array<[string, string[]]> = [];
	await pollMentions(T, (chat, msgs) => routed.push([chat.chat_id, msgs.map((m) => m.message_id)]), true, api);
	assert.deepEqual(routed, [["oc_a", ["om_new"]]]);
	assert.deepEqual(calls.messages, ["om_new"]);
	// 第一次最多往回 6 小时，再多看 10 分钟
	assert.equal(calls.search[0], T - 6 * 3600 - 600);
	assert.equal(getKv("mentions:since", 0), T);
});

test("没到间隔不搜；某个会话处理失败时起点不往前推", async () => {
	const { api, calls } = fakeApi([{ messageId: "om_x", chatId: "oc_bad", p2p: false }], { failChat: "oc_bad" });
	await pollMentions(T + 5, () => {}, false, api);
	assert.equal(calls.search.length, 0, "距上次不到 POLL_INTERVAL");
	await pollMentions(T + 100, () => {}, true, api);
	assert.equal(calls.search[0], T - 600, "从上次成功的地方接着搜");
	assert.equal(getKv("mentions:since", 0), T, "失败不推进");
	setKv("mentions:since", 0);
});

test("搜索报错（没开通权限）不抛出、不推进起点", async () => {
	setKv("mentions:since", T + 200);
	const api = {
		searchAtMe: async () => {
			throw new Error("搜索 @Yi 的消息 失败 code=99991679: permission denied");
		},
	} as any;
	await pollMentions(T + 300, () => assert.fail("不该路由"), true, api);
	assert.equal(getKv("mentions:since", 0), T + 200);
});
