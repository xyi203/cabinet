import assert from "node:assert/strict";
import { test } from "node:test";
process.env.OWNER_OPEN_ID = "ou_yi";
process.env.OWNER_NAME = "向懿";
process.env.BOT_OPEN_ID = "ou_cabinet";
process.env.ALERT_QUIET = "120";
process.env.ALERT_MAX_WAIT = "600";
process.env.ALERT_CHATS = "oc_alert";
const { openDb, useDb } = await import("../server/db/index.ts");
useDb(openDb(":memory:"));
const { addAlert, alertText, batching, isAlert, stopAlerts } = await import("../server/alerts.ts");
const { getKv } = await import("../server/db/index.ts");
const { now } = await import("../server/util.ts");

const group = { chat_id: "oc_alert", chat_mode: "group", name: "告警群" };
const msg = (id: string, over: Record<string, unknown> = {}) => ({
	message_id: id,
	content: "【P1】order-api 5xx 超过阈值 @向懿",
	create_time: Date.now(),
	message_position: 1,
	mentions: [{ key: "@_user_1", id: "ou_yi", name: "向懿" }],
	sender: { id: "cli_grafana", name: "Grafana", sender_type: "app" },
	...over,
});

test("机器人在群里 @Yi 的才是告警", () => {
	assert.equal(isAlert(group, msg("om_1") as any), true);
	// 卡片里的 @ 只渲染成文字时也认
	assert.equal(isAlert(group, msg("om_2", { mentions: [] }) as any), true);
	// 真人发的走起草，不算告警
	assert.equal(isAlert(group, msg("om_3", { sender: { id: "ou_a", name: "张三", sender_type: "user" } }) as any), false);
	// 没 @Yi 的不算；机器人私聊不算；cabinet 自己的机器人不算
	assert.equal(isAlert(group, msg("om_4", { mentions: [], content: "【P2】磁盘 80%" }) as any), false);
	assert.equal(isAlert({ chat_mode: "p2p" }, msg("om_5") as any), false);
	assert.equal(isAlert(group, msg("om_6", { sender: { id: "ou_cabinet", name: "", sender_type: "app" } }) as any), false);
});

test("只认 ALERT_CHATS 里的群；PagerDuty 的确认、解决卡片不算", () => {
	assert.equal(isAlert({ ...group, chat_id: "oc_other" }, msg("om_7") as any), false);
	const card = (tag: string) =>
		msg(`om_${tag}`, { content: `<card title="[${tag}]order-api 5xx > 25">\n◾ **指派**: @向懿(ou_yi)\n</card>` });
	assert.equal(isAlert(group, card("Trigger][Error][Medium") as any), true);
	assert.equal(isAlert(group, card("Ack") as any), false);
	assert.equal(isAlert(group, card("Res") as any), false);
});

test("按群攒一批：没有新告警 2 分钟收口，最多等 10 分钟", () => {
	const t0 = now();
	const first = addAlert(group, msg("om_a") as any);
	assert.ok(first >= t0 + 119 && first <= t0 + 121);
	// 同一条重读一遍不重复进批
	addAlert(group, msg("om_a") as any);
	addAlert(group, msg("om_b") as any);
	assert.ok(batching("om_a") && batching("om_b"));
	assert.equal(getKv<any>("pending:alert:oc_alert", null).msgs.length, 2);
	stopAlerts();
});

test("一批的正文：每条截断，总长有上限", () => {
	const long = msg("om_long", { content: "x".repeat(5000) });
	const text = alertText([long as any]);
	assert.ok(text.includes("（截断）"));
	assert.ok(text.length < 2000);
	const many = Array.from({ length: 40 }, (_, i) => msg(`om_${i}`, { content: "y".repeat(1400) }));
	const all = alertText(many as any);
	assert.ok(all.startsWith("（更早的告警省略）"));
	assert.ok(all.length <= 20_100);
});
