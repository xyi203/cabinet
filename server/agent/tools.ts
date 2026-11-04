// durable 自带 read / bash；这里补上只读的 grep / find / ls，参数里的路径由守卫按允许目录检查
import { defineTool } from "@earendil-works/pi-durable";
import { bool, num, obj, opt, str } from "@earendil-works/pi-schema";
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";

const MAX_OUTPUT = 50_000;
const cwdOf = (api: { env?: { cwd?: string } | undefined }) => (api.env as any)?.cwd ?? process.cwd();

function run(cmd: string, args: string[], cwd: string): Promise<string> {
	return new Promise((resolve, reject) =>
		execFile(cmd, args, { cwd, maxBuffer: 10 * 1024 * 1024, timeout: 60_000 }, (err, stdout, stderr) => {
			// rg 没有匹配时退出码 1，不算错误
			if (err && (err as any).code !== 1) reject(new Error(stderr.trim() || err.message));
			else resolve(stdout);
		}),
	);
}

const text = (s: string) => ({
	output: [{ type: "text" as const, text: s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n…（已截断）` : s || "（无结果）" }],
});

export const grepTool = defineTool({
	name: "grep",
	description: "在文件内容里搜索正则（ripgrep），返回 文件:行号:内容。path 默认当前目录，glob 过滤文件名，例如 *.go",
	parameters: obj({ pattern: str(), path: opt(str()), glob: opt(str()), ignoreCase: opt(bool()), limit: opt(num()) }),
	execute: async (args, api) => {
		const rgArgs = ["--line-number", "--no-heading", "--color=never", "--max-columns=300", "-m", String(args.limit ?? 100)];
		if (args.ignoreCase) rgArgs.push("-i");
		if (args.glob) rgArgs.push("-g", args.glob);
		rgArgs.push("-e", args.pattern, "--", args.path ?? ".");
		return text(await run("rg", rgArgs, cwdOf(api)));
	},
});

export const findTool = defineTool({
	name: "find",
	description: "按文件名 glob 查找文件（遵守 .gitignore），例如 pattern=**/*_test.go",
	parameters: obj({ pattern: str(), path: opt(str()), limit: opt(num()) }),
	execute: async (args, api) => {
		const out = await run("rg", ["--files", "-g", args.pattern, "--", args.path ?? "."], cwdOf(api));
		return text(
			out
				.split("\n")
				.filter(Boolean)
				.slice(0, args.limit ?? 500)
				.join("\n"),
		);
	},
});

export const lsTool = defineTool({
	name: "ls",
	description: "列出目录内容，目录名后带 /",
	parameters: obj({ path: opt(str()) }),
	execute: async (args, api) => {
		const dir = path.resolve(cwdOf(api), args.path ?? ".");
		const items = await readdir(dir, { withFileTypes: true });
		return text(
			items
				.map((d) => (d.isDirectory() ? `${d.name}/` : d.name))
				.toSorted()
				.join("\n"),
		);
	},
});
