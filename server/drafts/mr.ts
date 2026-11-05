// MR 预审草稿的两个后续动作：在 GitLab 上 approve、把评审报告发成 MR 评论。
// 都由 Yi 在卡片或看板上点出来（点击本身就是确认），以 Yi 的 glab 身份执行；和回复对方的草稿互不影响，草稿发出后也能点。
import { eq, inArray } from "drizzle-orm";
import { changed } from "../bus.ts";
import { GLAB_BIN } from "../config.ts";
import { db, getKv, schema, setKv } from "../db/index.ts";
import type { Draft } from "../db/schema.ts";
import { glabRepo } from "../agent/router.ts";
import { settle } from "../pipeline.ts";
import { exec, log } from "../util.ts";
import { DraftError, syncCard } from "./store.ts";

export type MrAction = "approve" | "note";

export interface DraftMr {
	project: string;
	iid: string;
	url: string;
	/** 已经做过的动作 */
	done: MrAction[];
}

const doneKey = (id: string) => `draftmr:${id}`;

/** 草稿对应的 MR：分派时记在路由的 info 里（mr 档才有） */
export function draftMrs(drafts: Array<Pick<Draft, "id" | "routeId">>): Map<string, DraftMr> {
	const ids = [...new Set(drafts.map((d) => d.routeId).filter((x): x is number => x != null))];
	const out = new Map<string, DraftMr>();
	if (!ids.length) return out;
	const routes = new Map(
		db()
			.select({ id: schema.routes.id, info: schema.routes.info })
			.from(schema.routes)
			.where(inArray(schema.routes.id, ids))
			.all()
			.map((r) => [r.id, r.info]),
	);
	for (const d of drafts) {
		const info = d.routeId != null ? routes.get(d.routeId) : undefined;
		if (!info?.mrIid || !info.mrProject) continue;
		out.set(d.id, {
			project: info.mrProject,
			iid: info.mrIid,
			url: `https://${glabRepo(info.mrProject)}/-/merge_requests/${info.mrIid}`,
			done: getKv<MrAction[]>(doneKey(d.id), []),
		});
	}
	return out;
}

export async function applyMrAction(id: string, action: MrAction): Promise<void> {
	const d = db().select().from(schema.drafts).where(eq(schema.drafts.id, id)).get();
	if (!d) throw new DraftError("草稿不存在");
	const mr = draftMrs([d]).get(id);
	if (!mr) throw new DraftError("这条草稿不是 MR 预审，没有对应的 MR");
	if (mr.done.includes(action)) throw new DraftError(action === "approve" ? "已经 approve 过了" : "评审意见已经发到 MR 上了");
	const repo = glabRepo(mr.project);
	if (action === "note" && !d.report.trim()) throw new DraftError("这条草稿没有评审报告");
	const args =
		action === "approve" ? ["mr", "approve", mr.iid, "-R", repo] : ["mr", "note", "create", mr.iid, "-R", repo, "-m", d.report.trim()];
	try {
		await exec(GLAB_BIN, args, { timeout: 60 });
	} catch (e) {
		log("MR 操作失败", action, mr.project, mr.iid, e);
		throw new DraftError(`${action === "approve" ? "approve" : "发评论"}没有成功：${String((e as Error).message).slice(0, 300)}`);
	}
	setKv(doneKey(id), [...mr.done, action]);
	settle({
		actionKind: "draft",
		actionId: id,
		routeId: d.routeId,
		outcome: action === "approve" ? "mr_approved" : "mr_noted",
		effect: "outward",
		ref: mr.url,
	});
	log("MR", action, mr.project, mr.iid);
	syncCard(id);
	changed();
}
