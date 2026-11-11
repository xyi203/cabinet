import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { Guard, RULES_FILE, WORK_TMP, loadRules, mcpReadOnly, rememberRead, tokenize } from "../server/agent/guard.ts";

const root = mkdtempSync(path.join(tmpdir(), "cabinet-guard-"));
const repo = path.join(root, "repo");
const skills = path.join(root, "skills");
mkdirSync(repo);
mkdirSync(path.join(skills, "archery/scripts"), { recursive: true });
writeFileSync(path.join(repo, "a.go"), "package a");
writeFileSync(path.join(repo, ".env"), "SECRET=1");
symlinkSync("/etc", path.join(repo, "etc-link"));

const guard = (bash: string[]) => new Guard({ roots: [repo, path.join(skills, "archery")], bash, skillsDir: skills });
const g = guard(["git", "glab", "meegle", "archery"]);
const allow = (cmd: string, gg = g) => assert.equal(gg.check("bash", { command: cmd }, repo), undefined, cmd);
const deny = (cmd: string, gg = g) => assert.notEqual(gg.check("bash", { command: cmd }, repo), undefined, cmd);

test("读文件限制在根目录内，排除凭证与软链逃逸", () => {
	assert.equal(g.check("read", { path: "a.go" }, repo), undefined);
	assert.ok(g.check("read", { path: ".env" }, repo));
	assert.ok(g.check("read", { path: "/etc/hosts" }, repo));
	assert.ok(g.check("read", { path: "etc-link/hosts" }, repo));
	assert.ok(g.check("grep", { path: "../" }, repo));
	assert.ok(g.check("write", { path: "a.go" }, repo));
	assert.ok(g.check("edit", { path: "a.go" }, repo));
});

test("普通命令直接放行；复合命令逐段判，受管命令照规则，要审批的不能连写，也不能藏进 bash -c / $(…)", () => {
	allow("cat a.go | wc -l");
	allow("python3 -c 1");
	allow("ls *");
	allow("bash ./scripts/test.sh");
	allow("git log | head");
	allow("git log > /tmp/x 2>&1");
	allow("cd sub && git status");
	allow(`grep -rn "glab" .`);
	deny("git log; git push origin HEAD");
	deny("git log && glab mr note 1 -m x");
	deny("glab mr note 1 -m x | cat");
	deny('bash -c "glab mr approve 1"');
	deny("echo $(glab mr approve 1)");
	deny("env FOO=1 glab mr merge 1");
	deny("git log $(whoami)");
	assert.deepEqual(tokenize(`git log --grep "a (b) c"`), ["git", "log", "--grep", "a (b) c"]);
});

test("git 只读", () => {
	allow("git log --oneline -5");
	allow("git show HEAD:a.go");
	allow(`git -C ${repo} diff`);
	allow("git branch -a");
	deny("git push");
	deny("git commit -m x");
	deny("git branch -D main");
	deny("git diff --output=/tmp/x");
	deny("git diff --no-index /etc/passwd a.go");
	deny("git -c core.pager=sh log");
	deny("git -C /etc log");
});

test("glab 只看不改", () => {
	allow("glab mr view 12 -R a/b");
	allow("glab mr diff 12 -R a/b");
	allow("glab api projects/1/merge_requests/2/notes");
	deny("glab mr merge 12");
	deny("glab mr note 12 -m hi");
	deny("glab api -X POST projects/1/merge_requests/2/notes");
	deny("glab api projects/1/merge_requests/2/notes -f body=x");
});

test("meegle 与 skill 脚本只放行查询类子命令", () => {
	allow("meegle workitem get --project-key p --work-item-id 1");
	deny("meegle comment add --params {}");
	deny("meegle comment list --params x");
	const input = { command: "scripts/archery instances" };
	assert.equal(g.check("bash", input, repo), undefined);
	assert.equal(input.command, `${path.join(skills, "archery/scripts/archery")} instances`);
	allow("archery query --env prod");
	deny("archery login");
	deny("archery workflow submit");
});

