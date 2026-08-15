# Producer

多人协同的 AI 媒体创作工作台：组织 → 项目 → studio 画布，画布上每个节点是一次 AI 生成或一次文件上传。整站是部署在 Cloudflare Workers 上的 TanStack Start 应用。

技术栈：TanStack Start / Router / Query + React 19（React Compiler）、Tailwind v4 + Base UI、React Flow（画布）、Yjs + y-partyserver + Durable Object（协同）、Drizzle ORM + Postgres（经 Hyperdrive）、better-auth（organization 插件）、R2（媒体存储）、Paraglide（i18n）。

## 本地开发

前置：Node + pnpm、一个 Postgres 实例、一份 R2 的 S3 凭证（上传走浏览器直传真实 R2，本地也不例外）。

1. 在仓库根建 `.env.local`，填 `DATABASE_URL`、`BETTER_AUTH_URL` / `BETTER_AUTH_SECRET`、`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`、`VITE_GOOGLE_CLIENT_ID`、`AI_GATEWAY_API_KEY`、`R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET`（本地桶是 `producer-media-dev`）。
2. 注意：`DATABASE_URL` 只供 drizzle-kit（`db:generate` / `db:migrate` / `db:studio`）使用，**应用运行时不读它**——dev 下数据库走 Hyperdrive 绑定的本地模拟，连接串来自 `wrangler.jsonc` 里 hyperdrive 的 `localConnectionString`。把它改成你自己的 Postgres 连接串（或设环境变量 `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE`），并保证与 `DATABASE_URL` 指向同一个库，否则迁移建表的库和应用连的库是两个地方。
3. `pnpm install`
4. `pnpm db:migrate` 应用 `drizzle/` 下的迁移（改了 `src/db/schema.ts` 之后先 `pnpm db:generate` 写一份新的）。
5. `pnpm dev`，默认 http://localhost:3000（R2 桶 CORS 只放行了 3000 端口的源，换端口上传会被拒）。

双人协同测试：第二个账号开 `http://app.localhost:3000`（独立 cookie jar；localhost 的 cookie 不分端口，同端口换账号会串）。

## 常用命令

```bash
pnpm dev                # dev server
pnpm build              # vite build
pnpm deploy             # build + wrangler deploy
pnpm lint               # oxlint
pnpm format             # oxfmt
pnpm db:generate        # 由 schema 生成迁移
pnpm db:migrate         # 应用迁移
pnpm db:studio          # drizzle studio
pnpm exec tsc --noEmit  # 类型检查
```

仓库没有测试框架，没有 `pnpm test`。

## 部署

`.env.local` 不会随 `wrangler deploy` 上去：线上同名变量要经 `wrangler secret put`（或 dashboard）配置，`wrangler.jsonc` 里 hyperdrive 的占位 id 也要换成真实值，线上 `R2_BUCKET` 对齐 `producer-media`。

## 更多

架构要点、协同与资产层的不变量、本地开发的坑，见 [CLAUDE.md](CLAUDE.md)（面向 AI 编码代理写的仓库指南，人也照读）。
