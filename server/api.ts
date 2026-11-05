// 本地 HTTP：看板接口 + SSE + 托管 TanStack Start 构建产物。只监听 127.0.0.1。
// 写接口防跨站：任何网页都能向 localhost 发请求，所以要求自定义头里带启动时随机生成的 token
// （由同源接口下发，跨域页面读不到响应，也发不出带自定义头的简单请求），并校验 Host / Origin，挡住 DNS rebinding。
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { type LiveEvent, bus, changed } from "./bus.ts";
import { COMMON_EMOJI, DEV_ORIGIN, OAUTH_REDIRECT, PATHS, PORT } from "./config.ts";
import { applyDraftAction } from "./drafts/actions.ts";
import { ApprovalError, decideApproval } from "./approvals.ts";
import { lineage, recentLineage } from "./pipeline.ts";
import { deleteSchedule, listSchedules, runNow, saveSchedule } from "./schedules.ts";
import { type Kind, listStickers, resolveSticker } from "./drafts/format.ts";
import { DraftError, getDraft, LIVE } from "./drafts/store.ts";
import { LarkError, authorizeUrl, exchangeCode, userAuthStatus } from "./lark/bot.ts";
import { lastPoll } from "./poller.ts";
import { conversationTranscript } from "./agent/driver.ts";
import { modelOptions } from "./agent/models.ts";
import { closeTask, devDiff, discardDev, dispatch, getDevTask, listRepos, messageDev, pushDev, stopDev } from "./dev.ts";
import { dismissTask, retryTask } from "./retry.ts";
import { dashboardState, sessionLog } from "./tasks.ts";
import { search } from "./memory/recall.ts";
import {
	type Classification,
	MemoryError,
	classifyMemory,
	confirmMemory,
	forgetMemory,
	listMemories,
	rememberFromYi,
	restoreMemory,
	vectorStatus,
} from "./memory/store.ts";
import { log, now } from "./util.ts";

const TOKEN = randomBytes(24).toString("base64url");
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const ALLOWED_ORIGINS = new Set([...[...ALLOWED_HOSTS].map((h) => `http://${h}`), ...(DEV_ORIGIN ? [DEV_ORIGIN] : [])]);
const oauthStates = new Map<string, number>();

