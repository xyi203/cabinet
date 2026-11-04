// 定期清理：起草时下载的截图只在起草那一会儿有用，过期就删
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { IMAGE_RETAIN_DAYS, PATHS } from "./config.ts";
import { log, now } from "./util.ts";

/** 删掉目录里修改时间早于 days 天前的文件，返回删除个数；days <= 0 不删 */
export function pruneOldFiles(dir: string, days: number): number {
	if (days <= 0 || !existsSync(dir)) return 0;
	const cutoff = (now() - days * 86400) * 1000;
	let n = 0;
	for (const f of readdirSync(dir, { withFileTypes: true })) {
		if (!f.isFile()) continue;
		const file = path.join(dir, f.name);
		if (statSync(file).mtimeMs < cutoff) {
			rmSync(file);
			n++;
		}
	}
	return n;
}

/** 启动时清一次，之后每天一次 */
export function scheduleCleanup() {
	const run = () => {
		try {
			const n = pruneOldFiles(PATHS.images, IMAGE_RETAIN_DAYS);
			if (n) log(`清理过期截图 ${n} 张`);
		} catch (e) {
			log("清理截图失败", e);
		}
	};
	run();
	setInterval(run, 86_400_000).unref();
}
