# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概览

Producer 是多人协同的 AI 媒体创作工作台：组织 → 项目 → studio 画布，画布上每个节点是一次 AI 生成或一次文件上传。整站是部署在 Cloudflare Workers 上的 TanStack Start 应用。

技术栈：TanStack Start / Router / Query + React 19（开启 React Compiler）、Vite、Tailwind v4 + Base UI + tailwind-variants、React Flow（画布）、Yjs + y-partyserver + Durable Object（协同）、Drizzle ORM + Postgres（经 Hyperdrive）、better-auth（organization / sso / scim 插件）、R2（媒体字节）、Paraglide（i18n）。

## 常用命令

```bash
pnpm dev                # Vite dev server，默认 3000，读 PORT 覆盖
pnpm build              # vite build
pnpm deploy             # build + wrangler deploy
pnpm lint               # oxlint
pnpm format             # oxfmt
pnpm cf-typegen         # wrangler types -> worker-configuration.d.ts
pnpm db:push            # 把 src/db/schema.ts 直接推到库
pnpm db:studio
pnpm exec tsc --noEmit  # 类型检查（没有 typecheck 脚本）
```

- 仓库**没有测试框架**，不存在测试命令，不要臆造 `pnpm test`。
- 改 `wrangler.jsonc` 的绑定或新增 `env` 变量后必须跑 `pnpm cf-typegen`，否则 `cloudflare:workers` 的 `env` 上没有类型。
- 本仓库**没有 `drizzle/` 迁移目录**，schema 变更走 `db:push` 而不是 `db:generate` / `db:migrate`。
- `src/routeTree.gen.ts` 和 `src/paraglide/` 是 vite 插件的生成产物，不要手改（路由树也可 `pnpm generate-routes`）。
- 环境变量在 `.env.local`（`DATABASE_URL`、`BETTER_AUTH_*`、`GOOGLE_*`、`R2_*`）：`drizzle.config.ts` 从这里读连接串，Worker 运行时读同名 `env`。

## 架构要点

### Worker 入口不是 Start 的默认入口

`src/server.ts` 是 wrangler 的 `main`，做三件事：导出 `CanvasRoom` DO 类（不导出等于绑定指向空）；先用 `routePartykitRequest` 拦下 `/parties/canvas-room/:projectId` 的 WebSocket 升级（Start 没有 WebSocket 通道，落进去会变成 HTML）；其余请求交给 `handler.fetch(request)`。`scheduled` handler 跑资产清扫。

### 租户与鉴权

- better-auth + organization 插件。新用户在 `databaseHooks` 里自动获得个人组织；新会话若无 `activeOrganizationId` 兜底到个人组织。
- **租户范围永远取自会话的 `activeOrganizationId`，绝不接受客户端传来的 organizationId。**
- 两个访问闸门都在服务端，且都重新 join `member` 表校验成员关系（不信任会话快照里的成员身份）：`src/server/canvas-access.ts` 的 `getProjectAccess`、`src/server/asset-access.ts` 的 `requireAssetAccess`。它们接受 `Headers` 而非 Request——WebSocket 升级、DO alarm、server function 手里各自只有 headers。
- **`createServerFn` 是裸 HTTP 端点，`_auth` 路由守卫管不到它**，每个 handler 必须自己解析会话。
- id 一律小写 uuidv7；闸门在查库前就拒掉非小写/非 uuid 的 id（DO 房间名按字节区分大小写，大写 URL 会分叉出第二个画布）。

### 画布协同（`src/lib/canvas/*`、`src/server/canvas-room.ts`、`use-canvas-collab.ts`）

- 每个项目一个 `CanvasRoom` Durable Object，房间名 = projectId，快照按 1MB 分块存在自己的 SQLite 里（`onSave` 全量重写），`static options = { hibernate: true }`。
- 文档是三个顶层 Y.Map：`nodes`（几何）、`nodeData`（节点 data）、`edges`。**几何与 data 必须分开**：Y.Map 同 key 并发写是整条记录 LWW，拖拽流若与"生成完成"补丁共用一条记录会把结果冲掉。`selected/dragging/measured/resizing` 永不入档。
- DO 的 alarm 每 5 分钟用连接上保存的 cookie 重放访问校验，撤权即断连。
- `use-canvas-collab.ts` 是唯一写入口：本地变更同时写 React state 和 Y.Map（`localOrigin` 用来区分本地/远端事务），手势写入走 60ms trailing 节流、手势结束必写；光标走 awareness；20s 心跳（y-partyserver 关掉了协议自带的续期）。生成超时看门狗按 `data.requestedAt` 的年龄判定，不依赖 awareness（DO 休眠唤醒后 awareness 是空表）。
- `createCanvasSession` 必须显式传 `protocol`：provider 默认按主机名猜协议，`app.localhost` 之类会被猜成 wss。

