# Buffy Reader

一个跑在 **Cloudflare Workers 免费版**上的单人 RSS 阅读器：外部 PostgreSQL、Google Reader API（FreshRSS 客户端可直接接入）、由 **cron-job.org** 触发抓取。

设计上的核心约束是 Workers 免费版的 **10ms CPU / 请求**。因此抓取不是“一次抓所有订阅”，而是每次 cron 只处理少量到期订阅、返回一个很小的 JSON，由每分钟一次的 cron 累加完成。

## 功能

- 订阅源、文件夹、未读/收藏、搜索、OPML 导入导出
- RSS 0.9x / 2.0、Atom、RDF (RSS 1.0)、JSON Feed
- 条件请求（ETag / If-Modified-Since）、字符集识别（含 GBK 回退）、响应体大小上限
- 去重入库、失败指数退避（最长一天）、保留期与每订阅条数上限
- 服务端渲染的中文界面，移动端适配、暗色模式、`j/k/o/s/m` 快捷键
- Google Reader API v0，兼容 FreshRSS 路径 `/api/greader.php`
- 文章正文放在沙箱 iframe 中渲染，不执行第三方脚本
- 单用户，凭据全部来自环境变量

## 架构

```
cron-job.org (每 1–5 分钟)
        │  GET /api/cron/refresh  (Bearer CRON_SECRET)
        ▼
Cloudflare Worker ── Hyperdrive ──► 外部 PostgreSQL
   │  ├─ 抓取 1–2 个到期 Feed（条件 GET）
   │  ├─ 解析 / 去重 / 入库
   │  └─ 返回 <1KB JSON
   │
   ├─ 浏览器：SSR 页面 + 少量原生 JS
   └─ 客户端：/api/greader.php/reader/api/0/*
```

数据表：`users`、`feeds`（抓取状态、ETag、退避）、`subscriptions`（标题、文件夹）、`entries`（正文、时间）、`entry_states`（已读/收藏）。没有 D1/KV/R2，所有状态都在 PostgreSQL。

## 免费额度与容量

| 项目 | Workers Free | 影响 |
|---|---|---|
| 请求 | 100,000/天 | 个人使用远远够 |
| CPU | **10ms/请求** | 每次只抓 2 个 Feed，避免 1102 |
| 子请求 | 50/请求 | 一次抓取远低于上限 |
| 内存 | 128MB | 单次抓取响应限制 1.5MB |
| Hyperdrive | 免费版可用，约 20 条源库连接 | 每个请求一个短连接 |

容量估算：

```
可覆盖订阅数 ≈ MAX_FEEDS_PER_RUN × FETCH_INTERVAL_MINUTES ÷ cron 间隔（分钟）
默认：2 × 15 ÷ 1 = 30 个订阅
```

订阅更多时：降低 `FETCH_INTERVAL_MINUTES` 的收益有限，优先把 `MAX_FEEDS_PER_RUN` 调到 3（观察是否 1102），或改成每 5 分钟 cron 一次、把 `MAX_FEEDS_PER_RUN` 调到 5。每篇文章的抓取条数由 `MAX_ITEMS_PER_FETCH` 控制（默认 40）。

## 部署

### 0. 前置条件

- Cloudflare 账号（免费计划即可）
- 一个可从公网访问的 PostgreSQL 13+（Neon、Supabase、自建均可）
- 本机有 Node.js 20+ 或 Bun

### 1. 初始化数据库

```bash
bun install

DATABASE_URL="postgres://USER:PASSWORD@HOST:5432/DB?sslmode=require" \
  bun run db:migrate
```

也可以把 `schema.sql` 直接粘贴到数据库控制台的 SQL 编辑器执行。脚本是幂等的，升级时重复执行即可。

连接串注意事项：

- Neon / Supabase 一般需要 `?sslmode=require`，并且从“连接池”入口复制
- 数据库必须允许 Cloudflare 网络访问；Hyperdrive 发出连接，不是你本机
- 免费版数据库若会休眠，第一次抓取可能慢一两秒，属于正常现象

### 2. 创建 Hyperdrive

```bash
bunx wrangler login

bunx wrangler hyperdrive create buffy-reader \
  --connection-string="postgres://USER:PASSWORD@HOST:5432/DB?sslmode=require" \
  --caching-disabled
```

把输出的 `id` 填进 `wrangler.toml`：

```toml
[[hyperdrive]]
binding = "HYPERDRIVE"
id = "你的_hyperdrive_id"
```

> **务必带 `--caching-disabled`。** Hyperdrive 默认缓存读查询 60 秒，且写入不会让缓存失效。开着缓存时，你“标为已读”后刷新页面会看到它又变回未读。已经建错的配置可以这样改：
>
> ```bash
> bunx wrangler hyperdrive update <HYPERDRIVE_ID> --caching-disabled
> ```

### 3. 设置密钥

```bash
openssl rand -base64 32   # AUTH_SECRET
openssl rand -hex 24      # CRON_SECRET

bunx wrangler secret put ADMIN_PASSWORD
bunx wrangler secret put AUTH_SECRET
bunx wrangler secret put CRON_SECRET
```

