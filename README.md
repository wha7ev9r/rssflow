# Buffy Reader

一个跑在 **Cloudflare Workers 免费版**上的单人 RSS 阅读器：外部 PostgreSQL、Google Reader API（FreshRSS 客户端可直接接入）、由 **cron-job.org** 触发抓取。

设计上的核心约束是 Workers 免费版的 **10ms CPU / 请求**。因此抓取不是“一次抓所有订阅”，而是每次 cron 只处理少量到期订阅、返回一个很小的 JSON，由每分钟一次的 cron 累加完成。

## 功能

- 订阅源、文件夹、未读/收藏、搜索、OPML 导入导出
- RSS 0.9x / 2.0、Atom、RDF (RSS 1.0)、JSON Feed
- 条件请求（ETag / If-Modified-Since）、字符集识别（含 GBK 回退）、响应体大小上限
- 去重入库、失败指数退避（最长一天）、保留期与每订阅条数上限
- 服务端渲染的中文阅读界面：墨青色重点、清晰的已读/未读层次、长文排版，字体和图标不依赖外部请求
- 移动端订阅列表可折叠，暗色模式跟随系统；支持可见键盘焦点、跳到正文、减少动态效果及 `j/k/o/s/m` 快捷键
- 收藏操作有保存状态与失败回退，文章正文高度随窗口和图片加载调整
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

数据表：`users`、`feeds`（抓取状态、ETag、退避）、`subscriptions`（标题、文件夹）、`entries`（正文、时间）、`entry_states`（已读/收藏）、`entry_seen`（持久 GUID 去重登记）。没有 D1/KV/R2，所有状态都在 PostgreSQL。

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

- **首次搭建**照着下面 1–8 步走完。
- **已有实例升级当前代码**只看「升级已有实例」，注意先迁移数据库再发布新代码。
- 部署后按「上线验收」逐条核对。只看到示例文字、HTTP 200 或构建页变绿，都不代表部署成功。

### 0. 前置条件

| 需要 | 说明 |
|---|---|
| Cloudflare 账号 | 免费计划即可；需要 Workers、Hyperdrive 权限 |
| 公网 PostgreSQL 13+ | Neon、Supabase 或自建均可，必须能从 Cloudflare 网络连入 |
| Bun | 用于安装依赖、跑测试和迁移脚本 |
| 自定义域名（可选） | 域名的 DNS 必须托管在同一 Cloudflare 账号下，才能用 Custom Domain |

仓库里的 `wrangler.toml` 已绑定实践中的 Worker 名 `rssflow` 和一个 Hyperdrive ID。自建部署时**这两个值都要替换成你自己的**，否则会部署到别人的 Worker。

### 1. 安装并本地检查

```bash
bun install --frozen-lockfile
bun test           # 85 项，含抓取、GReader、保留策略和界面回归
bun run typecheck
```

改造过代码再执行一次安全审计（需要连 npm 官方 advisory 端点，镜像没有）：

```bash
BUN_CONFIG_REGISTRY=https://registry.npmjs.org bun audit
```

想在本地看界面：复制 `.dev.vars.example` 为 `.dev.vars`（已被 `.gitignore` 忽略）并填好三项密钥，执行 `bun run dev`。本地也可以用 `DATABASE_URL` 直连数据库；有 `HYPERDRIVE` 绑定时优先用它。

### 2. 初始化数据库

```bash
DATABASE_URL="postgres://USER:PASSWORD@HOST:5432/DB?sslmode=require" \
  bun run db:migrate
```

也可以把 `schema.sql` 整份粘贴到数据库控制台的 SQL 编辑器执行。脚本全部是 `if not exists` / `on conflict do nothing`，**重复执行是安全的**，升级时同样用它。

连接串注意事项：

- Neon / Supabase 一般要 `?sslmode=require`；Hyperdrive 自己会做连接池，所以从**直连**入口复制（例如 Neon 去掉 `-pooler`），不要再套一层 PgBouncer。
- 连接是 Hyperdrive 从 Cloudflare 网络发起的，不是你的本机；数据库防火墙要放行 Cloudflare 的 IP 段。
- 免费数据库会休眠，迁移之后第一次抓取慢一两秒属正常现象。

### 3. 创建 Hyperdrive

