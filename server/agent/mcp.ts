// MCP：启动时连上 agent 配置里用到的 server，把它们的工具包装成 durable 工具（mcp__<server>__<tool>）。
// - 走 codemode：MCP 工具只给脚本调（callers: tools），模型拿到的是一个 codemode 工具，在沙箱里写 JS 调 tools.<名字>()，
//   一次脚本里能批量查、过滤、汇总，只把结果交回上下文
// - server 定义沿用 pi 的 mcp.json（MCP_CONFIG），agent 在 agents.json 的 mcp 里列出能用哪些 server
// - 只连被 agent 引用的 server：mcp.json 里还有能写的 server（如 devops-mcp-prod），没引用就不连、不注册
// - 工具在 harness 打开前注册：重启后接回的运行要能找到它们。agents.json 新引用 server 需要重启
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { existsSync, readFileSync } from "node:fs";
import { MCP_CONFIG } from "../config.ts";
import { log } from "../util.ts";
import { RULES_FILE, mcpReadOnly, mcpToolName } from "./guard.ts";

interface ServerDef {
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	url?: string;
	headers?: Record<string, string>;
}

const CONNECT_TIMEOUT = 60_000; // uvx 第一次启动要下载包
const CALL_TIMEOUT = 120_000;
const MAX_OUTPUT = 50_000;

export function loadServers(file = MCP_CONFIG): Record<string, ServerDef> {
	if (!existsSync(file)) return {};
	const raw = JSON.parse(readFileSync(file, "utf8"));
	return raw.mcpServers ?? {};
}

const clients = new Map<string, Promise<Client>>();

function connect(name: string, def: ServerDef): Promise<Client> {
	const client = new Client({ name: "cabinet", version: "1.0.0" });
	const transport = def.url
		? new StreamableHTTPClientTransport(new URL(def.url), { requestInit: { headers: def.headers } })
		: new StdioClientTransport({
				command: def.command!,
				args: def.args ?? [],
				// 只追加 server 自己的 env，PATH 等沿用进程的（launchd 里的 PATH 能找到 uvx）
				env: { ...(process.env as Record<string, string>), ...def.env },
				cwd: def.cwd,
				stderr: "ignore",
			});
	// 子进程退出或连接断开：下次调用重连
	client.onclose = () => clients.delete(name);
	return client.connect(transport, { timeout: CONNECT_TIMEOUT }).then(() => client);
}

function clientOf(name: string, def: ServerDef): Promise<Client> {
	let c = clients.get(name);
	if (!c) {
		c = connect(name, def);
		clients.set(name, c);
		c.catch(() => clients.delete(name));
	}
	return c;
}

function renderResult(result: any): string {
	const parts: string[] = [];
	for (const c of result.content ?? []) {
		if (c.type === "text") parts.push(c.text);
		else if (c.type === "resource" && c.resource?.text) parts.push(c.resource.text);
		else parts.push(`（${c.type} 内容未展示）`);
	}
	if (!parts.length && result.structuredContent) parts.push(JSON.stringify(result.structuredContent));
	const s = parts.join("\n");
	return s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n…（已截断）` : s || "（无结果）";
}

/** 没声明 readOnlyHint 但确认只读的 MCP 工具，写在 skill-rules.json 的 _mcpRead（完整工具名 mcp__<server>__<tool>） */
function mcpReadList(): Set<string> {
	try {
		return new Set(JSON.parse(readFileSync(RULES_FILE, "utf8"))._mcpRead ?? []);
	} catch {
		return new Set();
	}
}

/** 连上这些 server，列出工具。连不上的跳过并记日志，不影响其他 server 和 cabinet 启动 */
export async function mcpTools(names: string[], servers = loadServers()): Promise<ToolRegistration[]> {
	const tools: ToolRegistration[] = [];
	const readList = mcpReadList();
	await Promise.all(
		[...new Set(names)].map(async (name) => {
			const def = servers[name];
			if (!def) return log(`MCP server ${name} 不在 ${MCP_CONFIG} 里，跳过`);
			try {
				const listed = await (await clientOf(name, def)).listTools(undefined, { timeout: CONNECT_TIMEOUT });
				for (const t of listed.tools) {
					// 只读的直接放行，其余在守卫里按写操作处理（要审批）
					if (t.annotations?.readOnlyHint || readList.has(mcpToolName(name, t.name))) mcpReadOnly.add(mcpToolName(name, t.name));
					tools.push(
						defineTool({
							name: mcpToolName(name, t.name),
							description: `[MCP ${name}] ${t.description ?? t.name}`,
							parameters: (t.inputSchema ?? { type: "object", properties: {} }) as any,
							callers: ["tools"],
							// 只读的工具中断后可以重跑
							replay: t.annotations?.readOnlyHint ? "safe" : "unsafe",
							execute: async (args: any) => {
								const result = await (
									await clientOf(name, def)
								).callTool({ name: t.name, arguments: args ?? {} }, undefined, {
									timeout: CALL_TIMEOUT,
								});
								return { output: [{ type: "text" as const, text: renderResult(result) }], isError: Boolean(result.isError) };
							},
						}),
					);
				}
				log(`MCP server ${name}：${listed.tools.length} 个工具`);
			} catch (e) {
				log(`MCP server ${name} 连接失败，跳过`, String((e as Error)?.message ?? e).slice(0, 200));
			}
		}),
	);
	return tools;
}

/** codemode 里按 server 分组：工具说明按组列出，脚本里也能按组搜 */
export function mcpNamespaces(names: string[], servers = loadServers()) {
	return [...new Set(names)].map((name) => ({
		name,
		description: (servers[name] as { description?: string } | undefined)?.description,
		prefix: mcpToolName(name, ""),
	}));
}

export async function closeMcp() {
	const all = [...clients.values()];
	clients.clear();
	await Promise.allSettled(all.map(async (c) => (await c).close()));
}
