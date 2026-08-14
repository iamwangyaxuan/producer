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
pnpm db:generate        # 由 src/db/schema.ts 生成 drizzle/ 下的迁移
pnpm db:migrate         # 应用尚未执行的迁移
pnpm db:studio
pnpm exec tsc --noEmit  # 类型检查（没有 typecheck 脚本）
```

- 仓库**没有测试框架**，不存在测试命令，不要臆造 `pnpm test`。
- 改 `wrangler.jsonc` 的绑定或新增 `env` 变量后必须跑 `pnpm cf-typegen`，否则 `cloudflare:workers` 的 `env` 上没有类型。
- schema 变更走 `db:generate` 写迁移、`db:migrate` 应用；迁移文件在 `drizzle/`，已应用的记录在 `drizzle.__drizzle_migrations`。
- **没有 `db:push`，也不要加回来**：push 直接 diff 库并应用，不写下任何记录，于是同一处改动之后仍会被 `generate` 写进迁移，`migrate` 再去建一个已经存在的对象就会失败。两者是二选一，不是"快的那条"和"稳的那条"。（顺带解决了 push 不 diff `check()` 表达式那个坑——改约束条件时它会安静地报告无变更。）
- 线上迁移同样从本地跑，把 `DATABASE_URL` 指向生产库即可。Worker 里没有文件系统去读那些 `.sql`，`migrate()` 在运行时跑不了。
- `src/routeTree.gen.ts` 和 `src/paraglide/` 是 vite 插件的生成产物，不要手改（路由树也可 `pnpm generate-routes`）。
- 环境变量分两处，**`.env.local` 只管本地**：`drizzle.config.ts` 读 `DATABASE_URL`（只供 `db:generate` / `db:migrate` / `db:studio`），dev server 把其余键注入 `env`（`BETTER_AUTH_URL/SECRET`、`GOOGLE_CLIENT_ID/SECRET`、`VITE_GOOGLE_CLIENT_ID`、`ANTHROPIC_API_KEY`、`R2_ACCOUNT_ID/ACCESS_KEY_ID/SECRET_ACCESS_KEY/BUCKET`）。**应用运行时的数据库连接不走 `DATABASE_URL`**：本地走 `wrangler.jsonc` 里 hyperdrive 的 `localConnectionString`（必须与 `DATABASE_URL` 同库，否则迁移建表的库和应用连的库是两个地方——现在画布快照也落库，这条比以前更要命），线上走真实 Hyperdrive。`wrangler deploy` **不会**上传 `.env.local`——线上同名变量必须经 `wrangler secret put` 或 dashboard 配置，部署前还要把 hyperdrive 的占位 id 换成真实值。`R2_BUCKET` 必须与 `MEDIA` 绑定实际指向的桶一致（本地 `producer-media-dev`，线上 `producer-media`），否则预签名 PUT 和 binding 读会打到两个桶：上传成功、画布 404。

## 架构要点

### Worker 入口不是 Start 的默认入口

`src/server.ts` 是 wrangler 的 `main`，做三件事：导出 `CanvasRoom` DO 类（不导出等于绑定指向空）；先用 `routePartykitRequest` 拦下 `/parties/canvas-room/:projectId` 的 WebSocket 升级（Start 没有 WebSocket 通道，落进去会变成 HTML）；其余请求交给 `handler.fetch(request)`。`scheduled` handler 跑资产清扫。

### 租户与鉴权

- better-auth + organization 插件。组织有三种 `type`：`private`（个人工作区）、`team`、`enterprise`，`ownerId` 记归属。**每人恰好一个 private，team/enterprise 不限个数**——这条规则由部分唯一索引 `organization_private_owner_idx`（`ownerId` where `type='private'`）兜底，不是靠应用层先查后插（并发登录会同时通过检查）。新用户在 `databaseHooks` 里自动获得 private 组织；新会话若无 `activeOrganizationId` 兜底到它。
- **`ownerId` 不是成员关系**：所有鉴权都查 `member` 表，从不看这一列。它只说这个组织归谁，所以外键是 `restrict` 而非 `cascade`——删一个还拥有组织的用户必须是显式动作，不能顺手把整个团队的项目和资产带走。
- `organization.seat` 是**已付费的席位上限，不是当前人数**：它是输入（将来由订阅写入），**绝不从 `member` 反推**——真实人数永远现查 `member`，把上限改成派生值就等于每次有人进出都覆盖掉人家买的额度。新建组织的默认额度见 `DEFAULT_SEATS`（private 恒为 1，是规则而非起步值），`seat >= 1` 由 CHECK 约束兜底。目前**没有任何代码路径修改这一列**，扩容要等计费接入。
- 上限在 `beforeAddMember` / `beforeAcceptInvitation` 两处强制，**有两个已知缺口**：SSO 的组织 provisioning 和 SCIM 加成员都直接 `adapter.create` 写 member，不经过任何 `organizationHooks`（整个 sso 包里没有这个词），能把组织顶过额度；检查本身也不是原子的（member 行由 better-auth 在钩子返回后才插），并发接受邀请可能各自看到最后一个空位。两者都只影响强制，不影响真相——人数任何时候都能从 `member` 数出来跟计费对账。
- **组织的 `ownerId` 绝不接受客户端传值**（`additionalFields` 里 `input: false`，字段被剔出请求体的 zod schema）；`type` 允许客户端请求但只放行 team/enterprise，最终值由 `beforeCreateOrganization` 落定。
- better-auth 的 `additionalFields` 是**写入的前提而非装饰**：adapter 按声明过的字段逐个搬运数据，没声明的列会被静默丢弃（不是报错）。给 organization 加列必须同步加声明，否则 NOT NULL 列会以"插入时缺值"的形式炸在数据库层。
- **租户范围永远取自会话的 `activeOrganizationId`，绝不接受客户端传来的 organizationId。**
- 两个访问闸门都在服务端，且都重新 join `member` 表校验成员关系（不信任会话快照里的成员身份）：`src/server/canvas-access.ts` 的 `getProjectAccess`、`src/server/asset-access.ts` 的 `requireAssetAccess`。它们接受 `Headers` 而非 Request——WebSocket 升级、DO alarm、server function 手里各自只有 headers。
- **`createServerFn` 是裸 HTTP 端点，`_auth` 路由守卫管不到它**，每个 handler 必须自己解析会话。
- 库表 id 一律小写 uuidv7；所有接客户端 id 的入口共用 `src/lib/ids.ts` 的 `canonicalId`，查库前就拒掉非小写/非 uuid 的 id（DO 房间名按字节区分大小写，大写 URL 会分叉出第二个画布，且各入口对同一条 URL 必须给同一个答案）。画布节点 id 是例外：`crypto.randomUUID()`（v4），只作 Yjs key，不进库表也不进房间名。

### 画布协同（`src/lib/canvas/*`、`src/server/canvas-room.ts`、`use-canvas-collab.ts`）

- 每个项目一个 `CanvasRoom` Durable Object，房间名 = projectId，`static options = { hibernate: true }`。
- **文档存在 Postgres 的 `canvas_snapshot`**：一行一个项目，整份 Yjs update 一个 `bytea`（`onSave` 全量重写，重编码顺带 GC 掉所有删除，所以大小只跟当前节点数有关；实测 50 节点约 25KB、300 节点约 148KB）。不分块——1MB 分块是为了绕 DO SQLite 的 2MB 单值上限，`bytea` 没这个悬崖，于是保存是一条 upsert。行随 `project` cascade 删除。
- **不做成一行一节点**：从关系行重建 Y.Doc 会丢掉全部删除墓碑，一个还连着的客户端手里若有已删节点，重连就把它推回来复活。要可查询的布局就加一列派生的 `jsonb` 投影，别动权威副本。
- **DO 自己的 SQLite 只剩写缓冲**（`snapshot_buffer`，仍分块）：y-partyserver 对失败的 `onSave` 只有一句 `console.error`，没有重试、没有 dirty 标记，所以 PG 写不进去时先落本地、退避 alarm 重推、成功即清空。稳态下这张表是空的，备份和迁移面对的只有 PG 一处。
- **`onLoad` 读 PG 失败必须抛**，让房间起不来：空文档启动会让下一次保存把整张画布覆盖成空。只有 PG 明确答"没有这一行"才允许空启动。本地有缓冲时直接用缓冲——它按定义比 PG 新，且不需要数据库就能把房间拉起来。
- DO 只有一个 alarm，重验和重推共用：各自把到期时间写在 storage 里，谁到期跑谁，跑完按两者较早的重新 `setAlarm`。写快照撞上外键（`23503`）意味着项目已被删，这是唯一不重试而是直接放弃的失败。
- 文档是三个顶层 Y.Map：`nodes`（几何）、`nodeData`（节点 data）、`edges`。**几何与 data 必须分开**：Y.Map 同 key 并发写是整条记录 LWW，拖拽流若与"生成完成"补丁共用一条记录会把结果冲掉。`selected/dragging/measured/resizing` 永不入档。
- DO 的 alarm 每 5 分钟用连接上保存的 cookie 重放访问校验，撤权即断连；查库失败先 fail-open（一次抖动不踢全房间），连续 3 轮失败转 fail-closed 断连（计数存 DO storage，休眠不清零）。
- `use-canvas-collab.ts` 是唯一写入口：本地变更同时写 React state 和 Y.Map（`localOrigin` 用来区分本地/远端事务），手势写入走 60ms trailing 节流、手势结束必写；光标走 awareness；20s 心跳（y-partyserver 关掉了协议自带的续期）。生成超时看门狗要两个条件同时满足才判死：节点自己的 `requestedAt` 超龄，**且**超龄之后还被本机 sweep 盯满一个超时周期（按 tick 计数，只在超龄时累加；挂起/失联的间隙会清空计时——所以判死落在最后一次心跳后约两个超时周期，时钟快或标签挂起都杀不掉活的）；上传与生成都每 60s 续 `requestedAt`。不依赖 awareness（DO 休眠唤醒后 awareness 是空表）。
- `createCanvasSession` 必须显式传 `protocol`：provider 默认按主机名猜协议，`app.localhost` 之类会被猜成 wss。

### 画布交互（`components/block/studio/*`、`routes/_auth/studio/$projectId/index.tsx`）

协同之外的另一半：谁决定坐标，以及哪些画布状态**故意**不进共享文档。

- **画布没有栅格**，背景点只是纹理（`DOT_SPACING`），节点停在被拖到的任意坐标。正因为没有量化，吸附才有意义——在格点画布上节点永远不会"差几个像素没对齐"，参考线只会在你已经到位之后才出现。
- `use-snap-guides.ts` 是 React Flow 与文档之间**唯一**修正坐标的一层：每个 change 仍恰好流向 `apply` 一次，只是在足够近时被拉过去并画一条线。阈值以 flow 单位计（放大不该让吸附变容易）；先问对齐（`alignmentFor`）、再问等距（`spacingFor`），后者只认领前者没占走的轴。`apply` 由调用方给（现在是 `collab.applyNodesChange`），吸附层不关心写去哪。
- **新节点落点由 `canvas-placement.ts` 定**：`freePosition` 的候选取自真实邻居的边（共边、共中线、隔一个 gutter 并排），不是格点；锚点自身也在候选里，所以视野中央本来就空就地不动，不为了对齐而搬家。**没有"一键整理"**：全局重排会把别人正在看的地方从他们眼前搬走，落点与吸附已经让每个节点在放下的那一刻就是对齐的。
- **视口刻意不入共享文档**：它是唯一应该因人而异的画布状态，落 localStorage（`producer:canvas:<projectId>:viewport`），mount 后再恢复而不是走 `defaultViewport`——SSR 那侧没有 storage 可读。
- **空格键是"移动模式"**（`useKeyPress("Space")`），平移与节点拖拽都等它，误拖推不动别人的排版。按下时要对聚焦在 button/a 上的空格 `preventDefault`（capture 阶段自己挂监听，`useKeyPress` 对 BUTTON/A 特意跳过 preventDefault 且没有开关）：否则"点完工具栏按钮 → 按住空格拖节点 → 松手"会把那次点击再触发一遍。**不能改用 `blur()` 摘焦点**——浏览器是在 keydown *派发之后*才把按钮标记 `:active`，比任何 handler/effect 都晚，摘了焦点等于把 `:active` 留在一个收不到 keyup 的元素上，`active:blur-[1.5px]` 于是永久糊着，只有在它上面重新按一次鼠标才复位。
- 节点靠三个 context 拿它不该写进文档的东西：`DragModeContext`（按键级状态，写进每个节点的 data 等于一次按键重写整张图）、`NodeActionsContext`（`canRetry`/`retry` 描述的是**这个 tab 的能力**，不是结果的属性）、`RetryContext`（同一个 retry，已绑定到当前节点，省得深处的失败提示还要接 id 和 data）。

### 资产层（`asset` 表 + R2）

核心不变量：**行先于字节，墓碑先于删字节**。所以桶里永远不会有数据库不认识的对象，代价是需要 `src/server/asset-sweep.ts` 的 cron 清扫（24h 宽限期后回收 tombstoned / 长期 pending / failed 三类行）。

- 上传三步：`POST /api/assets`（校验 mime 与大小 → 插 pending 行 → 返回预签名 PUT URL）→ 浏览器直传 R2（字节不经过 Worker）→ `POST /api/assets/:id/complete`（`head()` 实测大小与 ETag，翻 ready）。预签名同时签死 Content-Type 与 Content-Length（`aws4fetch` 需要 `allHeaders: true`，否则只签 host）。
- 生成两步（`src/lib/generate-asset.ts`）：`startGeneration` 只建行并返回 assetId，客户端先把 id 绑到画布节点；`runGeneration` 先抢跑认领（`updated_at = created_at` 才认领得到——insert 时两列同值，输家在写字节前就出局），再跑 provider 并把字节 bind 回行（`where status='pending' and deleted_at is null`；bind miss 只剩一种含义：行已被删）。模型 provider 的接缝在 `src/server/generation/provider.ts`，目前只有 `sampleProvider` 桩。
- **失败重试分三层，各管各的**（`src/lib/retry.ts` 是共用的退避工具）：① 服务端 `putGeneratedBytes` 对 R2 写退避重试——provider 已经交出字节，为一次网络抖动丢掉整次生成是管线里最亏的一笔；但**只有 ArrayBuffer 能重放**，定长流已被失败的那次尝试消费光，而为了买一次重试把无上限的视频整个物化进 isolate 内存不值得，所以定长流只试一次。② 客户端上传对 PUT 退避重试（同 URL 同 key 同字节，天然幂等；预签名 URL 5 分钟寿命远长于重试窗口，中途不用重签），创建与 `complete` 只对网络错误和 5xx 重试——4xx 是业务拒绝（409 = 行已不在等上传），重试不会改变答案。③ 失败节点上的手动重试。
- **`runGeneration` 不可重跑**：认领靠 `updated_at = created_at`，第一次调用就把它消费掉了，且没有任何回到"未认领"的路径是别的客户端伪造不了的。所以重试走 `retryGeneration`——服务端从失败行复制 prompt/model/kind/params 与 `asset_reference` 建**新行新 key**，旧行墓碑化。参数必须从行里取而不是从节点：`resolution`/`duration`/引用列表从来没进过画布文档，客户端只能靠猜。
- 上传的手动重试只能由**还握着 `File` 的那个 tab** 提供（`useUploads` 的 sources map），刷新即失效。所以 `canRetry` 是 `NodeActionsContext` 上的一个函数而不是节点数据的一个字段——它描述的是这个 tab 的能力，不是结果的属性，写进 Yjs 文档就成了向所有人承诺只有自己能兑现的事。
- **取字节分两条路，按消费者分，不要合并**：浏览器走 `/api/assets/:id/content`（同源、稳定、每次重新鉴权）；**非登录**的模型 provider 走 R2 预签名 URL（`src/server/asset-url.ts` 的 `assetDownloadUrl`，10 分钟）。合并成一条都会赔：全用签名 URL 则 URL 每次续期都变、浏览器缓存全废且撤权在 TTL 内无效；全用 cookie 路由则 provider 根本取不到。
- 画布节点**只存 `assetId`**，URL 由 `assetContentUrl(assetId)` 纯函数派生（`src/lib/asset-links.ts`），不查询、不续期、不入档。
- **URL 稳定带来一个坑**：`assetId` 在生成*开始*时就写进节点，而字节要到 ready 才有，中间请求会 404 并把媒体元素**永久**标记为 broken（URL 不再变化，没有第二次加载）。`assetSrc` 因此以 `status === "ready"` 为闸门。
- 预签名 URL 里钉死了 `response-content-type` 与 `response-content-disposition`（值取自 `servableMime`），所以白名单裁决在 R2 侧照旧生效；改查询参数会被 R2 403（已实测）。
- **每个资产都有 `title`**：上传取原始文件名（去扩展名），AI 生成由 Claude 总结提示词（`src/server/generation/title.ts`）——这一步必须用模型，把"生成一张在草地上奔跑的小狗的照片"变成"奔跑的小狗"没有机械算法，而图像/视频/音频 API 只回字节和 `Content-Type`，从不回文件名。命名与生成**并行**跑（provider 才是慢的那半），失败只返回 null 不拖垮生成，`assetTitle` 有完整回退链。**没配 `ANTHROPIC_API_KEY` 时直接跳过、不发请求**——否则 SDK 会开一个注定失败的连接，错误从 `fetch` 深处异步抛出，绕过 catch 并在 dev server 上弹错误覆盖层。
- 字节 URL 末段带**文件名和扩展名**（`/content/奔跑的小狗.jpg`，路由 `content.$filename.ts`），扩展名由 `mime_type` 反推而非沿用上传时的后缀。这一段服务端**从不读取**：资产 id 才是标识，`Content-Disposition` 由行构造，所以手改 URL 里的名字只改变链接长相。裸 `/content` 是下载路径走的那条（文件名由 `Content-Disposition` 给，URL 里再放一个只会跟它打架）。
- 下载走 `/api/assets/:id/content?download=1`，同源，`Content-Disposition: attachment` 由服务端给出文件名——不要 fetch 字节再造 blob（桶没有给本站放行 GET 的 CORS）。
- `/api/assets/:id/content` 这条路由的保证：同源带 cookie、每次请求重新鉴权、比对行上记录的 ETag（预签名 URL 在完成后仍有效，ETag 变了就当不存在）、mime 只按白名单内联，Range 与条件请求手工归一化（workerd 的 `object.range` 在整读时也非空，206 必须以 `request.headers.has("range")` 为准）。
- `src/lib/asset-constraints.ts` 的 `ALLOWED_MIME` / `MAX_BYTES` 两端共用：客户端那次只是提前失败的礼貌，服务端必须再查一次。SVG 故意不在图片白名单里（内联服务会变成存储型 XSS）。

### 数据访问

`getDB()`（`src/db/index.ts`）按 Request 用 WeakMap 缓存连接池，走 Hyperdrive 连接串、`maxUses: 1`。schema 在 `src/db/schema.ts`，id 默认值是 Postgres 的 `uuidv7()`；需要在插入前知道 id（object key 里嵌了 id）时先 `select uuidv7()` 取一个。

- **每个 `createServerFn` handler 的形状是固定的**，`src/lib/projects.ts` 是范本：从 `getRequest().headers` 解析会话 → 取 `activeOrganizationId` → 重新 join `member` 校验成员 → `where` 里同时带资源 id 与 organizationId。最后这条是安全属性不是写法偏好——别的租户的 project id 匹配不到行，于是"无权"和"不存在"在响应里长得一模一样。读路径把这种情况答成 `null` / 空列表，写路径抛 `NOT_FOUND`：对"重命名一个你无权重命名的项目"没有合理的空答案。
- 写路径的 id 一律经 `canonicalId` 校验；**`fetchProject` 故意只声明 `z.string()`**：id 直接来自 URL，拼错要和"没有这个项目"走同一条路而不是弹错误屏。形状检查仍在 handler 内做——大写 id 必须在这里也答"没有"，否则 studio 外壳能加载，而画布 socket、生成、上传三处闸门对同一条 URL 全答 401。
- 查询键两套命名空间：`["organizations", orgId, "projects", …]`（`src/lib/projects.ts`）与 `["projects", projectId, "assets"]`（`projectAssetsScope`）。**`organizationId` 只进键、绝不上行**——服务端自己决定读什么，键只决定记住什么，它在这里唯一的作用是拦住"切组织或换账号后把上一个租户的缓存画出来"。项目相关的写统一 invalidate `["organizations"]` 前缀。
- **新增查询必须显式给 `staleTime`**（现存的都是 30s）：query client 建时没有任何默认值，`staleTime: 0` 会让 SSR 脱水的条目一挂载就过期、`useSuspenseQuery` 立刻重取一趟（每次加载多一次会话解析）；更糟的是它出错会抛——一次后台重取抖动就能把已经渲染好的页面换成错误屏。
- **`.cta.json` 脚手架留下的依赖有一批没用上**：`@modelcontextprotocol/sdk`、`@tanstack/react-db`、`@tanstack/query-db-collection`、`@tanstack/store` / `@tanstack/react-store`、`@tanstack/react-hotkeys` 在 `src/` 里零引用。别因为它们在 `package.json` 里就推断本仓库的方案：服务端状态一律 React Query + `createServerFn`，画布状态在 Yjs，其余是 `useState` 与 context。

### 前端约定

- 路径别名 `#/*` 与 `@/*` 都指向 `src/`，代码里统一用 `#/`。
- 路由在 `src/routes/`：`_auth` 做会话守卫并把 session 放进 route context；`_auth/studio/$projectId/route.tsx` 这层负责 loader 与文档标题，子路由从 query 缓存读。API 路由用 `createFileRoute(...).server.handlers`。
- `components/ui/` 是 Base UI + `tailwind-variants` 的薄封装（暗色主题，样式挂 `data-*` 而非伪类）；`components/block/` 是业务块，画布相关全在 `components/block/studio/`。
- 第三方 CSS 用 `@import ... layer(base)` 引入（React Flow、video.js 的样式表无 layer，否则会盖过 utility）。**组件里不要再 import 一次**：`generation-node.tsx` 只动态 `import("video.js")` 取播放器，样式表由 `styles.css` 一处引入——第二次无 layer 的 import 会盖掉那里的 `.canvas-video` 覆写，安静地把原皮肤装回来。
- `/menu-preview` 是 `components/ui/menu` 的沙盒页，不在 `_auth` 下，也不是产品里的页面——改菜单组件时拿它对照，别当成有人在用的路由去维护。
- AI 输入框是 **tiptap 编辑器**，不是 textarea（`ai-composer.tsx` + `use-asset-mentions.ts` + `asset-mention.tsx`）。理由是 `@` 提及必须是**原子节点**：在 textarea 里它只能是一串代表 id 的字符，任何一次退格或粘贴都会让标签和真正要发送的 id 悄悄对不上。`renderText` 决定它在 `getText()` 里长什么样（`@标签`，`@` 只在这里保留——它标出哪些词指向附件），提交时的 id 则从 doc 里遍历节点取。编辑器只创建一次，变动的东西（资产列表、模型能力、Enter 的行为）一律经 ref 读取。
- 提及在编辑器里是**纯文本加一个颜色**，没有色块、圆角、图标，视觉上也不显示 `@`。这不只是审美：给它做成 chip 会让 inline-flex 的基线取自图标而非文字，整块比同行文字高出一截——纯 inline 文本没有这个问题。项目主体是灰阶（`#000`/`#fff` + neutral + 危险红），蓝色专门留给"这里正在发生交互"——吸附参考线、trim 手柄、焦点环一律 `blue-500`，所以提及这支更浅的 `#8ab4f8` 是正文里唯一带色相的东西。
- `@` 候选**只列画布上的文件**（`attachableAssets`），不是项目里的全部资产：删掉节点后资产行还在，列全量会冒出画布上根本不存在的东西，同一文件被两个节点用还会重复。再按 `modelAccepts(model)` 过滤——给 TTS 模型附图片没有意义。
- 文案走 Paraglide：`messages/*.json` → 生成 `src/paraglide/`，策略 `["url", "baseLocale"]`。

## 本地开发的已知坑

- 双人协同测试：第二个账号开 `http://app.localhost:3000`（独立 cookie jar，已加进 `auth.ts` 的 `trustedOrigins`）。localhost 的 cookie 不分端口，同端口换账号会串。
- `r2_buckets` 的 `"remote": true` 是刻意的：预签名直传总是打真实 R2，本地模拟绑定会读到另一个桶。本地绑到 `producer-media-dev`。
- R2 桶 CORS 按 origin（含端口）放行，目前只配了 3000 端口的两个源；用别的端口起 dev server 上传会被 CORS 拒。
- 用 curl 打 `/api/auth/*` 必须带 `Origin`，否则一律 `MISSING_OR_NULL_ORIGIN`；且值要匹配 `BETTER_AUTH_URL`（`http://localhost:3000`）而非实际监听端口——3000 被占时 dev server 会换端口，请求打新端口、Origin 仍写 3000 才通得过。另外 `accept-invitation` 要求 `email_verified`，脚本里造的测试账号得先把这列置 true。

## 代码风格

- 注释写"为什么"，不写"是什么"。现有代码里大量块注释记录权衡与失败模式，改动时保持这个密度，推翻某个决定时同步更新对应注释。
- `oxfmt` 负责格式化（无尾逗号、import 排序、tailwind class 排序），`oxlint` 只开 correctness 类。
- 提交信息用中文 Conventional Commits，例如 `feat(studio): 画布接入多人协同`。
