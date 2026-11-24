// 带选项的提问（docs/autoloop-borrow.md §2、docs/bot-borrow.md §2，参照 Orca 的 needs-you Item）：
// agent 遇到要 Yi 拍板的二选一，在最后一条回复末尾写【提问】，cabinet 把选项做成卡片和看板上的按钮；
// Yi 点了哪个，就在原会话里接着做（草稿出新一版，agent 任务接着跑一轮），不用手打改写意见。
// 一件事（Task）同时只挂一个提问：新的替换旧的；Yi 答了、关掉这件事，提问就收掉。
// 这里只管解析、存取和按钮；回答之后怎么接着跑在 cards.ts / api.ts（避免和草稿、任务模块循环引用）。
import { deleteKv, getKv, setKv } from "./db/index.ts";
import { now } from "./util.ts";

export const ASK_MARK = "【提问】";
/** 提问段之后可能还跟着的别的段：截到它们为止 */
const OTHER_MARKS = ["【复查】", "【备注】", "【评审报告】", "【MR评论】"];
const MAX_OPTIONS = 4;
const OPTION_MAX = 40;

export interface AskSpec {
	title: string;
	options: string[];
	/** 推荐的选项下标，按钮用主样式 */
	recommend?: number;
	/** 写给接着做的自己：背景、每个选项具体怎么做 */
	about: string;
}

export interface Ask extends AskSpec {
	taskId: string;
	/** 答了之后怎么接着做：draft 出新一版草稿，dev 接着 agent 任务的会话 */
	kind: "draft" | "dev";
	/** 提问的那次产出：草稿 id 或 agent 任务 id */
	actionId: string;
	created: number;
}

const askKey = (taskId: string) => `ask:${taskId}`;

/**
 * 从 agent 的回复里取出【提问】段：只认最后一个，到文本末尾或下一个已知段标记为止；返回去掉它之后的文本。
 * 格式不对时 ask 为空、error 说明原因（调用方写进备注），文本照样去掉这一段，免得发出去
 */
export function takeAsk(text: string): { text: string; ask?: AskSpec; error?: string } {
	const i = text.lastIndexOf(ASK_MARK);
	if (i < 0) return { text };
	const tail = text.slice(i + ASK_MARK.length);
	const end = Math.min(...OTHER_MARKS.map((m) => tail.indexOf(m)).filter((x) => x >= 0), tail.length);
	const rest = (text.slice(0, i) + tail.slice(end)).trim();
	const raw = tail
		.slice(0, end)
		.trim()
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/```\s*$/, "")
		.trim();
	let v: any;
	try {
		v = JSON.parse(raw);
	} catch (e) {
		return { text: rest, error: `【提问】不是合法的 JSON：${(e as Error).message}` };
	}
	const bad = (why: string) => ({ text: rest, error: `【提问】${why}` });
	const title = typeof v?.title === "string" ? v.title.trim() : "";
	if (!title) return bad("缺少 title（要 Yi 决定什么）");
	const options = Array.isArray(v.options) ? v.options.map((o: unknown) => (typeof o === "string" ? o.trim() : "")) : [];
	if (options.length < 2 || options.length > MAX_OPTIONS || options.some((o: string) => !o))
		return bad(`的 options 要有 2 到 ${MAX_OPTIONS} 个非空选项`);
	if (options.some((o: string) => o.length > OPTION_MAX)) return bad(`的每个选项要在 ${OPTION_MAX} 字以内`);
	const about = typeof v.about === "string" ? v.about.trim() : "";
	if (!about) return bad("缺少 about（每个选项具体怎么做）");
	const recommend = Number.isInteger(v.recommend) && v.recommend >= 0 && v.recommend < options.length ? v.recommend : undefined;
	return { text: rest, ask: { title: title.slice(0, 100), options, recommend, about: about.slice(0, 1500) } };
}

export function saveAsk(taskId: string, kind: Ask["kind"], actionId: string, spec: AskSpec, at = now()) {
	setKv(askKey(taskId), { ...spec, taskId, kind, actionId, created: at } satisfies Ask);
}

export const getAsk = (taskId: string | null | undefined): Ask | undefined =>
	taskId ? (getKv<Ask | null>(askKey(taskId), null) ?? undefined) : undefined;

export function clearAsk(taskId: string | null | undefined) {
	if (taskId) deleteKv(askKey(taskId));
}

/** 答了之后交给原会话的话 */
export function answerPrompt(ask: Ask, answer: string): string {
	return (
		`Yi 回答了你的提问「${ask.title}」：${answer}\n\n你当时写的打算：${ask.about}\n\n` +
		"按他的选择接着做，做完照常给结论；还有要他定的再问，能自己判断的不要再问。"
	);
}

/** 卡片上的一排选项按钮（飞书卡片 JSON 2.0）；value.k = "ask"，cards.ts 按 t（Task id）和 i（选项下标）处理 */
export function askElements(ask: Ask): object[] {
	return [
		{ tag: "markdown", content: `**要你定：${ask.title}**` },
		{
			tag: "column_set",
			flex_mode: "flow",
			columns: ask.options.map((o, i) => ({
				tag: "column",
				width: "auto",
				elements: [
					{
						tag: "button",
						text: { tag: "plain_text", content: o },
						type: i === ask.recommend ? "primary_filled" : "default",
						behaviors: [{ type: "callback", value: { k: "ask", t: ask.taskId, i } }],
					},
				],
			})),
		},
	];
}
