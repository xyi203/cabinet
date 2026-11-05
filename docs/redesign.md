# cabinet 改版方案：一个助手，看得全，改要批

> 状态：阶段 1–3 已实施（2026-11-05）；阶段 4 待做。每个阶段单独可合并、单独可用；后一阶段没做，前一阶段照样能用。

## 为什么改

11-04 14:30 到 11-05 中午的数据（约一天半，方向可信、比例还不稳）：

- 49 条草稿：发出 4 条（8%），Yi 自己先回导致作废 22 条（45%），标完成没发 21 条；起草平均 12–29 秒，不是慢。
- 花费主要在 ask 查证据（$1.91 / $2.63）；定时任务、订阅、群里 @机器人问答几乎没用过。
- agent 定制太死：分诊只能在 ask / chat / general / cr 里挑一个，能力（skill、命令、MCP）按 agent 白名单发放，输出格式统一压成「1–2 句 + 备注」。

## 定下来的方向

1. **一个助手**：取消 ask / chat / general / cr 四个角色，合成 `assistant`。分诊只决定「查多深、用什么模型」。dev（改代码，独立 worktree）和 alert（告警批处理）保留为两种任务类型。
2. **能看的全给**：所有 skill 可见；只读命令、只读 MCP 全给。安全靠「每个 skill 的读写规则」兜底，不靠「这个 agent 不给这个 skill」。
3. **写操作一律审批**：agent 提出具体命令，私聊 Yi 一张审批卡片（执行什么、为什么、哪条消息引起的），点「执行」才由 cabinet 执行，结果回到原会话。任意 bash、出网仍然不给。
4. **一句话定制**：「记住 xxx」按人 / 按群 / 全局存成约定，替代改 `agents.json` 和提示词。
5. **输出形态看内容**：寒暄回表情；问题给结论 + 证据；排查出简报。建议回复保留一键发送，但不是卡片主体。
6. **定时任务保留**，改成一句话创建、确认后生效；看板留列表页。
7. **订阅改成接续**：同一个话题 / 工作项 / MR 接着用同一个会话（去掉「直通某个 agent」的意思）。
8. **砍掉**：群里 @机器人问答（`CHATS`，现在本来没开）。私聊机器人的指令（处理草稿、追问任务、记住）全部保留。

不做：自动发送（任何以 Yi 身份发出的内容仍要 Yi 点头）；任意 bash / 出网；把 dev 的写权限放到 worktree 之外。

## 总体结构

```
飞书消息 / 看板 / 定时 / 告警
        │
        ▼
   分诊（luna）：ack / answer / deep / mr   ──►  assistant（一个提示词 + 档位）
        │                                         │
        │                       读：read/grep/ls/find、skill 只读子命令、只读 MCP（codemode）
        │                       写：skill 写子命令、非只读 MCP ──► 审批卡片 ──► Yi 点执行 ──► cabinet 执行 ──► 结果回原会话
        ▼
   产出：表情 / 简报卡片（结论+证据+建议回复）/ agent 任务结论
```

数据交换方：分诊 → 助手运行 → 守卫（读写判定）→ 审批表 → 卡片回调 → 执行器 → 原会话。没有环：执行器只往会话里追加消息，不回头触发分诊。

---

## 阶段 1：合成一个助手 + 全量只读能力

**完成后**：所有消息都交给 `assistant`，按档位跑；能用全部 skill 和全部只读能力；写操作和现在一样直接拦截（报「需要审批，阶段 2 上线前不可用」）。群里 @机器人问答下线。

### 配置

`config/agents.json`：删掉 `cr` / `ask` / `general` / `chat`，新增 `assistant`；`dev`、`alert` 保留；`_router.fallback` 改成 `assistant`。

```jsonc
"assistant": {
  "desc": "Yi 的助手：所有别人发给 Yi 的消息",
  "prompt": "agents/assistant.md",
  "skills": "*",            // SKILLS_DIR 下全部
  "mcp": "*",               // MCP_CONFIG 里全部 server
  "session": "chat",
  "cwd": "default",
  "tiers": {
    "ack":    { "model": "codex/gpt-6-luna",      "thinking": "minimal", "tools": [] },
    "answer": { "model": "claude/claude-opus-5-5", "thinking": "medium" },
    "deep":   { "model": "claude/claude-opus-5-5", "thinking": "high" },
    "mr":     { "model": "claude/claude-opus-5-5", "thinking": "high", "cwd": "repo_of_mr", "session": "mr" }
  }
}
```

`alert` 也改成 `"skills": "*"`、`"mcp": "*"`；`dev` 保持现有写权限（只能写自己的 worktree），读权限同样放开到全量。