test("未启用的命令族一律拒绝", () => {
	const gitOnly = guard(["git"]);
	deny("glab mr view 1", gitOnly);
	deny("meegle workitem get", gitOnly);
	deny("archery instances", gitOnly);
	// 不归规则管的普通命令照样能跑
	allow("cat a.go", gitOnly);
	allow("python3 -c 1", gitOnly);
});

test("开发任务：只能写自己的 worktree，git 只放本地写操作", () => {
	const wt = path.join(root, "wt");
	mkdirSync(path.join(wt, "pkg"), { recursive: true });
	const dev = new Guard({
		roots: [repo],
		bash: ["git", "git-local"],
		skillsDir: skills,
		writeRoots: [wt],
		commands: ["go test", "go build"],
	});
	assert.equal(dev.check("write", { path: "pkg/new.go" }, wt), undefined);
	assert.equal(dev.check("edit", { path: path.join(wt, "pkg/a.go") }, wt), undefined);
	assert.ok(dev.check("write", { path: path.join(repo, "a.go") }, wt), "不能写 worktree 外");
	assert.ok(dev.check("write", { path: "../repo/a.go" }, wt));
	assert.ok(dev.check("write", { path: ".env" }, wt), "凭证文件也不能写");
	assert.ok(g.check("write", { path: "a.go" }, repo), "只读 agent 不能写");
	const ok = (cmd: string, cwd = wt) => assert.equal(dev.check("bash", { command: cmd }, cwd), undefined, cmd);
	const no = (cmd: string, cwd = wt) => assert.notEqual(dev.check("bash", { command: cmd }, cwd), undefined, cmd);
	ok("git add -A");
	ok('git commit -m "加筛选条件"');
	ok("go test ./...");
	ok("go build ./pkg/...");
	no("git push origin HEAD");
	no("git fetch");
	no("git checkout master");
	no("git reset --hard HEAD~1");
	no("git add -A", repo);
	no("go test ./...", repo);
	ok(`go -C ${wt} test ./...`, repo);
	no(`go -C ${repo} test ./...`, wt);
	no("go test /etc/...");
	// 构建命令之外的命令不受限
	ok("go run main.go");
});

test("lark-cli：读文档和知识库放行，建 / 改文档走审批，只许 --as user", () => {
	const gl = guard(["lark-cli"]);
	const kind = (cmd: string) => gl.verdict("bash", { command: cmd }, repo).kind;
	allow("lark-cli docs +fetch --doc https://x.feishu.cn/docx/abc --doc-format markdown", gl);
	allow("lark-cli wiki +node-list --as user --parent-node-token Oh6", gl);
	allow("lark-cli docs +fetch --doc abc --as=user", gl);
	assert.equal(kind("lark-cli docs +create --as user --parent-token Oh6 --title 'x' --content '# 背景'"), "approve");
	assert.equal(kind("lark-cli docs +update --doc abc --content 'x'"), "approve");
	assert.equal(kind("lark-cli wiki +node-create --space-id 1 --title x"), "approve");
	deny("lark-cli im +messages-send --chat-id oc_1 --text hi", gl);
	deny("lark-cli wiki +delete-space --space-id 1", gl);
	deny("lark-cli docs +fetch --doc abc --as bot", gl);
	deny("lark-cli docs +fetch --doc abc --as=bot", gl);
	deny("lark-cli docs +fetch --doc abc --as", gl);
	deny("lark-cli docs +fetch --doc abc -o out.md", gl);
	deny("lark-cli docs +fetch --doc abc", g);
});

test("告警 agent 的 grafana / oncall：只放查询，不放改配置", () => {
	const ga = guard(["grafana", "oncall"]);
	allow("scripts/grafana alerts", ga);
	allow("scripts/grafana query --expr 'rate(http_requests_total[5m])' --from now-1h --to now", ga);
	allow("scripts/oncall analyze --card-text '告警 A'", ga);
	allow("scripts/oncall pd alerts --id Q2J7M19NFMR8DY", ga);
	deny("scripts/grafana config set --name x --url y --cookie z", ga);
	deny("scripts/oncall aggregate --file a.ndjson", ga);
	// 没给这个 agent 的 skill 不放
	deny("scripts/grafana alerts", guard(["archery"]));
});

