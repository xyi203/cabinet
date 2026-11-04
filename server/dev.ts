// 开发任务：Yi 在看板上把需求指派给 dev agent。
// 每个任务一个 git worktree（data/worktrees/），基于仓库默认分支建 feature/fix 分支；agent 只能写这个 worktree、
// 只能做本地 git 提交。推送和建 MR 只在 Yi 点「推送并建 MR」后由 cabinet 执行，目标分支是基准分支。
import { eq } from "drizzle-orm";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { abortRun, forgetRun, runPi, steer } from "./agent/driver.ts";
import { modelOptions } from "./agent/models.ts";
import { changed } from "./bus.ts";
import { DATA_DIR, DEFAULT_CWD, GLAB_BIN, OWNER_OPEN_ID, PORT } from "./config.ts";
import { db, deleteKv, getKv, listKv, schema, setKv } from "./db/index.ts";
import { queuePatch, sendCardToUserAsBot, sendToUserAsBot } from "./lark/bot.ts";
import { devCard, devTitle, type Round } from "./devcard.ts";
import { decide, receive, settle } from "./pipeline.ts";
import type { DevTask } from "./db/schema.ts";
import { DraftError, getDraft } from "./drafts/store.ts";
import { sem } from "./agent/slots.ts";
import { loadAgents } from "./agent/router.ts";
import { exec, isStopping, log, now } from "./util.ts";

const WORKTREES = path.join(DATA_DIR, "worktrees");
export const BRANCH_RE = /^(feature|fix)\/[a-z0-9]+$/;

const git = (cwd: string, args: string[], timeout = 60) => exec("git", ["-C", cwd, ...args], { timeout });

/** DEFAULT_CWD 下的 git 仓库（按最近修改排序） */
export function listRepos(): string[] {
	if (!existsSync(DEFAULT_CWD)) return [];
	return readdirSync(DEFAULT_CWD, { withFileTypes: true })
		.filter((d) => d.isDirectory() && !d.name.startsWith(".") && existsSync(path.join(DEFAULT_CWD, d.name, ".git")))
		.map((d) => ({ name: d.name, t: statSync(path.join(DEFAULT_CWD, d.name)).mtimeMs }))
		.toSorted((a, b) => b.t - a.t)
		.map((d) => d.name);
}

export function getDevTask(id: string): DevTask | undefined {
	return db().select().from(schema.devTasks).where(eq(schema.devTasks.id, id)).get();
}

function update(id: string, set: Partial<DevTask>) {
	db()
		.update(schema.devTasks)
		.set({ ...set, updated: now() })
		.where(eq(schema.devTasks.id, id))
		.run();
	changed();
	if (set.status !== undefined) syncDevCard(id);
}

// ---------- 通知卡片：devcard:<消息 id> 记这张卡片是哪个任务的哪一轮，devcard-latest:<任务 id> 指向最新的一张 ----------

interface SentCard {
	id: string;
	round: Round;
}
const cardOf = (msgId: string) => getKv<SentCard | null>(`devcard:${msgId}`, null);
const latestCard = (id: string) => getKv<string | null>(`devcard-latest:${id}`, null);

/** 按任务当前状态重画一张通知卡片；只有最新的那张带按钮 */
export function renderDevCard(msgId: string, notice = ""): object | undefined {
	const sent = cardOf(msgId);
	const t = sent && getDevTask(sent.id);
	return t ? devCard(t, sent.round, latestCard(t.id) === msgId, notice) : undefined;
}

export function syncDevCard(id: string, notice = "") {
	const msgId = latestCard(id);
	if (msgId) queuePatch(msgId, () => renderDevCard(msgId, notice));
}

