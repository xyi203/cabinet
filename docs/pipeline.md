# 四段模型：trigger → route → action → result

> 状态（2026-11-04）：第 1 步、告警批处理（§4）、链式召回（§5）、订阅直通（§6）、Watchdog（§7）、渠道接口（§8）、定时任务（§9）已实现。第 2 步（合成 `actions` 表，§3）是方案，未实现。

## 1. 四段

```
Trigger ──▶ Route ──▶ Action ──▶ Result
   ▲                                │
   └────── 外部的后续动静 ◀──────────┘  （对方回复、Yi 亲自回复、CI 结果）
```

| 段      | 是什么                                                                                      | 表                                                                | 写入口                            |
| ------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------- |
| Trigger | 渠道来的一条事件，过了程序规则（Fast Path）才记；`${channel}:${渠道内 id}` 去重，落库后不改 | `triggers`                                                        | `receive()`                       |
| Route   | 一次分派的决定：哪几条 trigger、交给哪个 agent、进哪个会话、为什么；可以是「不处理」        | `routes`                                                          | `decide()`，产出后 `linkAction()` |
| Action  | agent 的一次执行和它的产出                                                                  | 暂时仍是 `drafts` / `dev_tasks` / 问答的 `records`，带 `route_id` | 各自原来的代码                    |
| Result  | action 的最终结果，带影响范围和外部痕迹（消息 id、MR 链接）                                 | `results`                                                         | 只有 `settle()`                   |

代码在 `server/pipeline.ts`；看板接口 `GET /api/pipeline`（最近的 trigger 及去向）、`GET /api/pipeline?id=lark:om_xxx`（一条的来龙去脉）。

### 渠道（channel）

| channel | 来源                                 | thread                         |
| ------- | ------------------------------------ | ------------------------------ |
| `lark`  | 轮询 Yi 的私聊、群里 @Yi（用户身份） | `lark:<chat_id>[#<thread_id>]` |
| `meego` | 飞书项目评论 @Yi                     | `meego:<工作项 id>`            |
| `bot`   | @机器人、私聊机器人（长连接）        | `bot:<chat_id>#<话题根>`       |
| `board` | 看板派活、草稿转任务                 | `board:<任务 id>`              |

`refs` 记正文里提到的其他事件流（现在只认 MR：`gitlab:<项目>!<iid>`），以后跨渠道关联、订阅直通都用它。

### route 的 action_kind

`draft`（起草代回复）、`qa`（@机器人问答）、`dev`（agent 任务）、`remember`（记住）、`command`（Yi 对已有 action 的操作：草稿指令、回复 agent 任务，action_id 指向被操作的那个）、`none`（不处理，trigger 标成 skipped）。

### result 的影响范围（effect）

| effect     | 含义                         | 例子                         |
| ---------- | ---------------------------- | ---------------------------- |
| `internal` | 只在 cabinet 里              | 不发、完成、作废、记住、失败 |
| `bot`      | 机器人以自己的身份对外说话   | @机器人问答的回复            |
| `local`    | 改了本机文件                 | 放弃 dev 任务（删 worktree） |
| `outward`  | 以 Yi 的身份发出，或推到外部 | 草稿发出、dev 推送建 MR      |

`outward` 的只能在 Yi 确认之后发生：草稿走 `applyDraftAction("send")`，dev 走 `pushDev`。

## 2. 第 1 步做了什么（已实现）

- 新表 `triggers`、`routes`、`results`，`drafts` / `dev_tasks` 加 `route_id`（迁移 `drizzle/0006`，只加不改）。
- 起草（`drafts/make.ts`）：每条轮询到的消息记 trigger；Yi 已亲自回复记一个 `none` 的 route；分派后记 route，草稿推送后 `linkAction`；起草失败记 `failed`。改写出的新版本沿用 `route_id`。
- 草稿结果：发出（outward）、不发、完成（`drafts/actions.ts`），Yi 亲自回复作废（`drafts/replied.ts`）。
- 问答（`qa.ts`）：每条发给机器人的消息记 trigger，分成 qa / remember / command 三种 route；回复记 `replied`（bot），失败记 `failed`。
- agent 任务（`dev.ts`）：看板派活记 board trigger 和 route；推送记 `pushed`（outward，ref 是 MR 链接），放弃、完成各记一条。
- **重启接回**：第一次提交后在 kv 记下 `run:<requestId>`（提交 ID、提交前的用量、换备用模型后 continue 的 ID）。重启后同一个 requestId 再来时直接挂回那次提交，不重新配置（不会把换上的备用模型改回去）、不重新召回、不重新提交，花费从提交前算起；备用模型那一段也接得回。起草还把交给 agent 之前定下的一步（分派、前文、提示、cwd）记在 `pending:draft:*` 的 `stage` 里，接回时不重新拉前文、不重新分派、不重新查 MR。这次分派已经产出草稿的不再推第二张；推草稿前再查一次 Yi 有没有在起草期间亲自回了。调用方处理完结果后清掉凭据（`forgetRun`），启动时清掉 3 天以前的。手动重试换一个 requestId，是一次新的提交。
- 看板的今日请求数按 `triggers` 算，已回复 / 已发出 / 不发 / 失败按 `results` 算；起草数和花费仍按 `records`。
- 没改的：`handled` 表仍负责轮询去重。

## 3. 第 2 步：合成 actions 表（方案）

