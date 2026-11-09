// 看板、需求页、草稿转任务派的活，和定时任务到点：都是 Yi 发起或计划好的，不用分诊，按来源直接定交给谁（docs/router-worker.md §3）。
// 单独一个文件、只依赖记账模块：dev.ts、schedules.ts 引用它，不会和执行模块绕成运行时循环
import { OWNER_OPEN_ID } from "../config.ts";
import type { DevTask, Schedule } from "../db/schema.ts";
import type { DispatchInput } from "../dev.ts";
import { decide, receive } from "../pipeline.ts";
import { fiveHourUsed } from "../quota.ts";
import { routeRules } from "../rules.ts";
import { taskOfAction } from "../taskstore.ts";

/**
 * 派活记一次分派：别处来的活（告警批、定时任务）带着自己的 trigger，按 rule 记；看板派的活记一条 board trigger。
 * 草稿转任务挂回那条草稿所在的那件事；对话页的聊天不算一件事
 */
export function routeBoard(id: string, agent: string, request: string, input: DispatchInput): number {
	const task = { title: input.title, noTask: input.chat, taskId: input.draftId ? taskOfAction(input.draftId) : undefined };
	if (input.triggers?.length)
		return decide(input.triggers, { agent, rule: input.rule ?? "派活", actionKind: "dev", actionId: id, ...task });
	const tid = receive({ channel: "board", externalId: id, thread: `board:${id}`, actorId: OWNER_OPEN_ID, owner: true, text: request });
	return decide([tid], {
		agent,
		rule: input.draftId ? `草稿转任务（${input.draftId}）` : "看板派活",
		actionKind: "dev",
		actionId: id,
		...task,
	});
}

/**
 * 定时任务这一轮要不要跳过（返回原因，不跳过返回 undefined）：
 * 巡检一天几十轮，Claude 5 小时额度快用完时跳过，把额度留给起草（手动触发不拦）；上一次还在跑也跳过
 */
export function cronSkip(s: Pick<Schedule, "patrol">, manual: boolean, prev?: Pick<DevTask, "id" | "status">): string | undefined {
	const used = fiveHourUsed();
	if (s.patrol && !manual && used != null && used >= routeRules().cron.patrolPauseAt)
		return `Claude 5 小时额度已用 ${Math.round(used * 100)}%`;
	if (prev?.status === "running") return `上一次（${prev.id}）还在跑`;
}
