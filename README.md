# cabinet

Yi 的飞书助理。名字取自内阁「票拟批红」：消息先由它审一遍、拟好处理意见（草稿），再由 Yi 拍板，确认后才以 Yi 的身份发出。

## 做什么

- **代回复草稿**：轮询 Yi 的私聊、群里 @Yi、飞书项目评论 @Yi。任务中台把消息分派给对应 agent 起草，再由机器人私聊给 Yi 一张卡片：草稿可以在卡片里直接改了再发，也可以点不回复 / 完成 / 改写 / 回表情 / 发表情包；引用卡片回「发送 / 改写 xxx / 表情 赞 / 完成 / 不回复」（老的「发 / 改 / 不发」也认）或在看板上操作也一样，处理完卡片原地更新成结果。按钮需要开发者后台「事件与回调 → 回调配置」选长连接并订阅「卡片回传交互」。Yi 已经亲自回复过的消息不会起草，已起草的那条会自动作废。话题里的回复按会话拉不到：cabinet 处理过的话题会单独盯（`server/topics.ts`）；没在盯的话题里有人 @Yi，每 `POLL_INTERVAL` 秒用 Yi 的身份搜一次「@我」的消息补上（`server/mentions.ts`，需要 `search:message` 权限）。
- **云文档评论**：评论或回复通知到 Yi（被 @、Yi 参与的评论串有新回复）时飞书推 `drive.notice.comment_add_v1`，读出评论串起草，确认后以 Yi 的身份回到同一个评论串（全文评论的串接口回不了，另发一条全文评论）。@Yi 的和群里 @ 一样直接去查，没 @ 的照常分诊。需要开发者后台订阅这个事件、开通 `docs:document.comment:read` 和 `docs:document.comment:create`，再到看板重新授权飞书；开了 `drive:drive.metadata:readonly` 才读得到文档标题。文档正文里直接 @Yi（不是评论）没有事件，收不到；事件只推不补拉，cabinet 没在跑时的通知会漏（`server/doc.ts`）。
- **先批准再起草**：MR 预审、群里 @Yi 的消息、`deep` 档（报错、数据、线上现象这类要查证据的）分诊完直接处理；群里 @Yi 的不等「你在聊」，一般问题也按 deep 档去查（`approval.group`，默认开）。其余的（私聊和飞书项目评论里的寒暄、一般问题）不起草，在看板工作台上显示「等你批准」，点「让助手处理」才开始，也可以直接在输入框里自己回。哪些档位直接处理在 `config/routes.json` 的 `approval.auto` 里配（默认 `["deep"]`，`["*"]` 是全部直接处理），等 `approval.ttl` 秒（默认一天）没批准按跳过收尾。等的时候不占并发名额和聊天锁；你自己回了、对方又接着发了会自动收掉。
- **告警批处理**：群里机器人 @Yi 的告警不起草回复，按群攒一批（2 分钟没有新告警或满 10 分钟收口）交给 alert agent 一起看，结论私聊给 Yi；同一个群一小时内又来的并进上一批。见 `docs/pipeline.md` §4。
- **待你处理**：看板上需要你判断的事汇成一页，按「现在 / 尽快 / 有空」排：待确认的草稿、起草失败、告警结论、Watchdog 发现的问题、agent 任务、建议不回的草稿。
- **定时任务**：看板 Agent 页按 cron 配置，到点交给只读 agent 跑一次，结论私聊给你。
- **自约复查**：等 CI、等发布、等对方晚点发过来这类现在查不出结果的事，agent 在回复末尾写【复查】约个时间（`server/followups.ts`，规则在 `config/system.md`），到点在原会话里接着做：草稿出新一版（MR 预审按复审走），agent 任务接着跑一轮。看板上能看到和取消约好的复查；Yi 点了完成 / 不回复 / 放弃就一起取消；同一件事自动复查最多 5 次，对方来新消息时清零。
- **Watchdog**：每 5 分钟自检一次，新问题私聊一张卡片，恢复后自动清掉。
- **MR 预审**：消息里带 MR 链接，机器人先在那条消息上回 Get，再交给 `mr` 档按 `review` skill 的 GitLab MR 流程审（Standards / Spec 两轴在同一遍里顺带做），产出评审报告和评论台账。这一档用 Codex SDK 跑本机 Codex（`runner: "codex"`，`server/agent/codex.ts`，gpt-6.1-sol，high，不设沙箱、能联网、能派子代理、能实际跑代码），同一个 MR 的复审接着同一个 Codex thread；评审意见同样等 Yi 确认才发出（行内评论 + 总结评论）。卡片上列出将发的评论，Yi 点「发送评论」才以 Yi 的 glab 身份发到 GitLab（发前核对 head 没变，锚不上 diff 行的写进总结评论）；要删改哪条用「改写」。评论发出后开始盯这个 MR（`server/mrwatch.ts`，每 5 分钟）：对方推了新提交（稳定 10 分钟后）或在评论线程里回复，就在同一个会话里按 `review` skill 的 `mr-re-review.md` 复审一轮，只审增量、旧线程判 resolve 或回复，出新一版卡片等 Yi 过目；卡片和看板上也能手动点「复审」。发评论时 head 变了会直接按新提交复审。MR 合并或关闭后不再盯。
- **一个助手**：所有消息都交给 `assistant`，分诊只选档位——`ack`（寒暄确认，便宜模型、不带工具）、`answer`（一般问题）、`deep`（要查证据）、`mr`（MR 链接直接进这一档）。能用 `SKILLS_DIR` 下全部 skill 和 `MCP_CONFIG` 里全部 MCP；命令按 `config/skill-rules.json` 判成放行 / 要审批 / 拒绝，写操作在审批上线前一律拦截。档位、模型、思考强度在 `config/agents.json` 里配置，改完不用重启。dev（改代码）和 alert（告警）是两种单独的任务类型。改版方案见 `docs/redesign.md`。
- **私聊机器人**：Yi 私聊机器人直接提问，交给助手按 deep 档查；引用草稿卡片回「发送 / 改写 xxx / 不回复」处理草稿（「发送」必须引用卡片，不引用时不会去猜是哪一条）；引用任务通知继续追问；「记住 xxx」写入长期记忆，见下方「长期记忆」。
- **看板**（http://127.0.0.1:10086）：七个入口——工作台、需求、定时、记忆、智能体、运行、设置。工作台按「等你处理 / 进行中 / 排队中 / 今天完成」列出每一件事（`tasks` 表，见 `docs/router-worker.md`），每行一个主操作就地办完（发送、审批、重试、立即处理）；点开是这件事的时间线：进来的消息、路由判定、每版草稿、审批、agent 任务，当前的草稿或任务嵌在末尾，改稿、发送、对话、看改动、推送都在那里。流程见 `docs/flow.md`。

