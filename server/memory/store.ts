// 记忆的写入闸与约定。存储在外面：经验、事实与约定在 Hindsight（约定 = directive），Yi 的偏好与画像在 OpenViking。
// cabinet 这边只管写出去之前的校验（不空、不超长、不像凭证；约定只给偏好且要有适用条件），以及约定的作用域怎么编进 tag
import { changed } from "../bus.ts";
import { type Directive, createDirective, deleteDirective, listDirectives, updateDirective } from "./hindsight.ts";

export type Kind = "preference" | "fact" | "experience";
export type Application = "convention" | "reference";

export const KINDS: Kind[] = ["preference", "fact", "experience"];
export const MAX_CONTENT = 300;

export class MemoryError extends Error {}

export const normalize = (s: string) => s.replace(/\s+/g, " ").trim();

// 不记凭证：常见 key 前缀、私钥头、key=value 形式的口令，以及不带分隔的长随机串
const SECRET =
	/(sk-[\w-]{16,}|gh[pousr]_\w{20,}|glpat-[\w-]{16,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*KEY|(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S{6,}|\b[A-Za-z0-9+_-]{40,}\b)/i;

/** 内容闸：不空、不超长、不像凭证。返回拒绝原因 */
export function rejectContent(content: string): string | undefined {
	if (!content) return "内容为空";
	if (content.length > MAX_CONTENT) return `超过 ${MAX_CONTENT} 字`;
	if (SECRET.test(content)) return "看起来含有凭证";
}

/** 送进 Hindsight / OpenViking 的整批材料：凭证打码，不整批丢 */
export const redact = (s: string) => s.replace(new RegExp(SECRET.source, "gi"), "〔已打码〕");

export interface Classification {
	kind: Kind;
	application: Application;
	appliesWhen: string;
	scope?: string;
	scopeName?: string;
}

/** 约定只给偏好，而且必须写明什么时候适用 */
export function checkClassification(c: Classification): string | undefined {
	if (!KINDS.includes(c.kind)) return `未知种类 ${c.kind}`;
	if (c.application !== "convention" && c.application !== "reference") return `未知用法 ${c.application}`;
	if (c.application === "convention" && c.kind !== "preference") return "只有偏好能设为约定";
	if (c.application === "convention" && !normalize(c.appliesWhen)) return "约定要写明什么时候适用";
}

// ---------- 约定 ----------

/** 约定在 cabinet 里的样子：directive 的 name 是适用条件，content 是正文，tag 编作用域 */
export interface Convention {
	id: string;
	content: string;
	appliesWhen: string;
	scope: string;
	scopeName: string;
	active: boolean;
	updated?: string;
}

const NAME_TAG = "name:";

export function toConvention(d: Directive): Convention {
	const scope = d.tags.find((t) => t === "personal" || t.startsWith("person:") || t.startsWith("chat:")) ?? "personal";
	const scopeName = d.tags.find((t) => t.startsWith(NAME_TAG))?.slice(NAME_TAG.length) ?? "";
	return { id: d.id, content: d.content, appliesWhen: d.name, scope, scopeName, active: d.is_active, updated: d.updated_at };
}

const scopeTags = (scope: string, scopeName: string) => [scope, ...(scope !== "personal" && scopeName ? [`${NAME_TAG}${scopeName}`] : [])];

export async function listConventions(): Promise<Convention[]> {
	return (await listDirectives()).map(toConvention);
}

export async function addConvention(content: string, appliesWhen: string, scope = "personal", scopeName = ""): Promise<Convention> {
	content = normalize(content);
	appliesWhen = normalize(appliesWhen);
	const bad = rejectContent(content) ?? checkClassification({ kind: "preference", application: "convention", appliesWhen });
	if (bad) throw new MemoryError(bad);
	const same = (await listConventions()).find((c) => c.content === content && c.appliesWhen === appliesWhen && c.scope === scope);
	if (same) return same;
	const c = toConvention(await createDirective({ name: appliesWhen, content, tags: scopeTags(scope, scopeName) }));
	changed();
	return c;
}

export async function editConvention(id: string, patch: { content?: string; appliesWhen?: string; active?: boolean }): Promise<Convention> {
	const content = patch.content === undefined ? undefined : normalize(patch.content);
	const appliesWhen = patch.appliesWhen === undefined ? undefined : normalize(patch.appliesWhen);
	const bad = (content !== undefined && rejectContent(content)) || (appliesWhen !== undefined && !appliesWhen && "约定要写明什么时候适用");
	if (bad) throw new MemoryError(bad);
	const c = toConvention(
		await updateDirective(id, {
			...(content !== undefined ? { content } : {}),
			...(appliesWhen !== undefined ? { name: appliesWhen } : {}),
			...(patch.active !== undefined ? { is_active: patch.active } : {}),
		}),
	);
	changed();
	return c;
}

export async function removeConvention(id: string) {
	await deleteDirective(id);
	changed();
}
