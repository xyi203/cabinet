// 进程内事件总线：运行中的 pi 步骤、任务状态变化推给看板（SSE）
import { EventEmitter } from "node:events";

export type LiveEvent =
	| { type: "run_start"; runId: string; label: string; chatId?: string; agent?: string; t: number }
	| { type: "tool_start"; runId: string; callId: string; tool: string; args: unknown; t: number }
	| { type: "tool_end"; runId: string; callId: string; tool: string; result: string; error: boolean; t: number }
	| { type: "text"; runId: string; text: string; t: number }
	| { type: "run_end"; runId: string; ok: boolean; t: number }
	| { type: "changed"; t: number };

export const bus = new EventEmitter();
bus.setMaxListeners(100);

export const emit = (e: LiveEvent) => bus.emit("live", e);
export const changed = () => emit({ type: "changed", t: Date.now() / 1000 });