test("lookup 只给允许的会话：群里问答的会话拦下", () => {
	assert.ok(guard([]).check("lookup", { id: "lark:om_x" }, repo));
	const allowed = new Guard({ roots: [repo], bash: [], skillsDir: skills, lookup: true });
	assert.equal(allowed.check("lookup", { id: "lark:om_x" }, repo), undefined);
});

test("MCP：只放行 agent 配了的 server 的工具，codemode 只给配了 MCP 的会话", () => {
	const withMcp = new Guard({ roots: [], bash: [], skillsDir: "/nonexistent", mcp: ["prometheus-saas-cluster"] });
	mcpReadOnly.add("mcp__prometheus-saas-cluster__execute_query");
	assert.equal(withMcp.check("mcp__prometheus-saas-cluster__execute_query", {}, "/"), undefined);
	// 没声明只读的按写操作：要审批
	assert.equal(withMcp.verdict("mcp__prometheus-saas-cluster__drop_series", {}, "/").kind, "approve");
	assert.equal(withMcp.check("codemode", { code: "1" }, "/"), undefined);
	assert.match(withMcp.check("mcp__devops-mcp-prod__issue_create", {}, "/") ?? "", /未在白名单/);
	const plain = new Guard({ roots: [], bash: [], skillsDir: "/nonexistent" });
	assert.match(plain.check("codemode", { code: "1" }, "/") ?? "", /未在白名单/);
	assert.match(plain.check("mcp__prometheus-saas-cluster__execute_query", {}, "/") ?? "", /未在白名单/);
});

test("命令三态：read 放行，write 和没列出的子命令要审批，deny 拒绝", () => {
	const ga = new Guard({ roots: [repo], bash: "*", skillsDir: skills });
	const v = (cmd: string) => ga.verdict("bash", { command: cmd }, repo).kind;
	assert.equal(v(`${skills}/archery/scripts/archery query --env prod --sql "select 1"`), "allow");
	assert.equal(v(`${skills}/archery/scripts/archery submit --sql "update t set a=1"`), "approve");
	assert.equal(v(`${skills}/archery/scripts/archery login`), "deny");
	assert.equal(v(`${skills}/archery/scripts/archery export`), "approve");
	assert.equal(v("glab mr note 12 -R gitlab.shoplazza.site/a/b -m ok"), "approve");
	assert.equal(v("glab api projects/1"), "allow");
	assert.equal(v("glab api -X POST projects/1/notes"), "approve");
	assert.match(ga.check("bash", { command: "glab mr note 12 -m ok" }, repo) ?? "", /需要 Yi 审批.*还没上线/);
	// "*" 包含 git 和规则文件里的全部命令族
	assert.equal(v("git log -1"), "allow");
	// 只写脚本名也认（改写成 skill 里的绝对路径），没列出的子命令要审批
	assert.equal(v("kafka topics"), "allow");
	assert.equal(v("kafka produce --topic x"), "approve");
});

test("规则文件：每条都有 argv0，子命令不在 read 和 write 里重复", () => {
	const rules = loadRules("/skills");
	assert.ok(Object.keys(rules).length >= 10);
	for (const [name, r] of Object.entries(rules)) {
		assert.ok(r.argv0.length, name);
		const read = new Set(r.read.map((w) => w.join(" ")));
		for (const w of r.write) assert.ok(!read.has(w.join(" ")), `${name} ${w.join(" ")}`);
	}
	assert.ok(rules.archery.argv0[0].startsWith("/skills/"));
	assert.ok(RULES_FILE.endsWith("config/skill-rules.json"));
});

