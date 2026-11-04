# cabinet

Yi 的飞书助理。名字取自内阁「票拟批红」：消息先由它审一遍、拟好处理意见（草稿），再由 Yi 拍板，确认后才以 Yi 的身份发出。

## 做什么

- **代回复草稿**：轮询 Yi 的私聊、群里 @Yi、飞书项目评论 @Yi。任务中台把消息分派给对应 agent 起草，再由机器人私聊给 Yi 过目。Yi 回「发 / 改 xxx / 表情 赞 / 完成 / 不发」，或在看板上操作。Yi 已经亲自回复过的消息不会起草，已起草的那条会自动作废。
- **任务中台**：MR 链接直接交给 CR agent，其余消息由便宜模型分诊到 ask / chat / general。每个 agent 的模型、思考强度、skill、可用命令、工作目录和会话粒度都在 `config/agents.json` 里配置，改完不用重启。
- **@机器人问答**：在 `CHATS` 配置的群里 @机器人，按话题开 pi 会话，结果回复到话题里。「记住 xxx」会写入长期记忆（只有 Yi 能写），见下方「长期记忆」。
- **看板**（http://127.0.0.1:10086）：按 todo / 进行中 / 审核中 / 阻塞 / 完成 / 取消展示任务；可以直接改稿、发送、回表情或表情包、AI 改写、标记完成、失败重试；运行中的任务能实时看到执行步骤。「记忆」页管理长期记忆：确认、遗忘、恢复、改分类、手记一条、按消息试召回。

## 结构

```
server/          后端（Node 直接跑 TypeScript）
  main.ts        入口：HTTP、飞书长连接、轮询
  lark/          飞书 node-sdk：机器人身份 + 用户身份 OAuth、消息与卡片解析
  hub.ts         任务中台：规则分派 + 模型分诊
  agent/         agent 驱动（pi-durable）：模型目录、只读工具、守卫钩子、会话与执行日志
  guard.ts       agent 工具白名单（只读文件、只读命令）
  drafts.ts      草稿：起草、推送、发 / 改 / 不发 / 完成
  poller.ts      轮询私聊、@Yi、飞书项目通知
  meego.ts       飞书项目（meegle CLI）
  qa.ts          @机器人问答与私聊里的草稿指令
  tasks.ts       任务模型、执行日志、重试
  api.ts         看板接口、SSE、托管前端构建产物
  memory/        长期记忆：存取与生命周期、召回（关键词 + 向量）、自动提取、「记住」
  db/            Drizzle + Turso（turso.ts：drizzle 与 durable 存储的 Turso 适配）
src/             看板前端（TanStack Start + React Query）
config/          agents.json、各 agent 提示词、系统规则、起草规则
drizzle/         数据库迁移（drizzle-kit 生成，启动时自动执行）
data/            运行数据，不进 git：cabinet.db（业务与记忆）、agents.sqlite（durable 对话）、stickers/；旧版 memory/MEMORY.md 启动时导入一次
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

做法借鉴 komo 的记忆设计（`komo-bot/docs/memory.md` §9），按 cabinet 的场景收窄。数据在 `cabinet.db` 的 `memories` / `memory_terms` / `memory_vectors` 三张表里。

- **约定与线索**：约定（convention）是 Yi 表达了长期意图的偏好，写明什么时候适用（`appliesWhen`），条件成立时直接照做；其余都是线索（reference），只作参考。来源（Yi 原话 / 工具结果 / 模型推断）和是否经 Yi 确认分开记。
- **作用域**：`personal` 处处适用；`person:<open_id>` 只在和这个人有关时带（比如回某人的口吻）；`chat:<chat_id>` 只在这个会话带。
- **生命周期**：候选 → 生效 → 有争议 / 已取代 / 已遗忘。模型推断只进候选，不注入；冲突的条目停用，等 Yi 在看板上裁定；遗忘的原行保留，同一句话不会被重新提取回来。改正文、用法、条件或作用域升 revision，看板操作都带预期 revision。
- **召回**：每次起草、改写、问答、agent 任务按当前消息召回一次，拼在这一轮的输入里（不进系统段）。约定每次都带（单独 `MEMORY_CONVENTION_TOKENS` 预算）；线索走关键词（中文 bigram + IDF，`instr` 匹配；Turso 没有 FTS5）和向量（本机 Ollama，Turso `vector_distance_cos`）两臂，过任一臂的门槛才留下，RRF 排名，最多 8 条、约 1500 token，不强行填满。向量服务不可用时退成只用关键词。agent 还能用只读的 `memory` 工具自己查。
- **提取**：一条草稿走完（发 / 不发 / 完成 / Yi 亲自回复作废）时，把原消息、各版草稿、Yi 的改稿意见、Yi 实际发出或自己回复的内容、这几次运行的工具结果拼成一批，一次模型调用（`MEMORY_MODEL`）提取。程序校验：Yi 原话必须真的引了 Yi 的材料；约定只给偏好，要有适用条件，`basis` 必须逐字出现在所引的 Yi 原话里，否则降为线索；不记凭证。原样发出、也没有工具结果的草稿不提取。问答只在提问的是 Yi 或者用过工具时提取。任务记在 `kv` 的 `pending:memory:*`，重启后接着做。
- **「记住 xxx」**：正文就是 Yi 的原话，模型只帮着分类，记成已确认；判成约定的会回一句适用条件。
- **门槛校准**：默认值按 `qwen3-embedding:4b` + 默认查询前缀校准；换模型或前缀后在看板「记忆」页用试召回看两臂分数，再改 `.env` 里的 `MEMORY_MIN_*`。

## 身份与权限

- 机器人身份：用 App ID / Secret，由 SDK 管理 tenant token。用于长连接收消息、回复 @机器人、私聊草稿、上传表情包图片。
- 用户身份：在看板上点「授权飞书」，走 OAuth 授权码流程。回调地址是 `OAUTH_REDIRECT`（默认 `http://127.0.0.1:9768/callback`），必须在开发者后台「安全设置 → 重定向 URL」里配好；只有授权期间才监听这个端口。refresh_token 存在 SQLite 的 `kv` 表里，到期前自动刷新。
- 以 Yi 身份发出的唯一入口是 `applyDraftAction("send")`，只由 Yi 的「发」指令或看板确认触发。并发确认时只有一个会生效。
- agent 只有只读能力：守卫限制读文件的目录（排除凭证类文件），bash 只放行 agent 配置里列出的只读命令族。meegle、glab 的写操作只由 cabinet 在 Yi 确认后执行。
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
