// 轮询主循环：每轮把所有启用了 poll 的渠道拉一遍（server/channels/），推进 poll_since。
// 没授权时不推进，授权后从停下的地方继续；停机太久不补，最多回看 30 分钟。
import { pollChannels } from "./channels/index.ts";
import { POLL_FAST } from "./config.ts";
import { getKv, setKv } from "./db/index.ts";
import { pruneHandled } from "./handled.ts";
import { UserAuthError } from "./lark/bot.ts";
import { log, now } from "./util.ts";

export { markHandled } from "./handled.ts";

let stopped = false;
let wake: (() => void) | undefined;
// 正在拉的时候有人要「立即拉取」：这一轮拉完不睡，马上再拉一轮
let again = false;
// 「立即拉取」：下一轮所有渠道、所有会话都拉，不按分层跳过
let full = false;

export async function pollForever() {
	// 首次启动从现在开始；停机太久不补：最多回看 30 分钟，避免一次涌出大量草稿
	let since = Math.max(getKv("poll_since", now()), now() - 1800);
	log(`草稿轮询启动，回看到 ${new Date(since * 1000).toLocaleString("sv-SE")}`);
	let authWarned = false;
	// 连续失败的次数：飞书报错、限流、断网时拉长间隔，不照样每 POLL_FAST 秒打一次
	let failures = 0;
	// oxlint-disable-next-line no-unmodified-loop-condition -- stopped 由 stopPolling 在别处修改
	while (!stopped) {
		const force = full;
		full = false;
		try {
			// 睡眠唤醒后 since 还是睡前的：和启动时一样最多回看 30 分钟
			since = await pollChannels(Math.max(since, now() - 1800), force);
			setKv("poll_since", since);
			authWarned = false;
			failures = 0;
		} catch (e) {
			failures++;
			// 没授权时不推进 since，授权后从停下的地方继续
			if (e instanceof UserAuthError) {
				if (!authWarned) log("轮询暂停：", e.message);
				authWarned = true;
			} else log("轮询失败", e);
		}
		pruneHandled();
		if (!again)
			await new Promise<void>((r) => {
				const done = () => {
					clearTimeout(timer);
					wake = undefined;
					r();
				};
				const timer = setTimeout(done, backoff(failures) * 1000);
				wake = done;
			});
		again = false;
	}
}

/** 下一轮隔多久：正常 POLL_FAST 秒；连续失败每次翻倍，最多 60 秒 */
export const backoff = (failures: number, base = POLL_FAST) =>
	failures ? Math.min(60, Math.max(base, 1) * 2 ** Math.min(failures, 6)) : base;

/** 看板上点「立即拉取 / 立即起草」：不等这一轮的间隔，马上拉一次新消息 */
export function pollNow() {
	full = true;
	if (wake) wake();
	else again = true;
}

export function stopPolling() {
	stopped = true;
	wake?.();
}

export const lastPoll = () => getKv<number | null>("poll_since", null);