### 代码

| 文件 | 改动 |
|---|---|
| `server/agent/router.ts` | `AgentConfig` 加 `tiers`；`skills`、`mcp` 允许 `"*"`。`route()` 改成输出档位 `{tier, reason}`：MR 链接直接 `mr`；寒暄 / 确认 / 致谢 → `ack`；要查证据、排查 → `deep`；其余 `answer`。`sessionKey` 按档位的 `session` 取。 |
| `server/agent/driver.ts` | `runPi` 接收档位：模型、思考强度、tools、cwd 取档位覆盖。`"*"` 展开成 `SKILLS_DIR` 下全部目录、`MCP_CONFIG` 里全部 server；`skillsHint` 只列名字和 `description`，用到再读 SKILL.md。`harness()` 启动时连的 MCP 也按 `"*"` 展开。 |
| `server/agent/guard.ts` | 硬编码的 `scriptRules` 挪到 `config/skill-rules.json`（下文）；`check()` 返回三态：`allow` / `approve` / `deny`。阶段 1 里 `approve` 当 `deny` 处理，拦截原因写「需要审批」。MCP 工具：`readOnlyHint=true` 或列在 `skill-rules.json` 的 `mcpRead` 里的放行，其余 `approve`。 |
| `config/skill-rules.json`（新） | 每个带脚本的 skill：`argv0`、`read`（直接放行的子命令）、`write`（要审批的子命令），没列的子命令一律 `deny`。先把现有 6 条（archery / superset / sls / grafana / oncall / lark-cli）原样搬过来，再补 kafka（只读）、sentry（只读）、glab（`mr view/diff/list/notes`、`ci view/status` 读；`mr note` 写）、devops-mcp（脚本只读查询读，提单写）。 |
| `server/drafts/make.ts` | 去掉 chat → fallback 改派那段（`ack` 档位不出文字就是它的职责，出了文字直接升到 `answer` 档重跑，逻辑相同、不再换 agent）。`mrBrief` 只在 `mr` 档调用。 |
| `config/agents/assistant.md`（新） | 合并 ask / general / cr / chat 四份提示词：按情形分节（问题与排查、协调与表态、MR 预审、寒暄确认），每节就是原来那份的内容。 |
| `config/system.md` | 改掉「放在飞书群里、机器人身份回到话题」的描述，改成「Yi 的助手，产出先给 Yi 看」。 |
| `server/qa.ts`、`server/config.ts`、`.env.example`、`README.md` | 删群里 @机器人问答：`accept()` 里 `CHATS` 分支、`buildPrompt` 的群话题部分、`CHATS` 配置和 `READ_ROOTS` 里的 `CHATS` 目录。私聊机器人的 `draftCommand` / `devReply` / `remember` 不动。 |
| `server/pipeline.ts` | 订阅照旧挂会话；`subscriber()` 命中后不再要求 `agents[sub.agent]` 存在，旧订阅里的 `ask` / `general` 一律当 `assistant` 接续。 |
| `src/lib/format.ts` | `AGENT_NAME` 加 `assistant: "助手"`，旧名字保留（历史记录还要显示）。 |
| 删除 | `config/agents/ask.md`、`general.md`、`cr.md`、`chat.md`。 |

实施中补的一处：bash / read 输出太长时 durable 把完整输出存到 `<系统临时目录>/tmp-*/pi-output-*.log`，守卫放行这一种文件，否则 agent 拿不到完整结果会绕路耗到超时。拒绝提示同时列出要审批的写子命令，免得 agent 以为写操作一律被拒。

### 迁移

- 旧会话 key `ask-<chat>`、`general-<chat>` 不再使用，新 key 是 `assistant-<chat>`：等于这些会话换新。durable 记录不删，看板历史照常显示。
- `pending:draft:*` 里重启接回的旧分派（`open.agent` 是 `ask` 之类）：`make.ts` 里旧名字映射到 `assistant`、按 `deep` 档接着跑。

### 验证

- 单测：`tests/guard.test.ts` 改成读 `skill-rules.json`，覆盖 allow / approve / deny 三态和未列出子命令 deny；`tests/agent.test.ts` 加分诊档位解析（MR 直接 `mr`、模型输出不合法走 `answer`）；`tests/drafts.test.ts` 加旧 agent 名接回映射。
- 实测：重启后派四类消息（寒暄、查数据、排期协调、MR 链接），看分诊档位、模型和工具清单；agent 读一个此前不在白名单里的 skill（如 kafka）并用它的只读子命令；让 agent 尝试 `archery submit`，确认被拦且原因是「需要审批」。
- `pnpm check` 通过（已知的记忆测试除外）。

