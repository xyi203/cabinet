// 订阅后端 SSE：状态变化时刷新看板数据，运行中的 pi 步骤按 runId 累积，任务抽屉里实时显示
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import type { Step } from "./api";

const steps = new Map<string, Step[]>();
/** 从 run_start 起完整收到的运行：页面在运行中途才打开时，SSE 只补得到后半段，这种不算，改从执行日志里取 */
const complete = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;
const notify = () => {
	version++;
	for (const l of listeners) l();
};

function onLive(e: any) {
	if (e.type === "run_start") {
		steps.set(e.runId, []);
		complete.add(e.runId);
	} else if (e.type === "tool_start")
		steps.set(e.runId, [...(steps.get(e.runId) ?? []), { t: e.t, kind: "call", tool: e.tool, args: e.args, callId: e.callId }]);
	else if (e.type === "tool_end")
		steps.set(
			e.runId,
			(steps.get(e.runId) ?? []).map((s) => (s.callId === e.callId ? { ...s, result: e.result, error: e.error, done: e.t } : s)),
		);
	else if (e.type === "text") steps.set(e.runId, [...(steps.get(e.runId) ?? []), { t: e.t, kind: "text", text: e.text }]);
	else return;
	notify();
}

export function useLiveSteps(runId?: string): Step[] | undefined {
	useSyncExternalStore(
		(l) => (listeners.add(l), () => listeners.delete(l)),
		() => version,
		() => 0,
	);
	return runId && complete.has(runId) ? steps.get(runId) : undefined;
}

/** 页面上还有没发出去的字：key → 有没有。有就先不自动刷新 */
const holds = new Map<string, boolean>();
export const holdReload = (key: string, on: boolean) => void holds.set(key, on);

const typing = () => {
	const el = document.activeElement as HTMLElement | null;
	return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
};

/**
 * 服务重装后前端换了版本，打开着的页面还在跑旧代码：发现版本变了就刷新。
 * 工作台上等不在打字、输入框和草稿里没有没发的字时刷；别的页面（设置、记忆里可能有没存的表单）不自动刷，等切到另一页时再刷
 */
/** 页面打开时的前端版本；发现版本变了时在哪一页。整个页面只有一处用，放模块里 */
let firstBuild: string | undefined;
let staleOn: string | undefined;

export function useReloadOnNewBuild(build: string | undefined, page: string, safePage: boolean) {
	useEffect(() => {
		if (!build) return;
		firstBuild ??= build;
		if (build === firstBuild) return;
		staleOn ??= page;
		// 之后切过页：上一页的状态已经没了，直接按新地址刷
		if (page !== staleOn) return location.reload();
		if (!safePage) return;
		const tryReload = () => {
			if (!typing() && ![...holds.values()].some(Boolean)) location.reload();
		};
		tryReload();
		const t = setInterval(tryReload, 3000);
		return () => clearInterval(t);
	}, [build, page, safePage]);
}

export function useLiveUpdates(onStatus: (connected: boolean) => void) {
	const qc = useQueryClient();
	useEffect(() => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		// 一次处理常连带多个事件，合并成一次刷新
		const refresh = () => {
			clearTimeout(timer);
			timer = setTimeout(() => {
				qc.invalidateQueries({ queryKey: ["state"] });
				qc.invalidateQueries({ queryKey: ["memory"] });
			}, 300);
		};
		const es = new EventSource("/api/events");
		es.addEventListener("open", () => onStatus(true));
		es.addEventListener("error", () => onStatus(false));
		es.addEventListener("message", (m) => {
			const e = JSON.parse(m.data);
			onLive(e);
			if (e.type === "changed" || e.type === "run_start" || e.type === "run_end") refresh();
		});
		return () => {
			clearTimeout(timer);
			es.close();
		};
	}, [qc, onStatus]);
}