```bash
bunx wrangler login
bunx wrangler hyperdrive create <配置名> \
  --connection-string="postgres://USER:PASSWORD@HOST:5432/DB?sslmode=require" \
  --caching-disabled
```

把输出里的 `id` 填进 `wrangler.toml`：

```toml
[[hyperdrive]]
binding = "HYPERDRIVE"
id = "你的_hyperdrive_id"
```

> **必须带 `--caching-disabled`。** Hyperdrive 默认缓存读查询 60 秒，而且写入不会让缓存失效：标为已读后刷新页面又会变回未读。已经建错的配置这样修：
>
> ```bash
> bunx wrangler hyperdrive update <HYPERDRIVE_ID> --caching-disabled
> ```

### 4. 设置运行密钥

```bash
# 生成长随机值，不要把输出贴进仓库或聊天
openssl rand -base64 32   # AUTH_SECRET
openssl rand -hex 24      # CRON_SECRET

bunx wrangler secret put ADMIN_PASSWORD
bunx wrangler secret put AUTH_SECRET
bunx wrangler secret put CRON_SECRET
```

- 三条命令都走交互式隐藏输入；`AUTH_SECRET` 至少 16 字符，建议 32 位以上随机值。
- 三个值**必须是 Secret**，不能是控制台里的普通文本变量：既符合最小暴露原则，也避免下一次 Git 构建部署时被 `wrangler.toml` 的 `[vars]` 覆盖。
- `ADMIN_USERNAME` 默认 `admin`，需要改就写在 `wrangler.toml` 的 `[vars]` 里。
- `wrangler secret put` 会立即发布一个新版本；如果只想先生成版本、择机上线，用 `wrangler versions secret put` 再 `wrangler versions deploy`。

### 5. 发布 Worker

```bash
bunx wrangler deploy
```

默认发布到 `https://<worker>.<子域>.workers.dev`。`wrangler.toml` 里的 `name` 决定 Worker 名，接 Git 后也要与 Workers Builds 里配置的 Worker 名一致。

### 6. 绑定域名（可选）

**Custom Domain（推荐，Worker 就是源站）**：

1. 先确认该主机名没有已有 DNS 记录（Custom Domain 不能建在已有 CNAME 上），有就先删掉。
2. 控制台 *Workers & Pages → 选 Worker → Settings → Domains & Routes → Add → Custom Domain*，填 `reader.example.com`。DNS 记录和证书由 Cloudflare 自动创建。
3. 想用配置文件管理，就加：

```toml
[[routes]]
pattern = "reader.example.com"
custom_domain = true
```

然后重新 `wrangler deploy`。注意：**用 Wrangler 部署会以配置文件为准**，只在控制台加过的变量或路由，下次从命令行部署时可能被覆盖，所以域名要么写进配置，要么一直只在控制台管理。

**Route（Worker 挂在已有源站前面）**：需要先有一个橙色云代理的 DNS 记录，没有真实源站就放一条指向 `100::` 的代理 `AAAA`，然后：

```toml
[[routes]]
pattern = "shop.example.com/*"
zone_name = "example.com"
```

线上暴露到公网时建议再叠一层 Cloudflare Access（单用户应用，多一把锁更稳）。

### 7. 配置 cron-job.org

建两个任务：

**抓取任务**

- URL：`https://<你的域名>/api/cron/refresh`
- 方法：`GET`
- 频率：每 1 分钟（或 5 分钟）
- Header：`Authorization: Bearer <CRON_SECRET>`
- 超时：30 秒（抓取预算默认 20 秒，每次 HTTP 超时不超过剩余预算；数据库查询和清理不受硬截止保证）

**清理任务**

- URL：`https://<你的域名>/api/cron/refresh?cleanup=1`
- 方法与 Header 同上，每天一次，例如凌晨

cron-job.org 免费版的限制已经考虑过：最小间隔 1 分钟、单次 30 秒、响应最多读取 64KB、连续失败 25 次自动停用，建议开启失败邮件通知。手测一次：

```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" \
  "https://<你的域名>/api/cron/refresh"
```

正常响应很小：

```json
{"ok":true,"processed":2,"inserted":7,"errors":0,"remaining":14,"cleanup":null,"ms":812,
 "results":[{"feed":1,"status":"updated","inserted":7},{"feed":2,"status":"not-modified","inserted":0}]}
```