## 结构

```
server/          后端（Node 直接跑 TypeScript）
  main.ts        入口：HTTP、飞书长连接、轮询
  lark/          飞书 node-sdk：机器人身份 + 用户身份 OAuth、消息与卡片解析；types.ts 是共用的消息/事件类型
  agent/         agent 驱动（pi-durable）
    driver.ts    Harness、会话、守卫钩子、runPi、执行日志
    models.ts    模型目录、一问一答的 complete
    router.ts    任务中台：agents.json、档位、MR 规则 + 模型分诊
    guard.ts     工具守卫：读文件限目录，命令按 config/skill-rules.json 判放行 / 审批 / 拒绝，dev 只能写自己的 worktree
    tools.ts     只读工具 grep / find / ls / memory
    slots.ts     运行并发：全局信号量 + 按会话排队
  drafts/        代回复草稿
    format.ts    草稿文本：备注 / 评审报告拆分、表情与表情包识别、标签
    card.ts      草稿卡片（JSON 2.0）：可直接改字再发的表单、处理完原地更新成结果
    store.ts     草稿表：状态原子切换、推送卡片给 Yi 并随状态更新、挑出要操作的那条、起草中的消息
    replied.ts   Yi 是否已亲自回复，作废草稿
    context.ts   起草前补齐上下文
    make.ts      起草流程与重启接回
    actions.ts   发 / 改 / 不发 / 完成（以 Yi 身份发出的唯一入口）
  router/        统一入口：index.ts 分流轮询到的消息和私聊机器人（告警攒批、起草、Yi 亲自回复、记住、指令、问答），board.ts 看板派活和定时跳过
  rules.ts       路由阈值：读 config/routes.json，看板「设置 → 路由规则」能改
  taskstore.ts   Task：一件事，分派时归属、按产出推状态
  channels/      渠道接口：lark（轮询私聊 / @Yi）、meego（飞书项目）、doc（云文档评论）、bot（长连接、卡片回调）；poll / listen / send
  cards.ts       卡片按钮的统一入口：草稿、agent 任务、起草失败
  devcard.ts     agent 任务的通知卡片
  lookup.ts      链式召回：agent 按 ID 查消息、分派、草稿、任务、事件流
  watchdog.ts    定时自检：授权、轮询、卡住的起草和任务、失败扎堆，新问题私聊一次
  schedules.ts   定时任务：cron 到点交给只读 agent，结论私聊
  handled.ts     轮询去重
  alerts.ts      告警批处理：机器人 @Yi 的消息按群攒一批，交给 alert agent，结论私聊给 Yi
  pipeline.ts    四段模型：trigger -> route -> action -> result 的落库与查询（docs/pipeline.md）
  poller.ts      轮询主循环：每轮把各渠道拉一遍
  meego.ts       飞书项目（meegle CLI）
  doc.ts         云文档评论通知：读评论串、判断是否还要回、发回评论串
  qa.ts          Yi 私聊机器人：提问、草稿指令、追问任务、记住
  dev.ts         agent 任务（dev 在独立 worktree 改代码）
  tasks.ts       看板的任务模型、执行日志
  retry.ts       失败任务重试
  api.ts         看板接口、SSE、托管前端构建产物
  memory/        长期记忆：Hindsight 客户端、召回与注入、草稿和问答的沉淀、「记住」、约定（directive）
  a2ui/          结论的结构化报告：show_ui 工具的组件目录和校验（A2UI v1.0，zod 4 补丁见 patches/），看板按它渲染（src/components/AgentUi.tsx）
  db/            Drizzle + Turso（turso.ts：drizzle 与 durable 存储的 Turso 适配）
src/             看板前端（TanStack Start + React Query）
config/          agents.json、skill-rules.json、各 agent 提示词、系统规则、起草规则
drizzle/         数据库迁移（drizzle-kit 生成，启动时自动执行）
data/            运行数据，不进 git：cabinet.db（业务；旧记忆表只读保留）、agents.sqlite（durable 对话）、stickers/；旧版 memory/MEMORY.md 启动时导入一次
```