function send(res: ServerResponse, code: number, body: unknown, type = "application/json; charset=utf-8") {
	res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
	res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function localRequest(req: IncomingMessage) {
	const origin = req.headers.origin;
	return ALLOWED_HOSTS.has(req.headers.host ?? "") && (!origin || ALLOWED_ORIGINS.has(origin));
}

// 草稿 id 是私聊卡片的 message_id（om_…）；只回表情 / 不用回的安静草稿没有卡片，id 是 quiet_<原消息 id>_<时间>
export const DRAFT_DISPATCH_RE = /^\/api\/drafts\/((?:quiet_)?om_[\w-]+)\/dispatch$/;
export const DRAFT_ACTION_RE = /^\/api\/drafts\/((?:quiet_)?om_[\w-]+)\/(send|discard|revise|complete)$/;

function tokenOk(req: IncomingMessage) {
	const got = Buffer.from(String(req.headers["x-cabinet-token"] ?? ""));
	const want = Buffer.from(TOKEN);
	return got.length === want.length && timingSafeEqual(got, want);
}

const modelChoice = (body: any) => ({
	model: body.model ? String(body.model) : undefined,
	thinking: body.thinking ? String(body.thinking) : undefined,
});

async function readJson(req: IncomingMessage): Promise<any> {
	let raw = "";
	for await (const chunk of req) {
		raw += chunk;
		if (raw.length > 100_000) throw new Error("请求体太大");
	}
	return raw ? JSON.parse(raw) : {};
}

const classification = (body: any): Classification => ({
	kind: body.kind,
	application: body.application,
	appliesWhen: String(body.appliesWhen ?? ""),
});

/** 记忆的写操作：Yi 在看板上新增、确认、遗忘、恢复、改分类。都带预期 revision，防止对着旧版本操作 */
function memoryAction(p: string, body: any) {
	if (p === "/api/memory") {
		const content = String(body.content ?? "");
		return rememberFromYi(
			content,
			classification(body),
			{ kind: "board", ref: "board", quote: content.slice(0, 200), at: now() },
			"board",
			true,
		);
	}
	const m = /^\/api\/memory\/(\d+)\/(confirm|forget|restore|classify)$/.exec(p);
	if (!m) return undefined;
	const id = Number(m[1]);
	const revision = Number(body.revision);
	if (m[2] === "confirm") return confirmMemory(id, revision);
	if (m[2] === "forget") return forgetMemory(id, revision);
	if (m[2] === "restore") return restoreMemory(id, revision);
	return classifyMemory(id, revision, classification(body));
}

function sse(req: IncomingMessage, res: ServerResponse) {
	res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
	res.write(": connected\n\n");
	const onEvent = (e: LiveEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);
	const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
	bus.on("live", onEvent);
	req.on("close", () => {
		clearInterval(ping);
		bus.off("live", onEvent);
	});
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL) {
	const p = url.pathname;
	if (req.method === "GET") {
		if (p === "/api/session") return send(res, 200, { token: TOKEN });
		if (p === "/api/state") return send(res, 200, { ...dashboardState(), auth: userAuthStatus(), pollSince: lastPoll() });
		if (p === "/api/events") return sse(req, res);
		if (p === "/api/log") {
			const num = (k: string) => (url.searchParams.get(k) ? Number(url.searchParams.get(k)) : undefined);
			return send(res, 200, { steps: await sessionLog(url.searchParams.get("session") ?? undefined, num("start"), num("end")) });
		}
		if (p === "/api/repos") return send(res, 200, { repos: listRepos() });
		if (p === "/api/schedules") return send(res, 200, { items: listSchedules() });
		// 四段模型：最近的 trigger 分派给了谁、产出了什么、结果如何；带 id 时只看这一条
		if (p === "/api/pipeline") {
			const id = url.searchParams.get("id");
			if (id) return send(res, 200, { item: lineage(id) ?? null });
			return send(res, 200, { items: recentLineage(Number(url.searchParams.get("limit")) || 200) });
		}
		if (p === "/api/models") return send(res, 200, { models: modelOptions() });
		const transcript = /^\/api\/dev\/(dev-\d+)\/transcript$/.exec(p);
		if (transcript) {
			if (!getDevTask(transcript[1])) return send(res, 404, { error: "not found" });
			return send(res, 200, { items: await conversationTranscript(`dev-${transcript[1]}`) });
		}
		const diff = /^\/api\/dev\/(dev-\d+)\/diff$/.exec(p);
		if (diff) {
			try {
				return send(res, 200, await devDiff(diff[1]));
			} catch (e) {
				return send(res, 409, { error: (e as Error).message });
			}
		}
		if (p.startsWith("/api/images/")) {
			// 只给 PATHS.images 下的文件：消息截图，过期会被定期清理
			const name = path.basename(decodeURIComponent(p.slice("/api/images/".length)));
			const ext = path.extname(name).slice(1).toLowerCase();
			const file = path.join(PATHS.images, name);
			if (!["png", "jpg", "jpeg", "gif", "webp"].includes(ext) || !existsSync(file)) return send(res, 404, { error: "not found" });
			return send(res, 200, readFileSync(file), `image/${ext === "jpg" ? "jpeg" : ext}`);
		}
		if (p === "/api/stickers") return send(res, 200, { stickers: listStickers(), emoji: COMMON_EMOJI });
		if (p.startsWith("/api/stickers/")) {
			const name = decodeURIComponent(p.slice("/api/stickers/".length));
			if (resolveSticker(name) !== name) return send(res, 404, { error: "not found" });
			const ext = path.extname(name).slice(1).toLowerCase();
			return send(res, 200, readFileSync(path.join(PATHS.stickers, name)), `image/${ext === "jpg" ? "jpeg" : ext}`);
		}
		if (p === "/api/memory") return send(res, 200, { items: listMemories(), vectors: vectorStatus() });
		if (p === "/api/memory/search") {
			// 看板搜索不限作用域，带两臂分数，校准门槛用
			const q = url.searchParams.get("q") ?? "";
			const r = await search(q, { anyScope: true, states: ["active", "candidate", "contested"] });
			return send(res, 200, { ids: r.items.map((m) => m.id), scores: r.scores, degraded: r.degraded });
		}
		return send(res, 404, { error: "not found" });
	}
	if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
	if (!tokenOk(req)) return send(res, 403, { error: "forbidden" });
	if (p === "/api/oauth/start") {
		try {
			await startOAuthCallback();
		} catch (e) {
			return send(res, 409, { error: `授权回调端口不可用：${(e as Error).message}` });
		}
		const state = randomBytes(16).toString("hex");
		oauthStates.set(state, Date.now());
		return send(res, 200, { url: authorizeUrl(state) });
	}
	const retry = /^\/api\/tasks\/([\w-]+)\/(retry|dismiss)$/.exec(p);
	if (retry) {
		try {
			if (retry[2] === "retry") retryTask(retry[1]);
			else dismissTask(retry[1]);
			return send(res, 202, { ok: true });
		} catch (e) {
			return send(res, 409, { error: (e as Error).message });
		}
	}
	let body: any;
	try {
		body = await readJson(req);
	} catch {
		return send(res, 400, { error: "bad json" });
	}
	const apv = /^\/api\/approvals\/(apv-[\w]+)\/(approve|reject)$/.exec(p);
	if (apv) {
		try {
			return send(res, 200, { ok: true, item: await decideApproval(apv[1], apv[2] as "approve" | "reject", String(body.note ?? "")) });
		} catch (e) {
			if (e instanceof ApprovalError) return send(res, 409, { error: e.message });
			throw e;
		}
	}
	if (p.startsWith("/api/memory")) {
		try {
			const item = memoryAction(p, body);
			return item ? send(res, 200, { ok: true, item }) : send(res, 404, { error: "not found" });
		} catch (e) {
			if (e instanceof MemoryError) return send(res, 409, { error: e.message });
			throw e;
		}
	}
	// 定时任务：新建 / 修改、立即运行、删除
	const schedM = /^\/api\/schedules(?:\/(cron-\d+)\/(run|delete))?$/.exec(p);
	if (schedM) {
		try {
			if (!schedM[1])
				return send(res, 200, {
					ok: true,
					item: saveSchedule({
						id: body.id ? String(body.id) : undefined,
						name: String(body.name ?? ""),
						cron: String(body.cron ?? ""),
						agent: String(body.agent ?? ""),
						prompt: String(body.prompt ?? ""),
						enabled: body.enabled === undefined ? undefined : Boolean(body.enabled),
					}),
				});
			if (schedM[2] === "run") return send(res, 200, { ok: true, task: await runNow(schedM[1]) });
			deleteSchedule(schedM[1]);
			return send(res, 200, { ok: true });
		} catch (e) {
			if (e instanceof DraftError) return send(res, 409, { error: e.message });
			log("定时任务操作失败", p, e);
			return send(res, 500, { error: String((e as Error).message).slice(0, 300) });
		}
	}
	// 开发任务：指派、继续修改、推送建 MR、放弃
	const dispatchM = DRAFT_DISPATCH_RE.exec(p);
	const devM = /^\/api\/dev\/(dev-\d+)\/(message|stop|push|discard|close)$/.exec(p);
	if (dispatchM || devM || p === "/api/agent-tasks") {
		try {
			if (p === "/api/agent-tasks")
				return send(res, 200, {
					ok: true,
					task: await dispatch({
						agent: String(body.agent ?? ""),
						request: String(body.request ?? ""),
						repo: body.repo ? String(body.repo) : undefined,
						branch: body.branch ? String(body.branch) : undefined,
						chat: Boolean(body.chat),
						...modelChoice(body),
					}),
				});
			if (dispatchM)
				return send(res, 200, {
					ok: true,
					task: await dispatch({
						draftId: dispatchM[1],
						repo: String(body.repo ?? ""),
						branch: String(body.branch ?? ""),
						instructions: String(body.instructions ?? ""),
						...modelChoice(body),
					}),
				});
			const [, id, action] = devM!;
			if (action === "message") return send(res, 200, { ok: true, mode: await messageDev(id, String(body.text ?? "")) });
			if (action === "stop") await stopDev(id);
			if (action === "close") closeTask(id);
			if (action === "push") return send(res, 200, { ok: true, url: await pushDev(id) });
			if (action === "discard") await discardDev(id);
			return send(res, 200, { ok: true });
		} catch (e) {
			if (e instanceof DraftError) return send(res, 409, { error: e.message });
			log("开发任务操作失败", p, e);
			return send(res, 500, { error: String((e as Error).message).slice(0, 300) });
		}
	}
	const m = DRAFT_ACTION_RE.exec(p);
	if (!m) return send(res, 404, { error: "not found" });
	const [, id, action] = m;
	const arg = String(body.text ?? "");
	const kind: Kind = ["text", "reaction", "sticker"].includes(body.kind) ? body.kind : "text";
	if (action === "revise") {
		// 改写要跑一轮 pi，放后台；新草稿会出现在列表里，旧的变成「已改写」
		const d = getDraft(id);
		if (!d || !LIVE.includes(d.status)) return send(res, 409, { error: "这条草稿不能再改写" });
		if (!arg.trim()) return send(res, 400, { error: "缺少修改意见" });
		void applyDraftAction(id, "revise", arg).catch((e) => log("看板改写失败", id, e));
		return send(res, 202, { ok: true });
	}
	try {
		const status = await applyDraftAction(id, action as "send", arg, kind);
		return send(res, 200, { ok: true, status });
	} catch (e) {
		if (e instanceof DraftError) return send(res, 409, { error: e.message });
		if (e instanceof LarkError) return send(res, 502, { error: e.message });
		log("看板操作失败", action, id, e);
		return send(res, 500, { error: "执行失败，详情见日志" });
	}
}

// ---------- 飞书授权回调 ----------
// 回调地址复用后台已配置的 OAUTH_REDIRECT（默认 127.0.0.1:9768/callback），平时不占端口：
// 点「授权飞书」时临时监听，换到令牌或 10 分钟后关闭

let oauthServer: Server | undefined;
const page = (res: ServerResponse, code: number, text: string) => send(res, code, text, "text/plain; charset=utf-8");

function startOAuthCallback(): Promise<void> {
	if (oauthServer) return Promise.resolve();
	const target = new URL(OAUTH_REDIRECT);
	const server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", OAUTH_REDIRECT);
		if (url.pathname !== target.pathname) return page(res, 404, "not found");
		// state 必须是本进程刚发出去的，防止被塞进别人的授权码
		const state = url.searchParams.get("state") ?? "";
		const code = url.searchParams.get("code");
		const issued = oauthStates.get(state);
		oauthStates.delete(state);
		if (!issued || Date.now() - issued > 600_000 || !code) return page(res, 400, "授权链接无效或已过期，请回看板重新点「授权飞书」");
		try {
			await exchangeCode(code);
		} catch (e) {
			log("飞书授权失败", e);
			return page(res, 500, `授权失败：${(e as Error).message}`);
		}
		log("飞书用户授权成功");
		changed();
		res.writeHead(302, { Location: `http://127.0.0.1:${PORT}/` });
		res.end();
		closeOAuthCallback();
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(Number(target.port || 80), target.hostname, () => {
			oauthServer = server;
			setTimeout(closeOAuthCallback, 600_000).unref();
			resolve();
		});
	});
}