`drafts`、`dev_tasks`、问答的 `records` 合成一张 `actions`：`kind`、`effect`、`parent_id`（草稿转任务、改写的上一版）、`channel` + `target`（往哪发）、`payload`（草稿正文 / 任务说明）、状态（todo / in_progress / in_review / blocked / done / cancelled，借 multica）。看板的 `buildTasks` 现在就是在拼这张表，合表之后它变成一次查询。要一起改：看板前端、`applyDraftAction`、`pending:*` 接回、`import-legacy`。

## 4. 告警批处理（已实现，2026-11-04）

告警是群里机器人 @Yi 的消息。以前轮询只收真人消息（`sender_type === "user"`），告警在程序规则那一步就被丢了。

做法（`server/alerts.ts`）：

1. **识别**：群里、发送者不是真人也不是 cabinet 自己、@了 Yi（mentions 里有，或卡片渲染出 `@名字`）。`ALERT_SENDERS` 配了就只认这些机器人，`ALERT_CHATS` 配了就只认这些群。PagerDuty 卡片里 @ 的是「指派」，`[Ack]` / `[Res]` 状态更新不算。p2p 的机器人会话（比如飞书项目通知）不算。
2. **按群攒一批**（文章 2.1 的 batching）：第一条进来起算，`ALERT_QUIET`（120）秒没有新告警、或满 `ALERT_MAX_WAIT`（600）秒就收口。攒着的批存在 kv 的 `pending:alert:*`，重启后接着攒；收口时才把消息记进 `handled`。
3. **一批一次分派**：每条告警记一个 `alert` trigger（thread `alert:<chat_id>`），整批一个 route，交给 `alert` agent（`config/agents.json`，只读，带 grafana / oncall / superset / archery），开一个 agent 任务。
4. **结果私聊给 Yi**：agent 任务每轮结束都私聊（agent 配置 `notify: true`），引用通知可以追问，「完成」归档；看板「Agent」页能看到。不以 Yi 的身份发出任何东西。
5. **续批**：同一个群 `ALERT_FOLLOW`（3600）秒内又来一批、上一批的任务还没归档，就并进上一批的会话（运行中插话，空闲开新一轮），route 记成 `command` 指向原任务。不再分诊。

还没做的：按指纹去重和抖动识别交给 agent 自己判断（提示词里要求归并），程序里没有解析告警卡片的格式；没有样本前不硬写解析。

## 5. 链式召回（已实现）

agent 工具 `lookup`（`server/lookup.ts`）：按 ID 查 trigger、route、草稿、agent 任务、事件流（`thread:`）、MR（`gitlab:`）。每个结果只给摘要，末尾「相关」列出下一跳的 ID（Inline & Spill）。起草、改写、agent 任务的提示里带着起点 ID。

**只给结果先经 Yi 过目的运行**：起草和改写（发出前 Yi 确认）、agent 任务（结论只私聊 Yi）。群里 @机器人的问答不给：它能看到私聊和草稿，回复又直接发进群里。工具列表和守卫（`Guard.lookup`）两处都拦。

## 6. 订阅直通（已实现）

表 `subscriptions`：事件流或被引用的对象挂到一个 agent 会话上。起草分派后，把这条消息所在的话题（`lark:<chat>#<thread>`）、飞书项目工作项（`meego:<id>`）和提到的 MR（`gitlab:...`）订阅到这次的会话；之后命中订阅的消息直接进那个会话，不再分诊（route 的 rule 写「订阅直通：<key>」）。MR 优先于话题。整个群、整个私聊不订阅。`SUBSCRIBE_TTL`（默认 3 天）没用到就失效。

已知的取舍：直通不再分诊，订阅在 cr 会话上的话题里一句「好的谢谢」也会交给 cr agent。

## 7. Watchdog（已实现）

`server/watchdog.ts`，每 `WATCHDOG_INTERVAL`（300）秒按确定规则查一遍：没授权 / 授权 3 天内过期、轮询 10 分钟没推进、起草超过 30 分钟、agent 任务显示运行中但没有在跑的运行、告警批超时没收口、一小时内失败 ≥ 5 次。新问题私聊一张卡片（同一个问题只提醒一次，恢复后清掉），当前的问题放在「待你处理」的最前面。只查不修。还没做：让模型判断任务有没有实质进展（文章第 6 节）。

## 8. 渠道接口（已实现）

`server/channels/`：`Channel` 有 `poll`（拉取）、`listen`（推送）、`send`（以 Yi 身份发出确认过的草稿），都可选。现有三个实现：`lark`（用户身份轮询私聊和 @Yi，含告警识别）、`meego`（飞书项目评论）、`bot`（长连接：@机器人和卡片回调）。轮询主循环按渠道轮一遍，有渠道失败就不推进 since；草稿按来源发回对应渠道。接 GitHub、RSS 就是再写一个实现、加进 `channels()`。

## 9. 定时任务（已实现）

表 `schedules`，看板 Agent 页管理（`server/schedules.ts`）。5 段 cron，本机时区。到点记一条 `cron:<任务>:<计划时间>` trigger，交给只读 agent 开一个任务（不能是 dev），每轮私聊 Yi 一张卡片；提示里带上一次任务的 ID，agent 用 lookup 对比、只说变化。上一次还在跑就跳过；停机期间错过的只补一次。
