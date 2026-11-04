// 渠道（Channel）：trigger 从哪来、结果往哪去。一个渠道可以拉取（poll）、推送（listen）、以 Yi 的身份发出（send），都是可选的：
// 只读的来源（RSS 这类）没有 send，只能推送的（长连接、webhook）没有 poll。新渠道写一个实现、加进 channels() 就行。
// 渠道把收到的东西记成 trigger（pipeline.ts receive）交给起草、问答、告警；以 Yi 身份发出仍然只经 applyDraftAction("send")。
import type { Draft } from "../db/schema.ts";
import { DraftError } from "../drafts/store.ts";
import { UserAuthError } from "../lark/bot.ts";
import { log } from "../util.ts";
import { botChannel } from "./bot.ts";
import { larkChannel } from "./lark.ts";
import { meegoChannel } from "./meego.ts";

export interface Channel {
	/** 渠道名，也是 trigger id 的前缀（pipeline.ts 的 Channel） */
	name: string;
	desc: string;
	enabled(): boolean;
	/** 拉取：轮询主循环每轮调一次，since 是上一轮开始的时间（秒） */
	poll?(since: number): Promise<void>;
	/** 推送：开始监听，返回停止函数 */
	listen?(): () => void;
	/** 以 Yi 的身份发出确认过的草稿；没有就是只读渠道 */
	send?(d: Draft): Promise<void>;
}

/** 函数而不是常量：渠道模块之间有循环引用，用到时再取 */
export const channels = (): Channel[] => [larkChannel, meegoChannel, botChannel];

/** 草稿发回它来的那个渠道 */
export function channelOfDraft(d: Pick<Draft, "chatMode">): Channel {
	const name = d.chatMode === "meego" ? "meego" : "lark";
	const ch = channels().find((c) => c.name === name);
	if (!ch?.send) throw new DraftError(`渠道 ${name} 不能发消息`);
	return ch;
}

/**
 * 轮询一轮：一个渠道失败不耽误别的渠道；但只要有失败就把错误抛给主循环，不推进 since，
 * 下一轮重新拉这段时间（已经处理过的靠 handled 去重）。用户授权失败优先抛：主循环据此暂停。
 */
export async function pollChannels(since: number) {
	const errors: unknown[] = [];
	for (const ch of channels()) {
		if (!ch.poll || !ch.enabled()) continue;
		try {
			await ch.poll(since);
		} catch (e) {
			if (!(e instanceof UserAuthError)) log(`渠道 ${ch.name} 轮询失败`, e);
			errors.push(e);
		}
	}
	if (errors.length) throw errors.find((e) => e instanceof UserAuthError) ?? errors[0];
}

/** 启动所有推送渠道，返回统一的停止函数 */
export function startListeners(): () => void {
	const stops = channels()
		.filter((c) => c.listen && c.enabled())
		.map((c) => c.listen!());
	return () => {
		for (const stop of stops) stop();
	};
}