`ADMIN_USERNAME` 默认 `admin`，可以在 `wrangler.toml` 的 `[vars]` 里改。

### 4. 部署

```bash
bunx wrangler deploy
```

打开 `https://<worker>.<subdomain>.workers.dev/login` 登录。检查 `GET /health` 返回 `{"ok":true}`。

### 5. 配置 cron-job.org

在 [cron-job.org](https://cron-job.org) 建两个任务：

**抓取任务**

- URL：`https://<worker>/api/cron/refresh`
- 方法：`GET`
- 执行频率：每 1 分钟（或 5 分钟）
- 自定义 Header：`Authorization: Bearer <CRON_SECRET>`
- 超时：30 秒（服务端会在 20 秒左右主动收尾）

**清理任务（每天一次）**

- URL：`https://<worker>/api/cron/refresh?cleanup=1`
- 方法与 Header 同上
- 频率：每天一次，例如凌晨

cron-job.org 免费版的几个限制已经考虑过：最小间隔 1 分钟、单次 30 秒超时、最多读取 64KB 响应、连续失败 25 次自动停用。建议开启失败邮件通知。

手动验证：

```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" \
  "https://<worker>/api/cron/refresh"
```

正常响应（很小）：

```json
{"ok":true,"processed":2,"inserted":7,"errors":0,"remaining":14,"cleanup":null,"ms":812,
 "results":[{"feed":1,"status":"updated","inserted":7},{"feed":2,"status":"not-modified","inserted":0}]}
```

如果不想用 Header，也可以 `?token=<CRON_SECRET>`，但 URL 会进日志，安全性差一些。

## 客户端接入

| 客户端类型 | 服务器地址 |
|---|---|
| FreshRSS 模式（Reeder、Fiery Feeds、FeedMe 等） | `https://<worker>/api/greader.php` |
| Google Reader 模式 | `https://<worker>` |

- 用户名：`ADMIN_USERNAME`（默认 `admin`）
- 密码：`ADMIN_PASSWORD`
- 需要 token 的客户端：登录网页后在「设置」页复制 Auth token（等同密码）

手动测试：

```bash
curl -s -X POST https://<worker>/api/greader.php/accounts/ClientLogin \
  -d "Email=admin&Passwd=$ADMIN_PASSWORD"
# 返回 SID=... / LSID=... / Auth=...

curl -s -H "Authorization: GoogleLogin auth=<Auth>" \
  "https://<worker>/api/greader.php/reader/api/0/unread-count"
```

已实现的端点：

```
POST /accounts/ClientLogin
GET  /reader/api/0/user-info
GET  /reader/api/0/token
GET  /reader/api/0/check
GET  /reader/api/0/subscription/list
POST /reader/api/0/subscription/edit        (subscribe / unsubscribe / edit)
GET|POST /reader/api/0/subscription/quickadd
GET  /reader/api/0/tag/list
GET  /reader/api/0/unread-count
GET  /reader/api/0/stream/contents[/*]
GET  /reader/api/0/stream/items/contents
GET  /reader/api/0/stream/items/ids
POST /reader/api/0/edit-tag
POST /reader/api/0/mark-all-as-read
POST /reader/api/0/rename-tag
```

所有端点同时挂在 `/api/greader.php` 下，因此 FreshRSS 客户端无需额外适配。Auth 支持 `GoogleLogin auth=`、`Bearer`、HTTP Basic 和网页会话 cookie；`T` 参数存在时会校验。

## 环境变量

| 变量 | 必需 | 默认 | 说明 |
|---|---|---|---|
| `HYPERDRIVE` | 是* | — | Hyperdrive 绑定名（`wrangler.toml`） |
| `DATABASE_URL` | 本地开发 | — | 无 Hyperdrive 时使用；生产不建议 |
| `ADMIN_USERNAME` | 否 | `admin` | 登录用户名 |
| `ADMIN_PASSWORD` | **是** | — | 登录密码，同时用于客户端 |
| `AUTH_SECRET` | **是** | — | 签名会话与 token，≥16 字符 |
| `CRON_SECRET` | 建议 | — | 未设置时 cron 接口返回 503 |
| `SITE_NAME` | 否 | `Buffy Reader` | 页面标题 |
| `FETCH_INTERVAL_MINUTES` | 否 | `15` | 每个 feed 的轮询间隔 |
| `MAX_FEEDS_PER_RUN` | 否 | `2` | 每次 cron 抓几个（控制 CPU） |
| `MAX_ITEMS_PER_FETCH` | 否 | `40` | 每个 feed 每次最多入库多少篇 |
| `RETENTION_DAYS` | 否 | `120` | 已读且未收藏文章的保留天数 |
| `MAX_ENTRIES_PER_FEED` | 否 | `500` | 每个 feed 的条数上限（收藏除外） |
| `USER_AGENT` | 否 | `BuffyReader/1.0` | 抓取 Feed 时使用 |

修改密码或 `AUTH_SECRET` 后重新 `wrangler secret put` 即可；`AUTH_SECRET` 变更会让所有网页会话和客户端 token 失效。

## 本地开发

```bash
cp .dev.vars.example .dev.vars
# 编辑 .dev.vars：DATABASE_URL、ADMIN_PASSWORD、AUTH_SECRET、CRON_SECRET

DATABASE_URL="postgres://..." bun run db:migrate
bun run dev
```

`wrangler dev` 下 Hyperdrive 需要本地连接串，二选一：

```toml
[[hyperdrive]]
binding = "HYPERDRIVE"
id = "..."
localConnectionString = "postgres://postgres:postgres@127.0.0.1:5432/reader"
```

或设置环境变量：

```bash
CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="postgres://..." bun run dev
```

## 测试与检查

```bash
bun test                # PGlite 跑真实 schema + 真实 SQL
bun run typecheck       # tsc --noEmit
bunx wrangler deploy --dry-run --outdir dist   # 验证 Worker 打包
```

测试覆盖：四种 Feed 格式解析、OPML、ClientLogin / 订阅 / 未读计数 / edit-tag / mark-all-as-read、网页登录与文章状态、抓取去重 / 304 / 错误退避、cron 鉴权与刷新、清理策略、健康检查。

测试使用 [PGlite](https://electric-sql.com/docs/pglite)（WASM 版 PostgreSQL）直接执行 `schema.sql`，因此 SQL 语法和约束是真实的；但它**不能**替代对真实 Hyperdrive / 你的数据库连通性的验证。

## 运维

- 日志：`bunx wrangler tail`
- 健康检查：`GET /health`（会实际执行 `select 1`）
- 单个订阅抓取失败：在「订阅管理」里能看到连续失败次数和最后错误；退避最长 24 小时
- 想立刻抓取：点「立即抓取」只是把 `next_fetch_at` 设为现在，真正执行仍在下一分钟 cron
- 数据库增长：清理任务会删除超过保留期且已读、未收藏的文章，并按 `MAX_ENTRIES_PER_FEED` 裁剪
- 出现 `1102 Worker exceeded CPU time limit`：把 `MAX_FEEDS_PER_RUN` 降到 1，把 `MAX_ITEMS_PER_FETCH` 降到 20，或降低 cron 频率
- 连接数据库失败：检查 Hyperdrive 的源库连接串、SSL、数据库是否允许 Cloudflare 访问；Hyperdrive 与源库最好在相近区域

## 安全说明

- 密码只存在于 Worker secret 中，不落库；网页登录用 HMAC 签名的 HttpOnly + SameSite=Lax cookie
- GReader token 是无状态 HMAC，Worker 重启不会让客户端掉线；`AUTH_SECRET` 轮换即可全部失效
- 文章 HTML 一律放进 `sandbox` iframe（无 `allow-scripts`），即使正文含脚本也不会执行
- 所有 SQL 参数化；订阅 URL 只允许 http/https
- cron 接口必须带密钥；所有写操作走 POST
- 单用户应用：若部署在公开域名，建议再加一层 Cloudflare Access，或使用足够长的随机密码

## 与 FreshRSS 的差距

已实现核心阅读能力和客户端兼容；以下明确未实现：

- 多用户、用户自助改密
- 插件/扩展系统
- Fever API（GReader 已覆盖大多数客户端）
- WebSub / PubSubHubbub 实时推送
- 文章分享、主题系统
- 正文全文抽取（只展示 Feed 提供的正文）
- 一个订阅属于多个文件夹（当前只支持一个）

## 目录

```
src/
  index.ts         Worker 入口、数据库中间件、健康检查
  config.ts        环境变量与默认值
  db.ts            pg / PGlite 共用的查询层
  auth.ts          单用户鉴权、会话、GReader token
  stream.ts        Google Reader stream id 解析
  store.ts         全部 SQL
  ingest.ts        抓取、解析入库、订阅、批量刷新
  greader.ts       Google Reader API
  web.ts           网页路由、OPML、状态 API
  views.ts         HTML/CSS/少量 JS
  cron.ts          /api/cron/refresh
  feed/parse.ts    RSS/Atom/RDF/JSON Feed 解析
  feed/fetch.ts    条件请求、字符集、大小限制、Feed 自动发现
  opml.ts          OPML 导入导出
schema.sql         数据库结构（幂等）
scripts/migrate.ts 迁移脚本
test/              PGlite 集成测试 + 解析器测试
wrangler.toml      Worker / Hyperdrive 配置
```

## 冒烟测试清单

部署后按顺序验证：

1. `/health` 返回 `{"ok":true}`
2. 用 `ADMIN_PASSWORD` 登录网页
3. 添加一个真实 Feed，看到“已添加”；等下一次 cron 后列表出现文章
4. 打开文章，返回列表后它保持已读（若又变未读，检查 Hyperdrive 缓存是否已禁用）
5. 点收藏，刷新后仍为收藏
6. 用 curl 跑一遍 ClientLogin + `unread-count`
7. 在客户端（Reeder / Fiery Feeds）添加账号，能拉取订阅和文章
8. 手动 `curl` 一次带 `?cleanup=1` 的 cron，确认返回 JSON 且小于 64KB
9. 导出 OPML，再导入到另一个阅读器，订阅和文件夹正确