### 资产层（`asset` 表 + R2）

核心不变量：**行先于字节，墓碑先于删字节**。所以桶里永远不会有数据库不认识的对象，代价是需要 `src/server/asset-sweep.ts` 的 cron 清扫（24h 宽限期后回收 tombstoned / 长期 pending / failed 三类行）。

- 上传三步：`POST /api/assets`（校验 mime 与大小 → 插 pending 行 → 返回预签名 PUT URL）→ 浏览器直传 R2（字节不经过 Worker）→ `POST /api/assets/:id/complete`（`head()` 实测大小与 ETag，翻 ready）。预签名同时签死 Content-Type 与 Content-Length（`aws4fetch` 需要 `allHeaders: true`，否则只签 host）。
- 生成两步（`src/lib/generate-asset.ts`）：`startGeneration` 只建行并返回 assetId，客户端先把 id 绑到画布节点，再 `runGeneration` 跑 provider 并把字节 bind 回行（`where status='pending' and deleted_at is null`；bind miss 说明行已被删或被别的 run 抢先）。模型 provider 的接缝在 `src/server/generation/provider.ts`，目前只有 `sampleProvider` 桩。
- `/api/assets/:id/content` 是唯一出字节的地方：同源带 cookie、每次请求重新鉴权、比对行上记录的 ETag（预签名 URL 在完成后仍有效，ETag 变了就当不存在）、mime 只按白名单内联，Range 与条件请求手工归一化（workerd 的 `object.range` 在整读时也非空，206 必须以 `request.headers.has("range")` 为准）。
- `src/lib/asset-constraints.ts` 的 `ALLOWED_MIME` / `MAX_BYTES` 两端共用：客户端那次只是提前失败的礼貌，服务端必须再查一次。SVG 故意不在图片白名单里（内联服务会变成存储型 XSS）。

### 数据访问

`getDB()`（`src/db/index.ts`）按 Request 用 WeakMap 缓存连接池，走 Hyperdrive 连接串、`maxUses: 1`。schema 在 `src/db/schema.ts`，id 默认值是 Postgres 的 `uuidv7()`；需要在插入前知道 id（object key 里嵌了 id）时先 `select uuidv7()` 取一个。

### 前端约定

- 路径别名 `#/*` 与 `@/*` 都指向 `src/`，代码里统一用 `#/`。
- 路由在 `src/routes/`：`_auth` 做会话守卫并把 session 放进 route context；`_auth/studio/$projectId/route.tsx` 这层负责 loader 与文档标题，子路由从 query 缓存读。API 路由用 `createFileRoute(...).server.handlers`。
- `components/ui/` 是 Base UI + `tailwind-variants` 的薄封装（暗色主题，样式挂 `data-*` 而非伪类）；`components/block/` 是业务块，画布相关全在 `components/block/studio/`。
- 第三方 CSS 用 `@import ... layer(base)` 引入（React Flow、video.js 的样式表无 layer，否则会盖过 utility）。
- 文案走 Paraglide：`messages/*.json` → 生成 `src/paraglide/`，策略 `["url", "baseLocale"]`。

## 本地开发的已知坑

- 双人协同测试：第二个账号开 `http://app.localhost:3000`（独立 cookie jar，已加进 `auth.ts` 的 `trustedOrigins`）。localhost 的 cookie 不分端口，同端口换账号会串。
- `r2_buckets` 的 `"remote": true` 是刻意的：预签名直传总是打真实 R2，本地模拟绑定会读到另一个桶。本地绑到 `producer-media-dev`。
- R2 桶 CORS 按 origin（含端口）放行，目前只配了 3000 端口的两个源；用别的端口起 dev server 上传会被 CORS 拒。

## 代码风格

- 注释写"为什么"，不写"是什么"。现有代码里大量块注释记录权衡与失败模式，改动时保持这个密度，推翻某个决定时同步更新对应注释。
- `oxfmt` 负责格式化（无尾逗号、import 排序、tailwind class 排序），`oxlint` 只开 correctness 类。
- 提交信息用中文 Conventional Commits，例如 `feat(studio): 画布接入多人协同`。
