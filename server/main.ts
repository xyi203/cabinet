import { mkdirSync } from "node:fs";
import { resumePendingAlerts, stopAlerts } from "./alerts.ts";
import { startServer } from "./api.ts";
import { CHATS, DRAFT_ENABLED, PATHS, PI_MODEL, missingConfig } from "./config.ts";
import { closeHarness, harness, pruneRuns } from "./agent/driver.ts";
import { scheduleCleanup } from "./cleanup.ts";
import { db } from "./db/index.ts";
import { resumePendingDev } from "./dev.ts";
import { resumePendingDrafts } from "./drafts/make.ts";
import { startListeners } from "./channels/index.ts";
import { markHandled, pollForever, stopPolling } from "./poller.ts";
import { resumePendingQa } from "./qa.ts";
import { resumePendingMemory } from "./memory/extract.ts";
import { importLegacyMemory } from "./memory/remember.ts";
import { scheduleVectors } from "./memory/store.ts";
import { log, markStopping } from "./util.ts";
import { startSchedules, stopSchedules } from "./schedules.ts";
import { startWatchdog, stopWatchdog } from "./watchdog.ts";

const missing = missingConfig();
if (missing.length) {
	console.error(`.env 缺少 ${missing.join(", ")}，参考 .env.example`);
	process.exit(1);
}
for (const d of [PATHS.sessions, PATHS.stickers, PATHS.images]) mkdirSync(d, { recursive: true });
db();
importLegacyMemory();
// 先打开 durable：上次没跑完的 agent 运行在这里恢复
await harness();
pruneRuns();
// 记忆向量在后台补齐（Ollama 没起来时先只用关键词，退避重试）；上次没做完的提取接着做
scheduleVectors();
resumePendingMemory();
scheduleCleanup();

log(`cabinet 启动：监听群 ${JSON.stringify(Object.keys(CHATS))}，默认模型 ${PI_MODEL}`);
const server = startServer();
const stopEvents = startListeners();
// 接回上次进程中断的起草和问答：同一 requestId 会接上 durable 里原来那次运行
resumePendingDrafts(markHandled);
resumePendingQa();
resumePendingDev();
resumePendingAlerts(markHandled);
startWatchdog();
startSchedules();
if (DRAFT_ENABLED) void pollForever();

function shutdown() {
	log("退出");
	markStopping();
	stopPolling();
	stopAlerts();
	stopWatchdog();
	stopSchedules();
	stopEvents();
	server.close();
	// 正在跑的运行已经落库，下次启动接着跑
	void closeHarness().finally(() => process.exit(0));
	setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