不想用 Header 也可以用 `?token=<CRON_SECRET>`，但 URL 会进日志，安全性差一些。

可选的 `?feed=<数字ID>` 只是筛选目标源，仍然只领取到期任务，**不会**强行绕过其他 cron 的领取租约。要提前刷新，先在网页里「安排刷新」，再等 cron 领取。普通并发 cron 用 PostgreSQL 原子领取；HTTP、解析、入库失败都会记录错误并指数退避。抓取运行中别反复手动重新排队，那会改掉到期时间。

### 8. 可选：接 Workers Builds 自动部署

- 设置 → Build：Build command 填 `bun install --frozen-lockfile`，Deploy command 保持 `npx wrangler deploy`。Workers Builds 会用 `package.json` 里锁定的 Wrangler 版本。
- 生产分支（默认 `main`）之外的 Preview 构建默认只上传版本，不会改生产流量；要独立的预览环境就用 Wrangler environment 或另一个 Worker。
- **构建页变绿只说明这一步成功。** 生产到底在跑哪份代码，看「上线验收」第 1 条。

## 升级已有实例

当前**必须**升级数据库：新增了 `entry_seen` 持久去重登记，用来防止清理后的旧文章下次抓取又变成未读。

顺序很重要，**先迁移、后部署**：

1. **备份数据库**，确认包含新表结构；备份和恢复都要带上 `entry_seen`。
2. **暂停写入**：停掉 cron-job.org 的两个任务，别在网页上添加、删除订阅或标记状态。
3. **执行迁移**：

   ```bash
   DATABASE_URL="postgres://..." bun run db:migrate
   ```

   迁移会建表并从现有 `entries` 回填登记，重复执行无害。
4. **发布新代码**：`bunx wrangler deploy`，或推送到生产分支让 Workers Builds 构建。
5. **核对生产版本真的换了**（见下一节第 1 条），这一步最容易被跳过。
6. **恢复 cron-job.org**，观察第一次抓取返回的 JSON。

**升级影响说明：**

- 清理正文后仍保留 GUID；登记只存标识不存正文，但会随该订阅历史文章数量一直增长，退订并删除源时级联清理。**不要**定期清这张表，清了旧文章就会再次复活。
- 已经在旧版本里彻底删除的历史文章无法回填，升级后可能重新出现一次，手动标为已读即可。
- 旧版本中 `description` 为空、且没有标题、日期、链接的文章，曾统一用 `guid="|"` 去重，现在改用正文哈希；那一条可能重复出现一次，不影响其他文章。
- 回滚 Worker 代码本身不会撤销迁移（新表对旧代码只是多出来的），但清理逻辑依赖登记表，回滚后旧问题会回来。

## 上线验收

HTTP 200 不是成功标准，按顺序核对：

1. **生产在跑哪个版本**：

   ```bash
   bunx wrangler deployments list
   bunx wrangler versions list
   ```

   把列表里占 100% 流量的 Version ID，和 Git 构建产出的 Version ID 对一下。最近改过控制台密钥要再核一次——`secret put` 也会生成新版本并立刻接管。之前就出现过「构建成功，但线上不是那个版本」，页面停在示例代码的情况。

2. **配置齐全**：`GET /login` 应是登录页。看到「还需要完成配置」说明 `ADMIN_PASSWORD` / `AUTH_SECRET` 或数据库绑定缺失，这时的 500 是预期行为，不是部署失败。

3. **数据库连得通**：`GET /health` 返回 `{"ok":true,...}`；返回 `database unreachable` 就去查 Hyperdrive 连接串、SSL、数据库白名单。

4. **网页能用**：用 `ADMIN_PASSWORD` 登录 → 加一个真实订阅 → 等下一次 cron → 列表出现文章 → 打开一篇 → 返回后它保持已读（又变回未读就检查 Hyperdrive 缓存）→ 收藏后刷新仍是收藏。

5. **cron 通了**：手动 curl 一次，返回 `ok: true` 且响应小于 64KB。

6. **客户端能接**：用 Google Reader 模式或 FreshRSS 模式登录，能拉到订阅和文章。