### 回退

纯代码和配置改动，`git revert` 即可；会话 key 回到旧名字后旧会话还在。

---

## 阶段 2：写操作审批

**完成后**：守卫判成 `approve` 的调用不再直接拦死，而是生成审批卡片；Yi 批准后由 cabinet 执行，结果回到原会话。

### 数据

新表 `approvals`（drizzle 迁移，只加表）：`id`（`apv-<时间>`）、`created`、`status`（pending / approved / rejected / expired / failed / done）、`tool`（`bash` 或 MCP 工具名）、`args`（JSON）、`reason`（agent 写的理由）、`runKey`（会话 key）、`convId`、`devTaskId`（agent 任务时有）、`draftId`（起草时有）、`triggerId`、`origin`（「张三在群 xx 的消息」/「Yi 在看板」/「定时任务 xx」）、`result`、`decided`。

### 流程

1. agent 调写操作 → `beforeTool` 里守卫返回 `approve` → 写一条 `approvals`，block 原因写「已提交审批 apv-xxx，Yi 批准后结果会发给你；不要换个写法重试」→ 私聊 Yi 一张审批卡片。
2. 卡片：执行什么（命令原文 / MCP 工具名加参数）、agent 的理由、触发来源；按钮「执行」「拒绝」，拒绝可附一句原因。24 小时没处理就过期。
3. 点「执行」：`server/approvals.ts` 按记录原样执行——bash 走守卫的同一套切词和 argv0 归一化（不经模型改写），MCP 走 `mcp.ts` 的 client；执行时再过一遍守卫，必须仍判成 `approve`（防止配置变了）。
4. 结果回原会话：agent 任务调 `messageDev(devTaskId, "Yi 批准了 apv-xxx，执行结果：…")`；起草会话追加一轮「执行结果：…，按需更新草稿或备注」；定时任务同 agent 任务。拒绝时同样回一句「Yi 拒绝了：原因」。
5. 看板「待你处理」加 `approval` 类，级别「现在」；卡片和看板任一处理，另一处同步。

### 代码

| 文件 | 改动 |
|---|---|
| `server/approvals.ts`（新） | 建审批、渲染卡片、执行、回写结果、过期清理（挂到 `cleanup.ts` 的每日任务）。 |
| `server/agent/driver.ts` | `beforeTool` 处理 `approve`；`StoredPolicy` 记下 `devTaskId` / `draftId` / `origin`，重启后也能建审批。 |
| `server/cards.ts` | 新增 `k: "apv"` 的按钮分支。 |
| `server/tasks.ts`、`src/components/Inbox.tsx` | 「待你处理」的审批项和处理按钮。 |
| `config/skill-rules.json` | 补全各 skill 的 `write` 子命令（archery `submit/approve/execute/cancel`、glab `mr note`、oncall 无、devops-mcp 提单与流转等）。 |
| `config/system.md` | 告诉 agent：写操作会进审批，写清理由；被拒绝或过期不要绕路重试。 |

### 验证

- 单测：审批状态机（重复点执行只执行一次、过期后不能执行、执行时守卫复核失败转 failed）；卡片回调。
- 实测：让 agent 在一个测试 MR 上发评论（`glab mr note`），确认收到审批卡片 → 拒绝一次看 agent 收到原因 → 再来一次批准，评论出现、结果回到会话；重启 cabinet 后处理一张阶段前生成的审批卡片仍然可用。

实施时的取舍：卡片上的「说明」是守卫给的（如「archery submit 是写操作」），工具调用不带理由，agent 被拦后把理由写进回复或备注；审批执行出错时带完整输出（上限 3000 字），通用 exec 只留 300 字会截掉报错行。

### 回退

`skill-rules.json` 把所有 `write` 清空即退回「写一律拦截」；`approvals` 表留着不影响旧代码。

---

## 阶段 3：一句话定制 + 一句话建定时任务

**完成后**：「记住」能按人 / 按群生效；定时任务用一句话创建，确认后生效。

### 一句话定制

- 私聊机器人「记住 xxx」：分类时同时判断作用域，候选只给三个——`personal`；引用了某张草稿卡片时，加上那条消息的发送人 `person:<open_id>` 和所在会话 `chat:<chat_id>`。模型在候选里选，选不出就 `personal`。
- 回复里写明类型、适用条件、作用域（实施时用文字回复，不另发卡片）；改作用域、撤销在看板记忆页。
- 改动：`server/memory/remember.ts`（分类带作用域）、`server/qa.ts`（把引用卡片的上下文传进去）、`server/memory/store.ts` 不变（已支持作用域）。

