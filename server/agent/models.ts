// 模型目录：沿用 pi 的 ~/.pi/agent/models.json（magpie 网关），转成 pi-ai 的 Provider。
// 只支持 openai-completions：目前配置里只有这一种；遇到别的直接报错，不静默跳过。
import {
	type Api,
	createModels,
	createProvider,
	getSupportedThinkingLevels,
	type Message,
	type Model,
	type MutableModels,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const MODELS_JSON = path.join(homedir(), ".pi/agent/models.json");

export interface ModelSpec {
	provider: string;
	modelId: string;
}

let _models: MutableModels | undefined;

export function models(): MutableModels {
	if (_models) return _models;
	const config = JSON.parse(readFileSync(MODELS_JSON, "utf8"));
	const m = createModels();
	for (const [id, p] of Object.entries<any>(config.providers ?? {})) {
		if (p.api !== "openai-completions") throw new Error(`models.json 提供方 ${id} 的 api=${p.api} 暂不支持`);
		const list: Model<Api>[] = (p.models ?? []).map((x: any) => ({
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			input: ["text"],
			reasoning: false,
			contextWindow: 128_000,
			maxTokens: 32_000,
			name: x.id,
			...x,
			api: p.api,
			provider: id,
			baseUrl: p.baseUrl,
			compat: { ...p.compat, ...x.compat },
		}));
		m.setProvider(
			createProvider({
				id,
				name: p.name ?? id,
				baseUrl: p.baseUrl,
				auth: { apiKey: { name: `${id} API key`, resolve: async () => ({ auth: { apiKey: p.apiKey }, source: "models.json" }) } },
				models: list,
				api: openAICompletionsApi(),
			}),
		);
	}
	return (_models = m);
}

/** 直接调网关要用的地址和 key（额度探测读响应头，pi-ai 拿不到） */
export function providerEndpoint(id: string): { baseUrl: string; apiKey: string } | undefined {
	const p = JSON.parse(readFileSync(MODELS_JSON, "utf8")).providers?.[id];
	return p?.baseUrl ? { baseUrl: String(p.baseUrl).replace(/\/$/, ""), apiKey: String(p.apiKey ?? "") } : undefined;
}

/** 测试用：换成假模型 */
export const useModels = (m: MutableModels) => void (_models = m);

/** "claude/claude-opus-5-5" 这类名字在 magpie 提供方下；也接受 "provider:model" */
export function resolveModel(spec: string): ModelSpec {
	const m = models();
	if (spec.includes(":")) {
		const [provider, modelId] = spec.split(":", 2);
		if (m.getModel(provider, modelId)) return { provider, modelId };
	} else {
		const hit = m.getModels().find((x) => x.id === spec);
		if (hit) return { provider: hit.provider, modelId: hit.id };
	}
	throw new Error(`找不到模型 ${spec}`);
}

export interface ModelOption {
	id: string;
	name: string;
	levels: string[];
}

/** 看板上可选的模型，以及每个模型支持的思考强度 */
export function modelOptions(): ModelOption[] {
	return models()
		.getModels()
		.map((m) => ({ id: m.id, name: m.name ?? m.id, levels: m.reasoning ? getSupportedThinkingLevels(m as Model<Api>) : ["off"] }));
}

/** 模型消息内容里的文字部分 */
export const textOf = (content: unknown): string =>
	Array.isArray(content)
		? content
				.filter((c: any) => c?.type === "text")
				.map((c: any) => c.text)
				.join("\n")
		: String(content ?? "");

/** 分诊这类一问一答：不需要工具和会话，直接调模型 */
export async function complete(spec: string, systemPrompt: string, prompt: string): Promise<string> {
	const m = models();
	const ref = resolveModel(spec);
	const model = m.getModel(ref.provider, ref.modelId)!;
	const messages: Message[] = [{ role: "user", content: prompt, timestamp: Date.now() }];
	const res = await m.complete(model, { systemPrompt, messages });
	if (res.stopReason === "error") throw new Error(res.errorMessage ?? "模型调用失败");
	return textOf(res.content);
}
