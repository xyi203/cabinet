// A2UI 结论报告的组件目录：服务端按它校验 show_ui 的输入。看板前端的渲染（src/components/AgentUi.tsx）和这里一一对应，改组件两边一起改。
// 只放看板自己的几种块，不用 A2UI 的基础组件：基础组件是自带样式的 Web Component，和看板的视觉规范（docs/ui.md）对不上。
// 子组件和动作用 web_core 的 ChildListSchema / ActionSchema，按协议的写法校验；agent 只写字面量，不用数据模型。
import { z } from "zod";
import { ActionSchema, ChildListSchema, DynamicStringSchema } from "@a2ui/web_core/v1_0";
import { REPLY_EVENT } from "./protocol.ts";

export { CATALOG_ID, PROTOCOL_VERSION, REPLY_EVENT } from "./protocol.ts";

const Level = z.enum(["ok", "watch", "bad"]);

export const StackApi = {
	name: "Stack",
	schema: z.object({ children: ChildListSchema }).strict(),
};

export const VerdictApi = {
	name: "Verdict",
	schema: z.object({ level: Level, title: DynamicStringSchema, detail: DynamicStringSchema.optional() }).strict(),
};

export const DecisionApi = {
	name: "Decision",
	schema: z
		.object({
			title: DynamicStringSchema,
			detail: DynamicStringSchema.optional(),
			options: z
				.array(z.object({ label: DynamicStringSchema, action: ActionSchema }).strict())
				.max(4)
				.optional(),
		})
		.strict(),
};

export const MetricsApi = {
	name: "Metrics",
	schema: z
		.object({
			title: DynamicStringSchema.optional(),
			items: z
				.array(
					z
						.object({
							label: z.string(),
							value: z.string(),
							base: z.string().optional(),
							level: Level.optional(),
							note: z.string().optional(),
						})
						.strict(),
				)
				.min(1),
		})
		.strict(),
};

export const TableApi = {
	name: "Table",
	schema: z
		.object({
			title: DynamicStringSchema.optional(),
			columns: z.array(z.string()).min(1),
			rows: z.array(z.array(z.string())),
			note: DynamicStringSchema.optional(),
		})
		.strict(),
};

export const SectionApi = {
	name: "Section",
	schema: z.object({ title: DynamicStringSchema, children: ChildListSchema, collapsed: z.boolean().optional() }).strict(),
};

export const MarkdownApi = {
	name: "Markdown",
	schema: z.object({ text: DynamicStringSchema }).strict(),
};

export const REPORT_APIS = [StackApi, VerdictApi, DecisionApi, MetricsApi, TableApi, SectionApi, MarkdownApi];

/** show_ui 工具说明：组件和写法都在这里，模型只看得到这一段 */
export const SHOW_UI_HELP = [
	"把这次结论再整理成一份结构化报告，显示在 Yi 的看板上（飞书和文字结论不受影响，文字结论照常写全）。",
	"只在任务要求、或结论里有对比数据 / 要 Yi 拍板的事时调用；一次运行调一次，再调会覆盖上一次。校验失败会返回原因，改了再调。",
	"components 是扁平列表，每项 {id, component, ...属性}，子组件按 id 引用；必须有 id 为 root 的 Stack。id 只用字母、数字、下划线（不能有连字符），所有值写字面量。",
	"组件：",
	"- Stack {children: [id...]}：纵向排列。",
	"- Verdict {level: ok|watch|bad, title, detail?}：一句话结论，放最前面，一份报告一个。detail 可写 Markdown。",
	`- Decision {title, detail?, options?: [{label, action}]}：要 Yi 拍板的事，一件一个。option 的 action 写 {"event": {"name": "${REPLY_EVENT}", "context": {"text": "点了之后替 Yi 发回这个会话的话"}}}，最多 4 个；不需要按钮就不给 options。`,
	"- Metrics {title?, items: [{label, value, base?, level?, note?}]}：几个关键数，base 是对照值（基线 / 对照组），level 标出异常。",
	"- Table {title?, columns: [..], rows: [[..]], note?}：明细对比，单元格都是字符串。",
	"- Section {title, children: [id...], collapsed?}：分组；依据、基线这类默认收起（collapsed: true）。",
	"- Markdown {text}：其余说明。",
	"顺序：Verdict → Decision → Metrics / Table → 收起的 Section（依据、基线）。数字带单位，口径写进 title 或 note。",
].join("\n");
