// 机器人渠道：长连接收 @机器人 / 私聊机器人的消息（问答、草稿指令、记住）和卡片按钮回调
import { onCardAction } from "../cards.ts";
import { startEvents } from "../lark/bot.ts";
import { onBotEvent } from "../qa.ts";
import type { Channel } from "./index.ts";

export const botChannel: Channel = {
	name: "bot",
	desc: "@机器人、私聊机器人、卡片按钮（长连接）",
	enabled: () => true,
	listen: () => startEvents(onBotEvent, onCardAction),
};