### 一句话建定时任务

- 助手多一个工具 `schedule`：参数 `name`、`cron`、`prompt`，**判成写操作**，走阶段 2 的审批卡片，卡片上把 cron 翻成人话（「每天 09:00」）并列出接下来三次运行时间；批准即 `saveSchedule`。
- 私聊「每天 9 点查一下昨晚指派给我的告警」→ 分诊到助手 → 助手调 `schedule` → 审批卡片。
- 定时任务的执行 agent 改成 `assistant`（`deep` 档），能力同其他任务。
- 看板定时任务页：保留列表、暂停 / 删除 / 立即运行；新建表单去掉，改成一句提示「私聊机器人一句话创建」。
- 改动：`server/agent/tools.ts`（`schedule` 工具）、`server/schedules.ts`（执行 agent 改为 assistant）、`src/components/Schedules.tsx`。
- 依赖阶段 2 的审批；阶段 2 没上线时，这个工具判成 `deny`，阶段 3 的「一句话定制」部分照样可用。

### 验证

- 单测：作用域候选只能从给定集合里选；`schedule` 工具的 cron 校验和人话翻译。
- 实测：引用一张来自某人的草稿卡片回「记住 回他用英文」，下一条他的消息起草时召回到这条约定；一句话建定时任务 → 审批 → 「立即运行」跑通。

---

## 阶段 4：简报卡片 + 有用 / 没用

**完成后**：草稿卡片主体是「这条消息要你做什么 + 结论 + 证据」，建议回复附在下面、可一键发；能统计哪些卡片有用。

### 输出格式

`config/draft.md` 改成按内容选形态，标记沿用现有解析方式：

- 寒暄 / 确认：`【表情】类型` 或 `【无需回复】理由`（不变）。
- 其余：`【需要你】回复 / 决定 / 知会：一句话`，`【结论】…`，`【证据】…`（文件:行号、SQL、日志、链接），最后是建议回复正文（可空——只是知会时不给建议回复）。
- 旧的 `【备注】` 继续认，渲染到证据区，旧草稿不受影响。

### 卡片

- 顶部：需要你做什么；中间：结论、证据（折叠）；底部：建议回复（可直接改字再发）。
- 按钮：发送、深查（把这条消息转成 `deep` 档的 agent 任务，结论回到同一张卡片）、完成、有用 / 没用。AI 改写和表情包挪进「更多」。
- 改动：`server/drafts/format.ts`（新标记解析）、`server/drafts/card.ts`（布局）、`server/drafts/actions.ts`（深查、反馈）、`src/components/Drawers.tsx`（看板同样展示）。

### 指标

- `records` 记 `feedback`（useful / useless）；看板「我的任务」顶栏加最近 7 天：起草数、发出数、自己抢先回复数、有用率。
- 两周后看有用率：低于一半就停掉简报，回到只起草不查证的轻量模式。

### 验证

- 单测：新旧格式解析；深查生成的任务挂回原草稿。
- 实测：一条问数据的消息 → 卡片展示需要你 / 结论 / 证据 / 建议回复；点深查 → 任务完成后卡片更新；点有用 → 看板计数变化。

---

## 风险与依赖

- **最脆弱的假设**：Yi 自己抢先回复，是因为拿着草稿没用、需要的是证据，而不是 agent 查得不准。如果其实是查不准，阶段 4 的简报一样没人看——所以阶段 4 自带有用 / 没用的统计和两周后的止损线，不靠感觉。
- **全量只读的泄露面**：别人的消息能让 agent 去读生产库、读内部文档。产出只私聊 Yi，发出去的内容要 Yi 点头；但 Yi 一键发送前要看清建议回复里有没有敏感数据——`config/system.md` 已要求不输出敏感字段，阶段 1 再加一条：建议回复里不放原始查询结果，只放结论。
- **成本**：全部消息走 Opus 的话成本会上去；`ack` 档用 luna、不带工具，与现在 chat agent 持平。阶段 1 上线后看两天 `records` 的花费，`answer` 档必要时降到 sonnet。
- **依赖的凭证与服务**（都已在本机可用，阶段内不新增）：飞书 user token（OAuth 已授权）、`~/.config/shoplazza/config.toml` 里各 skill 的凭证、`~/.pi/agent/mcp.json` 里的 MCP server、magpie 网关模型。devops-mcp 是 http MCP，阶段 1 实测时确认它的工具有没有标 `readOnlyHint`；没标的全部按写操作走审批，不影响上线。
- **改动规模**：阶段 1 约 15 个文件，阶段 2 新增 1 个服务模块和 1 张表，阶段 3、4 各 5–6 个文件。