function closeOAuthCallback() {
	oauthServer?.close();
	oauthServer = undefined;
}

// ---------- 页面：TanStack Start 构建产物 ----------

const CLIENT_DIR = path.join(PATHS.web, "client");
const MIME: Record<string, string> = {
	".js": "text/javascript",
	".css": "text/css",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
	".json": "application/json",
};
let ssr: Promise<{ fetch: (r: Request) => Promise<Response> } | undefined> | undefined;

function loadSsr() {
	const entry = path.join(PATHS.web, "server", "server.js");
	return (ssr ??= existsSync(entry) ? import(pathToFileURL(entry).href).then((m) => m.default) : Promise.resolve(undefined));
}

function serveStatic(res: ServerResponse, pathname: string): boolean {
	const file = path.join(CLIENT_DIR, path.normalize(decodeURIComponent(pathname)));
	if (!file.startsWith(CLIENT_DIR + path.sep) || !existsSync(file) || !statSync(file).isFile()) return false;
	res.writeHead(200, {
		"Content-Type": MIME[path.extname(file)] ?? "application/octet-stream",
		"Cache-Control": pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
	});
	createReadStream(file).pipe(res);
	return true;
}

async function servePage(req: IncomingMessage, res: ServerResponse, url: URL) {
	if (serveStatic(res, url.pathname)) return;
	const app = await loadSsr();
	if (!app) return send(res, 503, "页面还没构建，先运行 pnpm build（开发时用 pnpm dev:web）", "text/plain; charset=utf-8");
	const response = await app.fetch(new Request(url, { method: req.method, headers: req.headers as HeadersInit }));
	res.writeHead(response.status, Object.fromEntries(response.headers));
	if (response.body) Readable.fromWeb(response.body as any).pipe(res);
	else res.end();
}

export function startServer() {
	const server = createServer(async (req, res) => {
		try {
			if (!localRequest(req)) return send(res, 403, { error: "forbidden" });
			const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
			if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
			if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "method not allowed" });
			await servePage(req, res, url);
		} catch (e) {
			log("HTTP 处理失败", req.url, e);
			if (!res.headersSent) send(res, 500, { error: "internal error" });
		}
	});
	server.listen(PORT, "127.0.0.1", () => log(`看板 http://127.0.0.1:${PORT}`));
	return server;
}