/** 远端默认分支（origin/HEAD），取不到时按 develop / master 顺序找 */
async function baseBranch(repo: string): Promise<string> {
	try {
		return (await git(repo, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).trim().replace(/^origin\//, "");
	} catch {
		for (const b of ["develop", "master", "main"]) {
			try {
				await git(repo, ["rev-parse", "--verify", `origin/${b}`]);
				return b;
			} catch {}
		}
	}
	throw new DraftError("找不到仓库的默认分支");
}

export interface DispatchInput {
	/** 从草稿（需求消息）指派时有；在 Agent 看板上直接新建时没有 */
	draftId?: string;
	/** 默认 dev */
	agent?: string;
	/** 没有草稿时的任务内容 */
	request?: string;
	repo?: string;
	branch?: string;
	instructions?: string;
	/** 不填用 agent 配置 */
	model?: string;
	thinking?: string;
	/** 不是看板派的活（比如一批告警）：挂在这些 trigger 上，按 rule 记分派 */
	triggers?: string[];
	rule?: string;
	title?: string;
	/** 每轮结束都私聊 Yi（不是 Yi 在看板上派的活） */
	notify?: boolean;
}

/** 校验新建时选的模型和思考强度 */
function checkModel(model?: string, thinking?: string) {
	if (!model && !thinking) return;
	const opt = model ? modelOptions().find((m) => m.id === model) : undefined;
	if (model && !opt) throw new DraftError(`没有模型 ${model}`);
	if (thinking && opt && !opt.levels.includes(thinking))
		throw new DraftError(`${model} 不支持 effort=${thinking}（可选：${opt.levels.join("/")}）`);
}

const isDev = (t: Pick<DevTask, "agent">) => t.agent === "dev";

/** 看板派活（或从草稿转成任务）是一条 Yi 发起的 trigger，直接分派给选定的 agent；别处来的活带着自己的 trigger */
function routeTask(id: string, agent: string, request: string, input: DispatchInput): number {
	if (input.triggers?.length) return decide(input.triggers, { agent, rule: input.rule ?? "派活", actionKind: "dev", actionId: id });
	const tid = receive({ channel: "board", externalId: id, thread: `board:${id}`, actorId: OWNER_OPEN_ID, owner: true, text: request });
	return decide([tid], { agent, rule: input.draftId ? `草稿转任务（${input.draftId}）` : "看板派活", actionKind: "dev", actionId: id });
}

export async function dispatch(input: DispatchInput): Promise<DevTask> {
	const agentName = input.agent || "dev";
	const agentConfig = loadAgents().agents[agentName];
	if (!agentConfig) throw new DraftError(`没有 agent ${agentName}`);
	const d = input.draftId ? getDraft(input.draftId) : undefined;
	if (input.draftId && !d) throw new DraftError("草稿不存在");
	const request = (d?.text ?? input.request ?? "").trim();
	if (!request) throw new DraftError("任务内容是空的");
	if (input.repo && !listRepos().includes(input.repo)) throw new DraftError(`${DEFAULT_CWD} 下没有仓库 ${input.repo}`);
	checkModel(input.model, input.thinking);
	const choice = { model: input.model || null, thinking: input.thinking || null };
	if (agentName !== "dev") {
		// 只读 agent：不建 worktree，选了仓库就在仓库目录里查
		const t = now();
		const id = `dev-${Date.now()}`;
		const task: DevTask = {
			id,
			agent: agentName,
			...choice,
			draftId: d?.id ?? null,
			title: (input.title ?? request).slice(0, 200),
			request,
			context: d?.context ?? "",
			instructions: input.instructions?.trim() ?? "",
			repo: input.repo ? path.join(DEFAULT_CWD, input.repo) : "",
			base: "",
			branch: "",
			worktree: "",
			status: "running",
			summary: "",
			error: null,
			mrUrl: null,
			session: null,
			runs: 0,
			usage: null,
			created: t,
			updated: t,
			routeId: routeTask(id, agentName, request, input),
			notify: Boolean(input.notify),
		};
		db().insert(schema.devTasks).values(task).run();
		changed();
		log("agent 任务", task.id, agentName);
		void runDev(task.id);
		return task;
	}
	if (!input.repo) throw new DraftError("开发任务要选仓库");
	if (!input.branch || !BRANCH_RE.test(input.branch))
		throw new DraftError("分支名只能是 feature/<一个单词> 或 fix/<一个单词>，单词里只用小写字母和数字");
	if (!listRepos().includes(input.repo)) throw new DraftError(`${DEFAULT_CWD} 下没有仓库 ${input.repo}`);
	const repo = path.join(DEFAULT_CWD, input.repo);
	const base = await baseBranch(repo);
	// 基于远端最新的基准分支开新分支，不动本地工作区
	await git(repo, ["fetch", "origin", base], 120);
	const exists = await git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${input.branch}`]).then(
		() => true,
		() => false,
	);
	if (exists) throw new DraftError(`本地已经有分支 ${input.branch}，换个名字`);
	const worktree = path.join(WORKTREES, `${input.repo}-${input.branch.split("/")[1]}`);
	if (existsSync(worktree)) throw new DraftError(`目录已存在：${worktree}`);
	mkdirSync(WORKTREES, { recursive: true });
	await git(repo, ["worktree", "add", "-b", input.branch, worktree, `origin/${base}`], 120);
	const t = now();
	const id = `dev-${Date.now()}`;
	const task: DevTask = {
		id,
		agent: "dev",
		...choice,
		draftId: d?.id ?? null,
		title: request.slice(0, 200),
		request,
		context: d?.context ?? "",
		instructions: input.instructions?.trim() ?? "",
		repo,
		base,
		branch: input.branch,
		worktree,
		status: "running",
		summary: "",
		error: null,
		mrUrl: null,
		session: null,
		runs: 0,
		usage: null,
		created: t,
		updated: t,
		routeId: routeTask(id, "dev", request, input),
		notify: Boolean(input.notify),
	};
	db().insert(schema.devTasks).values(task).run();
	changed();
	log("开发任务", task.id, input.repo, input.branch);
	void runDev(task.id);
	return task;
}

// Yi 点了「停止」的任务：这次运行以失败返回时不算失败
const stoppedByYi = new Set<string>();
const sessionOf = (id: string) => `dev-${id}`;

/** 跑一轮 dev agent：首轮按需求实现，之后是 Yi 发来的消息（要求、问题、纠偏） */
async function runDev(id: string, opinion?: string, from = "Yi") {
	const task = getDevTask(id)!;
	const run = task.runs + 1;
	const pendingKey = `pending:dev:${id}`;
	setKv(pendingKey, { id, opinion, run, from });
	update(id, { status: "running", error: null, runs: run });
	const started = now();
	const base = loadAgents().agents[task.agent];
	// 新建时选的模型和思考强度覆盖 agent 配置，之后每一轮都沿用
	const agent = base && { ...base, ...(task.model ? { model: task.model } : {}), ...(task.thinking ? { thinking: task.thinking } : {}) };
	const dev = isDev(task);
	const where = task.repo ? `仓库 \`${path.basename(task.repo)}\`（当前目录）` : `\`${DEFAULT_CWD}\`（各仓库都在这下面）`;
	const prompt = !dev
		? opinion
			? `${from}：${opinion}`
			: [
					`${base?.brief ?? "[Agent 任务] 这是 Yi 本人在看板上直接交给你的任务，直接回答 Yi，不是替他起草回复。"}工作目录：${where}。`,
					task.context ? `相关前文：\n${task.context}` : "",
					`任务：\n${task.request}`,
					task.instructions ? `补充说明：\n${task.instructions}` : "",
					`（这个任务的 ID：${task.id}${task.routeId ? `，分派 route:${task.routeId}` : ""}；需要以前的来龙去脉时用 lookup 沿 ID 查）`,
				]
					.filter(Boolean)
					.join("\n\n")
		: opinion
			? `Yi：${opinion}\n\n（这是 Yi 的消息：是问题就直接回答；要改代码就改完提交，并在回复末尾给出更新后的总结。）`
			: [
					`[开发任务] 仓库 \`${path.basename(task.repo)}\`，分支 \`${task.branch}\`（基于 origin/${task.base}），工作目录就是这个仓库的 worktree。`,
					task.context ? `需求的相关前文：\n${task.context}` : "",
					task.draftId ? `同事提给 Yi 的需求：\n${task.request}` : `Yi 的需求：\n${task.request}`,
					task.instructions ? `Yi 的补充说明（以这个为准）：\n${task.instructions}` : "",
					"请按 dev agent 的规则实现并提交。",
				]
					.filter(Boolean)
					.join("\n\n");
	let interrupted = false;
	try {
		if (!agent) throw new Error(`agents.json 里没有 ${task.agent} agent`);
		const { text, usage, sessionId } = await sem.run(() =>
			runPi({
				cwd: task.worktree || task.repo || DEFAULT_CWD,
				sessionId: sessionOf(id),
				requestId: `dev:${id}:${run}`,
				prompt,
				agent,
				agentName: task.agent,
				label: dev ? `开发 · ${path.basename(task.repo)}` : `${task.agent} · ${task.title.slice(0, 20)}`,
				chatId: id,
				// 只有 dev agent 能写，而且只能写自己的 worktree
				writeRoots: dev ? [task.worktree] : undefined,
				// 结论只私聊给 Yi：可以沿 ID 查以前的消息、分派和结果
				lookup: true,
				memory: { query: opinion ?? `${task.title}\n${task.request}`.slice(0, 1000), scope: {} },
			}),
		);
		const prev = task.usage;
		const total = prev
			? {
					input: prev.input + usage.input,
					output: prev.output + usage.output,
					cacheRead: prev.cacheRead + usage.cacheRead,
					cost: prev.cost + usage.cost,
				}
			: usage;
		update(id, { status: "review", summary: text, session: sessionId, usage: total });
		if (dev || base?.notify || task.notify || now() - started > 60) void notify(id, `第 ${run} 轮完成`, text);
	} catch (e) {
		if (isStopping()) interrupted = true;
		else if (stoppedByYi.delete(id)) update(id, { status: "review", error: "已按你的要求停止" });
		else {
			log("开发任务失败", id, e);
			const error = String((e as Error).message).slice(0, 500);
			update(id, { status: "failed", error });
			void notify(id, `第 ${run} 轮失败`, error, true);
		}
	} finally {
		if (!interrupted) {
			deleteKv(pendingKey);
			forgetRun(`dev:${id}:${run}`);
		}
	}
}

/** 每轮结束私聊 Yi 一张卡片；卡片里能直接操作，引用它回复也是直接和 agent 对话 */
async function notify(id: string, what: string, body: string, failed = false) {
	const t = getDevTask(id);
	if (!t) return;
	const round: Round = { what, body, failed };
	let dm: string;
	try {
		dm = await sendCardToUserAsBot(OWNER_OPEN_ID, devCard(t, round));
	} catch (e) {
		// 卡片被拒也不能漏掉通知：退回富文本
		log("任务卡片发送失败，改发文字", id, e);
		const md = [
			`**${devTitle(t)}** · ${what}`,
			body.length > 1500 ? `${body.slice(0, 1500)}…` : body,
			isDev(t)
				? `引用本条回复：直接写要求或问题会发给 agent；\`推送\` 推送并建 MR；\`停止\`；\`放弃\`。完整 diff 在看板：http://127.0.0.1:${PORT}/?view=agents`
				: `引用本条回复可以继续追问；\`停止\`；\`完成\` 归档。看板：http://127.0.0.1:${PORT}/?view=agents`,
		].join("\n\n");
		try {
			setKv(`devdm:${await sendToUserAsBot(OWNER_OPEN_ID, md)}`, id);
		} catch (e2) {
			log("开发任务通知失败", id, e2);
		}
		return;
	}
	const prev = latestCard(id);
	setKv(`devcard:${dm}`, { id, round } satisfies SentCard);
	setKv(`devcard-latest:${id}`, dm);
	setKv(`devdm:${dm}`, id);
	// 上一轮的卡片收起按钮：操作只认最新的一张
	if (prev) queuePatch(prev, () => renderDevCard(prev));
}

/** 飞书里引用了哪条开发任务通知 */
export const devTaskOfDm = (dmId?: string) => (dmId ? (getKv<string | null>(`devdm:${dmId}`, null) ?? undefined) : undefined);

/**
 * Yi 发给 agent 的消息：正在运行就插进当前这轮（下一个工具步骤之后生效），空闲就开新一轮。
 */
export async function messageDev(id: string, text: string, from = "Yi"): Promise<"steered" | "started"> {
	const t = getDevTask(id);
	if (!t) throw new DraftError("任务不存在");
	if (!text.trim()) throw new DraftError("消息是空的");
	if (t.status === "discarded") throw new DraftError("任务已放弃");
	if (t.status === "done") throw new DraftError("任务已完成，新建一个吧");
	if (t.status === "pushing") throw new DraftError("正在推送，等一下再发");
	if (t.status === "running" && (await steer(sessionOf(id), `${from}：${text.trim()}`))) {
		log("开发任务插话", id, from);
		return "steered";
	}
	void runDev(id, text.trim(), from);
	return "started";
}

export async function stopDev(id: string) {
	const t = getDevTask(id);
	if (!t) throw new DraftError("任务不存在");
	if (t.status !== "running") throw new DraftError("任务没有在运行");
	stoppedByYi.add(id);
	await abortRun(sessionOf(id));
}

export function resumePendingDev() {
	for (const { value } of listKv<{ id: string; opinion?: string; run: number; from?: string }>("pending:dev:")) {
		const task = getDevTask(value.id);
		if (!task) continue;
		log("接回未完成的开发任务", value.id);
		// runs 已经 +1 过：退回去让 runDev 用同一个 run 序号和 requestId
		update(value.id, { runs: value.run - 1 });
		void runDev(value.id, value.opinion, value.from);
	}
}

export interface DevDiff {
	commits: string;
	stat: string;
	diff: string;
	uncommitted: string;
}

export async function devDiff(id: string): Promise<DevDiff> {
	const t = getDevTask(id);
	if (!t || !isDev(t)) throw new DraftError("只有开发任务有改动");
	if (!existsSync(t.worktree)) throw new DraftError("worktree 已不存在");
	const range = `origin/${t.base}...HEAD`;
	const [commits, stat, diff, uncommitted] = await Promise.all([
		git(t.worktree, ["log", "--oneline", `origin/${t.base}..HEAD`]),
		git(t.worktree, ["diff", "--stat", range]),
		git(t.worktree, ["diff", range]),
		git(t.worktree, ["status", "--porcelain"]),
	]);
	return {
		commits: commits.trim(),
		stat: stat.trim(),
		diff: diff.length > 300_000 ? `${diff.slice(0, 300_000)}\n…（diff 过长已截断）` : diff,
		uncommitted: uncommitted.trim(),
	};
}

/** Yi 确认后才执行：推送分支，用 glab 建 MR 到基准分支 */
export async function pushDev(id: string): Promise<string> {
	const t = getDevTask(id);
	if (!t) throw new DraftError("任务不存在");
	if (!isDev(t)) throw new DraftError("只有开发任务能推送");
	if (t.status !== "review" && t.status !== "pushed") throw new DraftError(`任务现在是「${t.status}」，不能推送`);
	const { commits, uncommitted } = await devDiff(id);
	if (!commits) throw new DraftError("还没有提交，没有可推送的改动");
	if (uncommitted) throw new DraftError("worktree 里还有未提交的改动，先让 agent 提交或放弃");
	update(id, { status: "pushing" });
	try {
		await git(t.worktree, ["push", "-u", "origin", t.branch], 120);
		// MR 已经建过：只推新提交，MR 会自动更新
		if (t.mrUrl) {
			update(id, { status: "pushed", error: null });
			settle({ actionKind: "dev", actionId: id, routeId: t.routeId, outcome: "pushed", effect: "outward", ref: t.mrUrl });
			return t.mrUrl;
		}
		const title = commits
			.split("\n")
			.at(-1)!
			.replace(/^\w+\s+/, "");
		const out = await exec(
			GLAB_BIN,
			[
				"mr",
				"create",
				"--source-branch",
				t.branch,
				"--target-branch",
				t.base,
				"--title",
				title,
				"--description",
				t.summary.slice(0, 20_000),
				"--remove-source-branch",
				"--yes",
			],
			{ cwd: t.worktree, timeout: 120 },
		);
		const url = /https?:\/\/\S+\/merge_requests\/\d+/.exec(out)?.[0] ?? "";
		update(id, { status: "pushed", mrUrl: url, error: null });
		settle({ actionKind: "dev", actionId: id, routeId: t.routeId, outcome: "pushed", effect: "outward", ref: url });
		log("开发任务已推送", id, url);
		return url;
	} catch (e) {
		update(id, { status: "review", error: `推送失败：${String((e as Error).message).slice(0, 400)}` });
		throw new DraftError(`推送失败：${(e as Error).message}`);
	}
}

/** 放弃：删掉 worktree 和本地分支（已推送的不删远端） */
export async function discardDev(id: string) {
	const t = getDevTask(id);
	if (!t) throw new DraftError("任务不存在");
	if (t.status === "running" || t.status === "pushing") throw new DraftError("任务正在运行，等它结束再放弃");
	if (isDev(t)) {
		if (existsSync(t.worktree)) await git(t.repo, ["worktree", "remove", "--force", t.worktree]);
		if (t.status !== "pushed") await git(t.repo, ["branch", "-D", t.branch]).catch(() => {});
	}
	update(id, { status: "discarded" });
	settle({ actionKind: "dev", actionId: id, routeId: t.routeId, outcome: "discarded", effect: isDev(t) ? "local" : "internal" });
}

export const devTasksList = () => db().select().from(schema.devTasks).all();

/** 只读 agent 的任务看完了：归档 */
export function closeTask(id: string) {
	const t = getDevTask(id);
	if (!t) throw new DraftError("任务不存在");
	if (t.status === "running") throw new DraftError("任务正在运行");
	update(id, { status: "done" });
	settle({ actionKind: "dev", actionId: id, routeId: t.routeId, outcome: "done", effect: "internal" });
}