test("数组里的 * 展开成全部命令族，再加上别的（dev 的 git-local）", () => {
	const gd = new Guard({ roots: [repo], bash: ["*", "git-local"], skillsDir: skills });
	assert.ok(gd.enabled.has("git-local") && gd.enabled.has("archery") && gd.enabled.has("glab"));
});

test("工具输出太长时存的临时文件可以读，临时目录里的其他文件不行", async () => {
	const { realpathSync } = await import("node:fs");
	const tmp = realpathSync(tmpdir());
	const spill = path.join(tmp, "tmp-AbC123", "pi-output-98e5f7e4-73a9.log");
	mkdirSync(path.dirname(spill), { recursive: true });
	writeFileSync(spill, "x");
	writeFileSync(path.join(tmp, "tmp-AbC123", "other.txt"), "x");
	assert.equal(g.check("read", { path: spill }, repo), undefined);
	assert.ok(g.check("read", { path: path.join(tmp, "tmp-AbC123", "other.txt") }, repo));
	assert.ok(g.check("read", { path: path.join(tmp, "tmp-AbC123", "pi-output-x.log.bak") }, repo));
});

test("没登记的 skill 脚本、没登记的子命令交给审批，并能记成只读；明确的写操作不能记", () => {
	mkdirSync(path.join(skills, "newskill/scripts"), { recursive: true });
	writeFileSync(path.join(skills, "newskill/scripts/tool"), "#!/bin/sh");
	const all = new Guard({ roots: [repo, path.join(skills, "newskill"), path.join(skills, "archery")], bash: "*", skillsDir: skills });
	const kind = (cmd: string, gg = all) => gg.verdict("bash", { command: cmd }, repo).kind;
	const tool = path.join(skills, "newskill/scripts/tool");
	assert.equal(kind(`${tool} list --x 1`), "approve");
	assert.equal(kind(`python3 ${tool} list`), "approve");
	assert.deepEqual(all.learnable(`python3 ${tool} list --x 1`, repo), {
		rule: "tool",
		argv0: ["python3", "{skills}/newskill/scripts/tool"],
		sub: "list",
		isNew: true,
	});
	// bash 没配 "*" 的 agent 不放没登记的脚本
	assert.equal(kind(`${tool} list`, g), "deny");
	// 不在 skill 目录里的普通命令直接放行
	assert.equal(kind("cat a.go"), "allow");
	// 已登记规则里没列出的子命令：审批，可以记成只读；规则里的写操作不能记
	const archery = path.join(skills, "archery/scripts/archery");
	assert.equal(kind(`${archery} explain --sql x`), "approve");
	assert.deepEqual(all.learnable(`${archery} explain --sql x`, repo), { rule: "archery", argv0: [], sub: "explain", isNew: false });
	assert.equal(all.learnable(`${archery} submit --sql x`, repo), undefined);
	assert.equal(all.learnable(`${archery} query --sql x`, repo), undefined);
});

test("记成只读：往已有规则的 read 里加，没有的新建，不重复", () => {
	const file = path.join(root, "rules.json");
	writeFileSync(file, JSON.stringify({ _note: "x", archery: { argv0: ["a"], read: ["query"] } }));
	rememberRead({ rule: "archery", argv0: [], sub: "explain", isNew: false }, file);
	rememberRead({ rule: "archery", argv0: [], sub: "explain", isNew: false }, file);
	rememberRead({ rule: "tool", argv0: ["{skills}/x/scripts/tool"], sub: "list", isNew: true }, file);
	const d = JSON.parse(readFileSync(file, "utf8"));
	assert.deepEqual(d.archery.read, ["query", "explain"]);
	assert.deepEqual(d.tool, { argv0: ["{skills}/x/scripts/tool"], read: ["list"] });
	assert.equal(d._note, "x");
});

