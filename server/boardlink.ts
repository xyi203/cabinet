// 卡片上「在看板查看」的链接：尽量直达那件事，查不到就退回首页。
// 查任务要读库，所以放在这里；card.ts 保持纯格式化，链接由调用方算好传进去。
import { PORT } from "./config.ts";
import type { Approval } from "./db/schema.ts";
import { taskOfAction, taskOfReplyTo, taskOfRouteId } from "./taskstore.ts";

/** 看板地址，参数按 URL 编码（任务 id 里有冒号，页签是中文） */
export function boardUrl(search: Record<string, string> = {}) {
	const q = Object.entries(search)
		.map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
		.join("&");
	return `http://127.0.0.1:${PORT}/${q && `?${q}`}`;
}

/** 草稿；还没入库的（刚起草完要发卡片）按它的分派来找 */
export function draftLink(draftId: string, routeId?: number | null) {
	const task = draftId ? taskOfAction(draftId) : taskOfRouteId(routeId);
	return task ? boardUrl({ task }) : boardUrl();
}

/** agent 任务：挂着一件事就链到那件事，否则直接开任务抽屉 */
export function devLink(devId: string) {
	const task = taskOfAction(devId);
	return task ? boardUrl({ task }) : boardUrl({ dev: devId });
}

/** 审批：挂得到一件事就链过去；挂不上的在看板上是待审批的合成条目 apv:<id>，批完就没了，退回首页 */
export function approvalLink(a: Pick<Approval, "id" | "status" | "devTaskId" | "draftReplyTo">) {
	const task = (a.devTaskId && taskOfAction(a.devTaskId)) || (a.draftReplyTo && taskOfReplyTo(a.draftReplyTo));
	if (task) return boardUrl({ task });
	return a.status === "pending" ? boardUrl({ task: `apv:${a.id}` }) : boardUrl();
}

/** 起草失败：失败时消息通常已经分派进一件事；还没有才是看板上的合成条目 fail-<消息 id> */
export function failureLink(failTaskId: string) {
	const task = taskOfReplyTo(failTaskId.replace(/^fail-/, ""));
	return boardUrl({ task: task ?? failTaskId });
}

export const opsLink = () => boardUrl({ view: "ops", tab: "自检" });
