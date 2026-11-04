// 轮询主循环：每轮把所有启用了 poll 的渠道拉一遍（server/channels/），推进 poll_since。
// 没授权时不推进，授权后从停下的地方继续；停机太久不补，最多回看 30 分钟。
import { pollChannels } from "./channels/index.ts";
import { POLL_INTERVAL } from "./config.ts";
import { getKv, setKv } from "./db/index.ts";
import { pruneHandled } from "./handled.ts";
import { UserAuthError } from "./lark/bot.ts";
import { log, now } from "./util.ts";

export { markHandled } from "./handled.ts";

let stopped = false;
let wake: (() => void) | undefined;

export async function pollForever() {
	// 首次启动从现在开始；停机太久不补：最多回看 30 分钟，避免一次涌出大量草稿
	let since = Math.max(getKv("poll_since", now()), now() - 1800);
	log(`草稿轮询启动，回看到 ${new Date(since * 1000).toLocaleString("sv-SE")}`);
	let authWarned = false;
	// oxlint-disable-next-line no-unmodified-loop-condition -- stopped 由 stopPolling 在别处修改
	while (!stopped) {
		const started = now();
		try {
			await pollChannels(since);
			since = started;
			setKv("poll_since", since);
			authWarned = false;
		} catch (e) {
			// 没授权时不推进 since，授权后从停下的地方继续
			if (e instanceof UserAuthError) {
				if (!authWarned) log("轮询暂停：", e.message);
				authWarned = true;
			} else log("轮询失败", e);
		}
		pruneHandled();
		await new Promise<void>((r) => {
			wake = r;
			setTimeout(r, POLL_INTERVAL * 1000);
		});
	}
}

export function stopPolling() {
	stopped = true;
	wake?.();
}

export const lastPoll = () => getKv<number | null>("poll_since", null);
