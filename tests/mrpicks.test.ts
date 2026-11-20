// 一条消息里好几个 MR、@ 了好几个人：只挑点给 Yi 的，每个各审一份（drafts/mr.ts mrPicks）
import assert from "node:assert/strict";
import { test } from "node:test";
const { openDb, useDb } = await import("../server/db/index.ts");
useDb(openDb(":memory:"));
const { mrPicks } = await import("../server/drafts/mr.ts");

const YI = { key: "@_user_1", id: "ou_yi", name: "向懿" };
const OY = { key: "@_user_2", id: "ou_oy", name: "欧阳嘉威" };
const mr = (p: string, i: number) => `https://gitlab.shoplazza.site/${p}/-/merge_requests/${i}`;
const picks = (content: string, mentions = [YI]) => mrPicks([{ content, mentions }], "ou_yi");

test("11-20 告警调整：@Yi 两个、@欧阳嘉威 两个，只挑前两个", () => {
	const text =
		`@向懿 帮忙 review 下告警调整\n${mr("devops/exporter/gorilla", 684)}/diffs\n${mr("devops/alerts/alertdashboard-aws-production", 1378)}/diffs\n\n` +
		`@欧阳嘉威 帮忙 review 下熔断规则调整，没问题就找 sre 直接改了\n${mr("shoplaza/backend/promotion/discount-app", 951)}/diffs\n${mr("shoplaza/backend/promotion/rosefinch", 2107)}`;
	assert.deepEqual(picks(text, [YI, OY]), [
		"gitlab:devops/exporter/gorilla!684",
		"gitlab:devops/alerts/alertdashboard-aws-production!1378",
	]);
});

test("点给 Yi 的在后面一段", () => {
	const text = `@欧阳嘉威 看下 ${mr("a/b", 1)}\n@向懿 看下 ${mr("a/c", 2)} ${mr("a/d", 3)}`;
	assert.deepEqual(picks(text, [YI, OY]), ["gitlab:a/c!2", "gitlab:a/d!3"]);
});

test("连着 @ 两个人算一组：都要看", () => {
	const text = `@欧阳嘉威 @向懿 帮忙看下 ${mr("a/b", 1)} ${mr("a/c", 2)}`;
	assert.deepEqual(picks(text, [YI, OY]), ["gitlab:a/b!1", "gitlab:a/c!2"]);
});

test("链接在 @ 前面：归第一组", () => {
	assert.deepEqual(picks(`${mr("a/b", 1)} ${mr("a/c", 2)} @向懿 帮忙看下`, [YI]), ["gitlab:a/b!1", "gitlab:a/c!2"]);
	assert.deepEqual(picks(`${mr("a/b", 1)} @欧阳嘉威 看下\n@向懿 看下 ${mr("a/c", 2)}`, [YI, OY]), ["gitlab:a/c!2"]);
	assert.deepEqual(picks(`${mr("a/b", 1)} @向懿 看下\n@欧阳嘉威 看下 ${mr("a/c", 2)}`, [YI, OY]), ["gitlab:a/b!1"]);
});

test("只 @Yi、私聊没 @：全算，同一个 MR 去重", () => {
	assert.deepEqual(picks(`@向懿 ${mr("a/b", 1)} ${mr("a/c", 2)} ${mr("a/b", 1)}#note_1`), ["gitlab:a/b!1", "gitlab:a/c!2"]);
	assert.deepEqual(picks(`${mr("a/b", 1)}\n${mr("a/c", 2)}`, []), ["gitlab:a/b!1", "gitlab:a/c!2"]);
});

test("@ 了别人、正文里认不出 @Yi：全算，宁可多审", () => {
	assert.deepEqual(picks(`@欧阳嘉威 看下 ${mr("a/b", 1)} ${mr("a/c", 2)}`, [OY]), ["gitlab:a/b!1", "gitlab:a/c!2"]);
});