test("devops publish 查询放行、auth 拒绝；只读 agent 能 fetch tag 和看 remote", () => {
	mkdirSync(path.join(skills, "devops/scripts"), { recursive: true });
	writeFileSync(path.join(skills, "devops/scripts/publish"), "#!/usr/bin/env python3");
	const gp = new Guard({ roots: [repo, path.join(skills, "devops")], bash: "*", skillsDir: skills });
	const pub = path.join(skills, "devops/scripts/publish");
	allow(`${pub} changelogs GD-1 --timeline`, gp);
	allow(`/usr/bin/python3 ${pub} issue GD-1`, gp);
	allow(`python3 ${pub} issues --service functions-api --since 7d`, gp);
	assert.equal(gp.verdict("bash", { command: `${pub} auth check --auto-refresh` }, repo).kind, "deny");
	allow("git fetch --tags origin", gp);
	allow("git remote -v", gp);
	allow("git remote get-url origin", gp);
	deny("git fetch upstream refs/heads/x", gp);
	allow("git fetch origin refs/merge-requests/12/head", gp);
	deny("git fetch origin refs/merge-requests/12/head:refs/heads/master", gp);
	allow("git cat-file -e abc123", gp);
	allow("git ls-tree -r --name-only abc123", gp);
	deny("git cat-file --filters abc123:a.go", gp);
	deny("git remote add x https://e.com/x.git", gp);
});

test("查用法直接放行：--help 只跟子命令词，或者只有 --version；带取值、路径、deny 的子命令不算", async () => {
	const { helpOnly } = await import("../server/agent/guard.ts");
	assert.equal(helpOnly(["--help"]), true);
	assert.equal(helpOnly(["issues", "--help"]), true);
	assert.equal(helpOnly(["docs", "+update", "-h"]), true);
	assert.equal(helpOnly(["--version"]), true);
	assert.equal(helpOnly(["issues"]), false);
	assert.equal(helpOnly(["delete", "--id", "1", "--help"]), false);
	assert.equal(helpOnly(["run", "--config=/tmp/x.json", "--help"]), false);
	assert.equal(helpOnly(["--version", "push"]), false);
});

test("登记过的命令：--help 放行，deny 的子命令带 --help 也拒绝，没登记的照常审批", () => {
	const g = new Guard({
		roots: [],
		bash: ["foo"],
		skillsDir: "/x",
		rules: { foo: { argv0: ["foo"], read: ["list"], deny: ["auth"] } },
	});
	const v = (command: string) => g.verdict("bash", { command }, "/").kind;
	assert.equal(v("foo --help"), "allow");
	assert.equal(v("foo info -h"), "allow");
	assert.equal(v("foo --version"), "allow");
	assert.equal(v("foo auth --help"), "deny");
	assert.equal(v("foo info GD-1"), "approve");
});

test("取代码跑单测：clone、worktree 只能放 /tmp/cabinet-work，那里的副本能切版本，push 照样不行", () => {
	const wt = path.join(WORK_TMP, "guard-test");
	allow(`git clone git@gitlab.example.com:a/b.git ${wt}`);
	allow(`git worktree add --detach ${wt} abc123`);
	allow(`git worktree remove --force ${wt}`);
	allow("git worktree list");
	allow(`git -C ${WORK_TMP} checkout abc123`);
	allow(`git -C ${WORK_TMP} fetch origin refs/heads/main`);
	allow("git archive abc123 src | tar -x -C /tmp/x");
	deny("git clone git@gitlab.example.com:a/b.git");
	deny("git clone git@gitlab.example.com:a/b.git /Users/someone/code/b");
	deny(`git worktree add -b feat ${wt} abc123`);
	deny("git worktree add ../elsewhere abc123");
	deny(`git -C ${WORK_TMP} push origin HEAD`);
	deny("git checkout abc123");
	deny(`git clone --template=/tmp/hooks git@gitlab.example.com:a/b.git ${wt}`);
	deny("git archive --remote=git@x:a/b.git HEAD");
	assert.equal(g.check("read", { path: path.join(WORK_TMP, "x.go") }, repo), undefined, "临时副本里的代码能用 read 工具看");
});