技术栈：TypeScript（Node 24+ 原生类型擦除）、`@earendil-works/pi-durable`（agent 驱动）、`@larksuiteoapi/node-sdk`、Drizzle ORM + Turso（`@tursodatabase/database`）、TanStack Start、Vite 8（Rolldown + Oxc）、oxlint、oxfmt。

## agent 驱动

agent 跑在 [pi-durable](https://github.com/earendil-works/pi/tree/main/packages/durable) 上：对话、模型轮次、工具调用先落库再执行。

- 每个会话 key（话题、MR、群聊）对应一个 durable conversation，映射存在 `kv` 表的 `conv:<key>`。
- 每次提交带 requestId（`draft:<消息 id>`、`qa:<消息 id>`、`revise:<草稿 id>`）。进程崩溃或重启后，`pending:*` 里记着没跑完的任务，启动时用同一个 requestId 重新提交，接上原来那次运行，已经执行过的工具不会再跑。手动重试会换一个 requestId。
- 模型来自 `~/.pi/agent/models.json`（magpie 网关，openai-completions）。主模型额度用完或限流时，在同一会话里换 `PI_FALLBACK_MODEL` 接着跑。
- 工具：durable 自带的 read、bash，加上 cabinet 补的只读 grep / find / ls / memory；守卫挂在 `beforeTool` 钩子上，策略同时存进 `kv`，所以重启恢复的运行也受约束。
- 对话存储跑在 Turso 上（`server/db/turso.ts` 的适配层，语义照 chord 的 node:sqlite 适配器：一条连接、串行执行、事务独占），`pnpm test` 里跑 pi-durable 自带的存储一致性用例。
- pi-durable 还是 Experimental 版本，依赖锁定在 1.5.0；Turso 也锁定在 0.8.3。升级前先跑 `pnpm check` 和真实调用。

## 长期记忆

记忆存在本机的 Hindsight 里，cabinet 只负责拼材料、调接口、渲染注入块（`server/memory/`）。

- **Hindsight**（`HINDSIGHT_URL`，bank `HINDSIGHT_BANK=cabinet`）：约定、Yi 的偏好、经验与事实。它不和 hindsight-coding-agents 给仓库建的 `coding-agent::cabinet` 混用，那个 bank 记的是代码。bank 的 retain / reflect mission 写在 `server/memory/hindsight.ts`，启动时按代码更新。
- **约定**是 Hindsight 的 directive：name 存适用条件，content 存正文，tag 记作用域（`personal` / `person:<open_id>` / `chat:<chat_id>`，另带 `name:<显示名>`）。生效的约定在作用域内每轮都带，不经过相关度门槛，单独占一份 `MEMORY_CONVENTION_TOKENS` 预算。
- **召回**：起草、改写、问答和 agent 任务每次按当前消息召回一次，拼在这一轮的输入里，不进系统段。两路并发：约定；Hindsight recall（Yi 的偏好也在这一路，按作用域 tag `any_strict` 过滤，`MEMORY_TOKENS` 预算，最多 `MEMORY_TOP_K` 条）。哪一路失败就跳过哪一路，这一轮照常跑。agent 也能用 `memory` 工具自己查，`deep=true` 时走 Hindsight reflect。
- **沉淀**：一条草稿走完（发 / 不发 / 完成 / Yi 亲自回复作废）时，程序把原消息、各版草稿、Yi 的改稿意见、Yi 实际发出或亲自回复的内容、这几次运行的工具结果拼成一批，整批 retain 进 Hindsight，`document_id` 用来源，重试时整篇替换。抽什么由 bank 的 retain_mission 决定，Yi 的回复习惯与偏好也从这里抽。原样发出、又没有工具结果的草稿不沉淀；问答只在提问的是 Yi 或者用过工具时沉淀。凭证会先打码。任务记在 `kv` 的 `pending:memory:*`，成功后才删；失败 10 分钟后重试，最多 5 次，重启后接着做。
- **「记住 xxx」**：正文就是 Yi 的原话，模型只帮着分类，按分类写到不同地方：约定（basis 必须逐字出现在原话里）写成 directive，偏好、事实和经验 retain 进 Hindsight（带作用域 tag）。
- **看板「记忆」页**：管理约定（改、停用、删除），手写一条，试召回（各路命中的内容和注入原文）。另列出 Hindsight 里的经验与事实（分页、按类型过滤）。Watchdog 发现某个服务连续 15 分钟调不通时会提醒。
- **迁移**：`pnpm migrate-memory` 预演，加 `--apply` 才真的写。只迁生效的旧记忆：约定写成 directive，其余（偏好、事实、经验）进 Hindsight。候选、已取代、已遗忘的不迁。旧的 `memories` / `memory_terms` / `memory_vectors` 三张表原样保留。

## 身份与权限

- 机器人身份：用 App ID / Secret，由 SDK 管理 tenant token。用于长连接收消息、回复 @机器人、私聊草稿、上传表情包图片。
- 用户身份：在看板上点「授权飞书」，走 OAuth 授权码流程。回调地址是 `OAUTH_REDIRECT`（默认 `http://127.0.0.1:9768/callback`），必须在开发者后台「安全设置 → 重定向 URL」里配好；只有授权期间才监听这个端口。refresh_token 存在 SQLite 的 `kv` 表里，到期前自动刷新。申请的权限见 `server/lark/bot.ts` 的 `USER_SCOPES`，新增权限要先在开发者后台「权限管理」开通，再到看板重新授权。
- 以 Yi 身份发出的唯一入口是 `applyDraftAction("send")`，只由 Yi 的「发」指令或看板确认触发。并发确认时只有一个会生效。
- agent 的命令直接在本机执行（管道、重定向、脚本都行），读文件范围是整个家目录（排除凭证类文件）。带 Yi 登录态的命令按 `config/skill-rules.json` 判：git、glab、lark-cli、meegle 和 skill 脚本读的放行，写的要 Yi 审批，审批的命令必须单独一条（`server/agent/guard.ts`）。
- 看板只监听 127.0.0.1，并校验 Host / Origin；写接口需要同源下发的 token。

## 使用

```sh
pnpm install
cp .env.example .env              # 填 FEISHU_APP_SECRET 等
pnpm import-legacy ~/lark-pi-bot  # 可选：导入旧机器人的草稿、流水、会话和记忆
pnpm build && pnpm start          # 或 deploy/install.sh 注册为 launchd 常驻
```

开发：`pnpm dev`（后端，改动自动重启）+ `pnpm dev:web`（vite，5173，/api 代理到后端），`.env` 里设 `DEV_ORIGIN=http://localhost:5173`。

检查：`pnpm check`（oxlint、oxfmt、tsc、node:test）。改表结构后 `pnpm db:generate` 生成迁移。

表情包：把图片放进 `data/stickers/`，无需重启。

注意：同一个飞书应用只能有一个进程连长连接，否则事件会被随机分给其中一个。启动 cabinet 前要先停掉旧的 lark-pi-bot。