7. **页面没跑偏**：手机上订阅列表默认折叠、能展开；系统切到暗色后配色正确；`j/k/o/s/m` 快捷键可用。

## 常见故障

| 现象 | 排查方向 |
|---|---|
| 打开域名只看到 `Hello world` | 本仓库**没有**这个响应，说明域名指向的不是本仓库代码。按验收第 1 条找活动版本，核对 Custom Domain 绑定的 Worker 和环境；删掉控制台残留的示例草稿，重新部署后再验收 |
| 「还需要完成配置」 | 三个 Secret 没设、设成了普通文本变量，或被 Git 构建覆盖 |
| 登录后立刻跳回登录页 | `AUTH_SECRET` 改过导致旧会话失效，重新登录即可；服务器时间偏移也会让签名过期 |
| 标为已读又变回未读 | Hyperdrive 缓存没关，见第 3 步 |
| `/health` 返回 `database unreachable` | 连接串、`sslmode`、数据库白名单，或用了会休眠的免费库 |
| cron 返回 401 | Header 和 `CRON_SECRET` 不一致，有些平台会自动加引号 |
| cron 返回 503 | 没配 `CRON_SECRET`，接口会主动拒绝 |
| `1102 Worker exceeded CPU time limit` | 把 `MAX_FEEDS_PER_RUN` 降到 1、`MAX_ITEMS_PER_FETCH` 降到 20，或降低 cron 频率 |
| 文章一直不出现 | cron 是否在跑、订阅是否到期；订阅管理里看连续失败次数和最后错误（退避最长 24 小时） |
| `wrangler deploy` 报 Worker 名不一致 | `wrangler.toml` 的 `name` 必须和 Workers Builds 里配置的 Worker 名一致 |

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

所有端点同时挂在 `/api/greader.php` 下，因此 FreshRSS 客户端无需额外适配。支持标准 POST 表单及重复的 `i`/`a`/`r` 参数。完整文章 ID 使用 `tag:google.com,2005:reader/item/<16位hex>`，ID 列表使用十进制 uint64，并支持 `continuation` 分页。`ot`/`nt` 是秒级抓取时间下/上界，`timestampUsec` 和批量已读的 `ts` 使用微秒。

Auth 支持 `GoogleLogin auth=`、`Bearer`、HTTP Basic、查询 token 和网页会话 cookie。写操作（含 GET quickadd）使用明确的有效 Authorization 时可省略 `T`；仅凭 cookie/查询 token 时必须提供正确 `T`。凡提供 `T` 都会校验，跨源浏览器写请求会被拒绝。

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

测试覆盖：四种 Feed 格式解析（含 XHTML 混排）、OPML 与导入上限、ClientLogin / 订阅 / 未读计数 / edit-tag / mark-all-as-read / 分页与时间范围、网页登录与文章状态、抓取原子领取与错误退避、cron 鉴权与刷新、清理与持久去重、健康检查、CSRF 与请求体上限、界面结构与可访问性契约。

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
- cron 接口必须带密钥；网页写操作走 POST，跨源浏览器写请求被拒绝，JSON 状态接口只接受 `application/json`
- 全局请求体上限 1 MiB；OPML 文件上限 512 KiB、每次 200 个订阅、文件夹嵌套最多 32 层，超限会在导入前拒绝而不部分写入
- 私有响应使用 `Cache-Control: no-store`；向其他站点不发送页面 Referer
- 文章页「标为未读」后返回未读列表，避免重新打开文章又被自动标为已读
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
  views.ts         HTML 模板、内联图标与少量原生交互
  styles.ts        阅读器与文章正文的内联样式、暗色与响应式布局
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

已并入上方「上线验收」，不另外维护：

- 第 3 条对应 `/health`；第 4 条对应登录、加订阅、已读和收藏。
- 第 5 条对应 cron；手测时可额外跑一次带 `?cleanup=1` 的请求，确认返回 JSON 且小于 64KB。
- 第 6 条对应 curl 跑 `ClientLogin` + `unread-count`，以及在 Reeder / Fiery Feeds 里添加账号。
- 验收没覆盖、但值得顺手做的两点：导出 OPML 再导入到另一个阅读器，确认订阅和文件夹正确；用两种客户端模式（Google Reader / FreshRSS）各接一次。
