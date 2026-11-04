# cabinet

Yi 的飞书助理。名字取自内阁「票拟批红」：消息先由它审一遍、拟好处理意见（草稿），再由 Yi 拍板，确认后才以 Yi 的身份发出。

## 做什么

- **代回复草稿**：轮询 Yi 的私聊、群里 @Yi、飞书项目评论 @Yi。任务中台把消息分派给对应 agent 起草，再由机器人私聊给 Yi 过目。Yi 回「发 / 改 xxx / 表情 赞 / 完成 / 不发」，或在看板上操作。Yi 已经亲自回复过的消息不会起草，已起草的那条会自动作废。
- **任务中台**：MR 链接直接交给 CR agent，其余消息由便宜模型分诊到 ask / chat / general。每个 agent 的模型、思考强度、skill、可用命令、工作目录和会话粒度都在 `config/agents.json` 里配置，改完不用重启。
- **@机器人问答**：在 `CHATS` 配置的群里 @机器人，按话题开 pi 会话，结果回复到话题里。「记住 xxx」会写入长期记忆（只有 Yi 能写）。
- **看板**（http://127.0.0.1:10086）：按 todo / 进行中 / 审核中 / 阻塞 / 完成 / 取消展示任务；可以直接改稿、发送、回表情或表情包、AI 改写、标记完成、失败重试；运行中的任务能实时看到执行步骤。

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
  db/            Drizzle + SQLite
src/             看板前端（TanStack Start + React Query）
config/          agents.json、各 agent 提示词、系统规则、起草规则
drizzle/         数据库迁移（drizzle-kit 生成，启动时自动执行）
data/            运行数据，不进 git：cabinet.db（业务）、agents.sqlite（durable 对话）、memory/、stickers/
```

技术栈：TypeScript（Node 24+ 原生类型擦除）、`@earendil-works/pi-durable`（agent 驱动）、`@larksuiteoapi/node-sdk`、Drizzle ORM + better-sqlite3、TanStack Start、Vite 8（Rolldown + Oxc）、oxlint、oxfmt。

## agent 驱动

agent 跑在 [pi-durable](https://github.com/earendil-works/pi/tree/main/packages/durable) 上：对话、模型轮次、工具调用先落库再执行。

- 每个会话 key（话题、MR、群聊）对应一个 durable conversation，映射存在 `kv` 表的 `conv:<key>`。
- 每次提交带 requestId（`draft:<消息 id>`、`qa:<消息 id>`、`revise:<草稿 id>`）。进程崩溃或重启后，`pending:*` 里记着没跑完的任务，启动时用同一个 requestId 重新提交，接上原来那次运行，已经执行过的工具不会再跑。手动重试会换一个 requestId。
- 模型来自 `~/.pi/agent/models.json`（magpie 网关，openai-completions）。主模型额度用完或限流时，在同一会话里换 `PI_FALLBACK_MODEL` 接着跑。
- 工具：durable 自带的 read、bash，加上 cabinet 补的只读 grep / find / ls；守卫挂在 `beforeTool` 钩子上，策略同时存进 `kv`，所以重启恢复的运行也受约束。
- pi-durable 还是 Experimental 版本，依赖锁定在 1.5.0，升级前先跑 `pnpm check` 和真实调用。

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
