// agent 运行的并发控制：起草、改写、问答、agent 任务共用
import { MAX_CONCURRENCY } from "../config.ts";
import { KeyedLock, Semaphore } from "../util.ts";

/** 同时跑的 agent 运行不超过 MAX_CONCURRENCY */
export const sem = new Semaphore(MAX_CONCURRENCY);
/** 同一会话（群、话题、草稿所在聊天）里的运行排队，避免并发写同一个 durable 会话 */
export const locks = new KeyedLock();
