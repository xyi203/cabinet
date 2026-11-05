import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Guard, tokenize } from "../server/agent/guard.ts";

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

test("bash 只允许单条命令", () => {
	deny("git log | head");
	deny("git log; rm -rf /");
	deny("git log $(whoami)");
	deny('git log "$HOME"');
	deny("git log `id`");
	deny("git log > /tmp/x");
	deny("ls *");
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
	deny("cat a.go", gitOnly);
	deny("python3 -c 1", gitOnly);
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
	no("go run main.go");
	no("go test ./... ; rm -rf /");
});

test("lark-cli 只放行读文档", () => {
	const gl = guard(["lark-cli"]);
	allow("lark-cli docs +fetch --doc https://x.feishu.cn/docx/abc --doc-format markdown", gl);
	deny("lark-cli docs +update --doc abc", gl);
	deny("lark-cli im +messages-send --chat-id oc_1 --text hi", gl);
	deny("lark-cli docs +fetch --doc abc --as bot", gl);
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
	assert.equal(withMcp.check("mcp__prometheus-saas-cluster__execute_query", {}, "/"), undefined);
	assert.equal(withMcp.check("codemode", { code: "1" }, "/"), undefined);
	assert.match(withMcp.check("mcp__devops-mcp-prod__issue_create", {}, "/") ?? "", /未在白名单/);
	const plain = new Guard({ roots: [], bash: [], skillsDir: "/nonexistent" });
	assert.match(plain.check("codemode", { code: "1" }, "/") ?? "", /未在白名单/);
	assert.match(plain.check("mcp__prometheus-saas-cluster__execute_query", {}, "/") ?? "", /未在白名单/);
});
