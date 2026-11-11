// show_ui 的服务端：把 agent 给的组件列表包成 A2UI v1.0 消息、按组件目录校验，暂存到这次运行结束时随结论一起落库。
// 暂存按 durable 会话记在 kv：工具在 durable 里执行，重启接回的运行不会重跑已经执行过的工具，所以不能只放内存。
import { Catalog, MessageProcessor } from "@a2ui/web_core";
import { deleteKv, getKv, setKv } from "../db/index.ts";
import { CATALOG_ID, PROTOCOL_VERSION, REPORT_APIS } from "./catalog.ts";

/** 存在 dev_tasks.ui 里、交给看板渲染的那份 */
export interface AgentUi {
	messages: unknown[];
	at: number;
}

const SURFACE_ID = "report";
// 只有组件 API、没有渲染实现的目录：校验和状态处理都够用（web_core 支持只含 schema 的目录）
const catalog = new Catalog(CATALOG_ID, PROTOCOL_VERSION, REPORT_APIS as any);
const NAMES = new Set(REPORT_APIS.map((a) => a.name));

const childIds = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** 校验通过返回 v1.0 消息；不通过返回给模型看的原因 */
export function buildSurface(components: unknown): { messages: unknown[] } | { error: string } {
	if (!Array.isArray(components) || !components.length) return { error: "components 要是非空数组" };
	const ids = new Set<string>();
	for (const c of components) {
		const id = (c as { id?: unknown })?.id;
		if (typeof id !== "string" || !id) return { error: "每个组件都要有字符串 id" };
		if (ids.has(id)) return { error: `id 重复：${id}` };
		ids.add(id);
	}
	const root = components.find((c) => c.id === "root");
	if (root?.component !== "Stack") return { error: "要有 id 为 root 的 Stack" };
	// web_core 不拦目录里没有的组件名、也不检查引用的子组件是否存在（渲染时只是空着），这里先挡掉
	for (const c of components) {
		if (!NAMES.has(c.component)) return { error: `${c.id} 的组件 ${String(c.component)} 不存在，只能用：${[...NAMES].join(", ")}` };
		const missing = [...childIds(c.children), ...(typeof c.child === "string" ? [c.child] : [])].filter((id) => !ids.has(id));
		if (missing.length) return { error: `${c.id} 引用了不存在的组件：${missing.join(", ")}` };
	}
	const messages = [
		{ version: PROTOCOL_VERSION, createSurface: { surfaceId: SURFACE_ID, catalogId: CATALOG_ID } },
		{ version: PROTOCOL_VERSION, updateComponents: { surfaceId: SURFACE_ID, components } },
	];
	const errors = new MessageProcessor([catalog], undefined, { version: PROTOCOL_VERSION as any }).processMessagesWithErrors(messages);
	if (errors.length)
		return {
			error: errors
				.map((e) => {
					const err = (e as { error?: { path?: string; message?: string } }).error;
					return `${err?.path ?? ""} ${err?.message ?? JSON.stringify(e)}`.trim();
				})
				.join("\n"),
		};
	return { messages };
}

const pendingKey = (convId: string | number) => `ui-pending:${convId}`;

export const setPendingUi = (convId: string | number, messages: unknown[]) => setKv(pendingKey(convId), messages);

/** 新的一次提交开始时清掉，免得带上上一轮的报告 */
export const clearPendingUi = (convId: string | number) => deleteKv(pendingKey(convId));

/** 运行结束时取走 */
export function takePendingUi(convId: string | number, at: number): AgentUi | null {
	const messages = getKv<unknown[] | null>(pendingKey(convId), null);
	if (!messages) return null;
	deleteKv(pendingKey(convId));
	return { messages, at };
}
