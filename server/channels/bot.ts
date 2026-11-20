// 机器人渠道：长连接收 @机器人 / 私聊机器人的消息（问答、草稿指令、记住）、卡片按钮回调，
// 以及云文档评论通知（一个应用只有一条长连接，事件都从这里进，转给 channels/doc.ts 那一路）
import { onCardAction } from "../cards.ts";
import { startEvents } from "../lark/bot.ts";
import { routeBot, routeDoc } from "../router/index.ts";
import type { Channel } from "./index.ts";

export const botChannel: Channel = {
	name: "bot",
	desc: "@机器人、私聊机器人、卡片按钮（长连接）",
	enabled: () => true,
	listen: () => startEvents(routeBot, onCardAction, routeDoc),
};
