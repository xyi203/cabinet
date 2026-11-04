// 起草失败的提醒：对方的消息没人回，私聊 Yi 一张卡片（重试 / 忽略）。同一条失败重试或忽略之后，卡片原地变灰
import { OWNER_OPEN_ID } from "../config.ts";
import { getKv, setKv } from "../db/index.ts";
import { patchCard, sendCardToUserAsBot } from "../lark/bot.ts";
import { log } from "../util.ts";
import { type FailureInfo, failureCard } from "./card.ts";

const key = (taskId: string) => `failcard:${taskId}`;

export async function notifyFailure(f: FailureInfo) {
	try {
		const id = await sendCardToUserAsBot(OWNER_OPEN_ID, failureCard(f));
		setKv(key(f.taskId), { id, info: f });
	} catch (e) {
		log("起草失败提醒发送失败", f.taskId, e);
	}
}

/** 看板或卡片上重试、忽略之后：把提醒卡片改成结果，按钮去掉 */
export function closeFailure(taskId: string, status: "retrying" | "dismissed") {
	const sent = getKv<{ id: string; info: FailureInfo } | null>(key(taskId), null);
	if (!sent) return;
	void patchCard(sent.id, failureCard(sent.info, status)).catch((e) => log("更新起草失败提醒失败", taskId, e));
}
