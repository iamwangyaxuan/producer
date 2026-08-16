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
- 环境变量分两处，**`.env.local` 只管本地**：`drizzle.config.ts` 读 `DATABASE_URL`（只供 `db:generate` / `db:migrate` / `db:studio`），dev server 把其余键注入 `env`（`BETTER_AUTH_URL/SECRET`、`GOOGLE_CLIENT_ID/SECRET`、`VITE_GOOGLE_CLIENT_ID`、`AI_GATEWAY_API_KEY`、`R2_ACCOUNT_ID/ACCESS_KEY_ID/SECRET_ACCESS_KEY/BUCKET`、`STRIPE_SECRET_KEY/WEBHOOK_SECRET`）。**应用运行时的数据库连接不走 `DATABASE_URL`**：本地走 `wrangler.jsonc` 里 hyperdrive 的 `localConnectionString`（必须与 `DATABASE_URL` 同库，否则迁移建表的库和应用连的库是两个地方——现在画布快照也落库，这条比以前更要命），线上走真实 Hyperdrive。`wrangler deploy` **不会**上传 `.env.local`——线上同名变量必须经 `wrangler secret put` 或 dashboard 配置，部署前还要把 hyperdrive 的占位 id 换成真实值。`R2_BUCKET` 必须与 `MEDIA` 绑定实际指向的桶一致（本地 `producer-media-dev`，线上 `producer-media`），否则预签名 PUT 和 binding 读会打到两个桶：上传成功、画布 404。

## 架构要点

### Worker 入口不是 Start 的默认入口

`src/server.ts` 是 wrangler 的 `main`，做三件事：导出 `CanvasRoom` DO 类（不导出等于绑定指向空）；先用 `routePartykitRequest` 拦下 `/parties/canvas-room/:projectId` 的 WebSocket 升级（Start 没有 WebSocket 通道，落进去会变成 HTML）；其余请求交给 `handler.fetch(request)`。`scheduled` handler 跑资产清扫。

### 租户与鉴权

- better-auth + organization 插件。组织有三种 `type`：`private`（个人工作区）、`team`、`enterprise`，`ownerId` 记归属。**每人恰好一个 private，team/enterprise 不限个数**——这条规则由部分唯一索引 `organization_private_owner_idx`（`ownerId` where `type='private'`）兜底，不是靠应用层先查后插（并发登录会同时通过检查）。新用户在 `databaseHooks` 里自动获得 private 组织；新会话若无 `activeOrganizationId` 兜底到它。
- **`ownerId` 不是成员关系**：所有鉴权都查 `member` 表，从不看这一列。它只说这个组织归谁，所以外键是 `restrict` 而非 `cascade`——删一个还拥有组织的用户必须是显式动作，不能顺手把整个团队的项目和资产带走。
- `organization.seat` 是**已付费的席位上限，不是当前人数**：它是输入，由订阅写入（`applyPurchasedOrganization` 从 `subscription.seats` 抄过来），**绝不从 `member` 反推**——真实人数永远现查 `member`，把上限改成派生值就等于每次有人进出都覆盖掉人家买的额度。`DEFAULT_SEATS` 现在只兜底没走购买的组织：private（恒为 1，是规则而非起步值）和 better-auth 自带 `/organization/create` 建出来的。`seat >= 1` 由 CHECK 约束兜底。
- 上限在 `beforeAddMember` / `beforeAcceptInvitation` 两处强制，**有两个已知缺口**：SSO 的组织 provisioning 和 SCIM 加成员都直接 `adapter.create` 写 member，不经过任何 `organizationHooks`（整个 sso 包里没有这个词），能把组织顶过额度；检查本身也不是原子的（member 行由 better-auth 在钩子返回后才插），并发接受邀请可能各自看到最后一个空位。两者都只影响强制，不影响真相——人数任何时候都能从 `member` 数出来跟计费对账。
- **better-auth 自带的 `/organization/create` 端点没被摘掉**，直接调它仍能建出一个 `DEFAULT_SEATS` 的组织、不经过结账。产品里没有入口指向它（创建组织走购买，见下面的计费一节），留着是因为 SSO/SCIM provisioning 和将来的管理用途要用；`beforeCreateOrganization` 的存在就是保证这条路建出来的行仍然合法。
- **组织的 `ownerId` 绝不接受客户端传值**（`additionalFields` 里 `input: false`，字段被剔出请求体的 zod schema）；`type` 允许客户端请求但只放行 team/enterprise，最终值由 `beforeCreateOrganization` 落定。
- better-auth 的 `additionalFields` 是**写入的前提而非装饰**：adapter 按声明过的字段逐个搬运数据，没声明的列会被静默丢弃（不是报错）。给 organization 加列必须同步加声明，否则 NOT NULL 列会以"插入时缺值"的形式炸在数据库层。
- **租户范围永远取自会话的 `activeOrganizationId`，绝不接受客户端传来的 organizationId。**
- 两个访问闸门都在服务端，且都重新 join `member` 表校验成员关系（不信任会话快照里的成员身份）：`src/server/canvas-access.ts` 的 `getProjectAccess`、`src/server/asset-access.ts` 的 `requireAssetAccess`。它们接受 `Headers` 而非 Request——WebSocket 升级、DO alarm、server function 手里各自只有 headers。
- **`createServerFn` 是裸 HTTP 端点，`_auth` 路由守卫管不到它**，每个 handler 必须自己解析会话。
- 库表 id 一律小写 uuidv7；所有接客户端 id 的入口共用 `src/lib/ids.ts` 的 `canonicalId`，查库前就拒掉非小写/非 uuid 的 id（DO 房间名按字节区分大小写，大写 URL 会分叉出第二个画布，且各入口对同一条 URL 必须给同一个答案）。画布节点 id 是例外：`crypto.randomUUID()`（v4），只作 Yjs key，不进库表也不进房间名。

### 计费与买组织（`src/lib/plans.ts`、`src/lib/billing.ts`、`src/server/billing/*`）

- **组织是买出来的，不是建出来的**：产品里创建 team/enterprise 的唯一入口是"选套餐 + 定座位数 → 结账 → 付款成功后组织才落库"。所以先有订阅、后有组织，这个顺序决定了下面几乎所有设计。
- **`organization_draft` 是为了让结账能指着一个还不存在的组织**。它的 `id` 由 `newRowId()` 预先铸出，既是 `subscription.referenceId`，也是组织将来的 `organization.id`——**同一个值，不是事后改指向**，所以订阅从第一次调用起就指着最终那个租户。它同时是这次结账的授权凭据：`authorizeReference` 对已存在的组织查 `member`（owner/admin），对还不存在的查这张表（本人 + 仍 `pending`）。
- `subscription.referenceId` **故意不是外键**：写它的时候组织行还不存在，加约束就等于拒绝掉发起购买的那次插入。
- **`customerType` 用默认的 `user`，`stripe.organization.enabled` 关着**。那个开关会把 Stripe customer 挂到组织上，而组织在结账时还不存在；付款人是人，这也确实是事实。买的是什么由 `referenceId` 说。顺带避开了它的 `syncSeatsAfterMemberChange`——那个 hook 会把 seats 同步成当前成员数，跟"seat 是买来的上限"直接冲突（我们不设 `seatPriceId`，所以即便开了它也会提前 return，但不要去踩）。
- **Stripe 是真的，账号是假的**（`fake-stripe.ts`）：插件、SDK、`subscription` 表、`authClient.subscription.*` 全是生产代码，只有最底下那层 HTTP 被 `Stripe.createFetchHttpClient(fakeStripeFetch)` 换掉，由本地一张 `stripe_mock_object` 表冒充 api.stripe.com。**接缝是传输层而不是 SDK**——照插件"我们以为它读什么"去捏一个假 client，它多读一个字段就穿帮；按 wire 形状答，SDK 能解析的插件就都拿得到。设了 `STRIPE_SECRET_KEY` 就整体切到真账号（判据只有"这个变量有没有值"，**不看 `sk_test_` 前缀**：test mode 也是真账号）。
- **付款那一下是靠签名 webhook 闭环的**（`webhook.ts`）：模拟结账页调 `deliverStripeEvent`，自己按 Stripe 的算法 HMAC 签名，再把事件交给 `auth.handler`——不是 `fetch` 自己的 URL（省掉回环解析、subrequest 配额，也保证投递和等待在同一个 isolate）。签名是真验的，`constructEventAsync` 会拒掉签错的。所以 `onCheckoutSessionCompleted → onSubscriptionComplete → applyPurchasedOrganization` 这条链是按真实路径跑到的。
- **不能相信 webhook 的返回码**：插件把 `onSubscriptionComplete` 包在 try/catch 里，只 log 不上抛，200 照返。所以 `payCheckoutOrder` 在投递完之后**自己回读组织行**，读不到就如实告诉用户"钱付了但组织没建出来，可以重试"。真 Stripe 下同样成立（投递是异步的），这个校验两边都需要。
- `applyPurchasedOrganization` 必须幂等（Stripe 会重投）：组织已存在就只把 seat 同步过去，不存在就在一个事务里写组织 + owner 的 member 行 + 把 draft 标 completed，slug 撞了换个后缀重试。
- **结账页的报错是直接显示给人看的**，跟别处 `import.meta.env.DEV` 遮住 message 的做法相反——"钱付了但组织没建出来"是唯一必须让人看见的那句。泄露风险在源头堵：`withCheckoutMessages` 把任何不是 `CheckoutError` 的失败 log 掉换成安全文案，所以到达客户端的每一句都是写给人读的。
- 目录在 `src/lib/plans.ts`（两端共用，跟 `models.ts` 同理）：`plan.name` 同时是 Stripe 的 plan 名和它创建出来的 `organization.type`。里面的 `priceId` 是**可读的占位串**而不是长得像真 id 的假 id——换真账号时要改的就是这两行。
- 代价：`stripe` SDK 让 Worker 打包后 gzip 多了约 590KB（现在总计约 2.2MB，免费版上限 3MB）。

### 用量计费与组织钱包（`src/lib/money.ts`、`pricing.ts`、`credits.ts`、`src/server/billing/*`、`src/server/generation/metering.ts`）

买组织卖的是席位，这一层卖的是**每一次模型调用**。两者共用一个 Stripe client、一个 webhook 端点和一种货币，此外没有关系。

- **钱包挂在组织上**：项目、画布、资产全是组织范围的，那么生成它们的账单也该落在同一个租户，而不是落在恰好按了按钮的那个人身上。每个人都有一个 private 组织，所以单人用户的"给自己充值"仍然只是一个钱包的事。
- **但付款人始终是人**：Stripe 的 customer 是 `user.stripeCustomerId`（`customerType: "user"`），卡是某个人的。所以 `credit_topup` 同时记两列——`organizationId` 是被充值的，`userId` 是被扣款的。账本和计量表也各记一个 `userId`，那是**归属而非授权**：能花谁的钱只由 `organizationId` 决定。
- **两种权限，沿用既有那条线**：**花钱**是任何成员的事（走画布，`getProjectAccess` 已经验过成员身份；只有 owner 能生成的团队不叫团队）；**充值和看流水**是 owner/admin 的事，跟席位订阅同一套 `BILLING_ROLES`，同一条道理——成员用已经买好的，不改买什么。流水本身也是一份名册，它说得出谁花了多少。余额则对所有成员可见，因为那是每一次"余额不足"背后的那个数。这道闸在 `lib/credits.ts` 的 `requireBillingAccess` 里，**不是只藏了 UI**：几个 server fn 都是裸 HTTP 端点。
- **组织范围永远取自会话的 `activeOrganizationId` 并重查 `member`**，跟别处一样；组织 id 只进查询键（`["credits", orgId, …]`），拦住切组织后画出上一个租户的余额。
- **一切金额是整数微美元（1e-6 USD）**，见 `money.ts`。不用美分：一次语音调用就是零点几美分，美分做单位会把每一次都四舍五入成 0 或 1 分。不用 `numeric`：钱包安全的前提是 `balance = balance - x` 在**一条语句里**精确完成，小数类型会诱使某处 `parseFloat`。只有贴着 Stripe 的那一列（`credit_topup.chargeAmount`）用**美分**，换算只发生在那一个边界上，且 `microToCents` 向上取整——把该收的钱换成要收的钱，往下取整等于每笔带零头的订单白送一分。
- **用美元还有一个结构性好处**：AI Gateway 就是按美元计费的，所以 `usage_event` 里"卖了多少"和"成本多少"是同一货币的两列，毛利是一次减法，不需要这个应用去发明并维护一个汇率。
- **价格写在模型条目上**（`models.ts` 的 `price`），跟 `gateway` 挨着，理由一模一样：「这个模型存在／能跑／值多少钱」是同一件事的三个方面，价格表另立一张就是第四张要对账的表，而它对不上的后果是账单。两者必须成对出现，由 `assertPricedGateway` 在 dev 下启动即校验——只有 `gateway` 没 `price` 会真跑且不计费（计量漏了个洞），只有 `price` 没 `gateway` 会报价之后返回替身文件（另一个方向的谎）。它还顺手挡住「music 模型带 gateway id」，因为 `getProvider` 无论如何都不会把 music 路由过去。
- **报价是两端共用的纯函数**（`quoteGeneration`）。服务端多的那个输入只有一个——有没有配 `AI_GATEWAY_API_KEY`——所以它搭钱包查询（`walletQueryOptions`）的顺风车发给浏览器，而不是让客户端猜。**报价永远不上行**：请求体里的价格就是调用方自己定的价格。
- 计价单位一个模态一种：图片按张（**故意不按分辨率档位**——那个档位根本没接到任何 provider，按它收费等于为一个没离开过本应用的参数收费）、视频按秒 × 分辨率倍率（视频的分辨率是真发出去的）、语音按千字符（不足一千按一千，否则单次价格小到四舍五入没了）。倍率表在 `pricing.ts`，是**政策数字**不是测量值；`models.ts` 里的价格同理。
- **命名调用也是一次网关调用**，所以每次可计费生成额外收一笔固定的 `NAMING_FEE`。固定而不是按 token：报价必须在发请求**之前**精确，而没发生的回复数不出 token。落到 `sampleProvider` 的生成不收这笔——那次调用照样花我们的钱，但为一个替身文件收费是更坏的那个错误。
- **扣费在认领之后、第一个字节出去之前**（`runGeneration`）。认领之后，否则两个客户端抢同一行会各扣一次而只出一个文件；provider 之前，否则钱包形同虚设——余额一美元的组织可以同时发五十次生成，每次进来时余额都是正的。
- 扣费本身是**一条带条件的 update**（`where balance >= amount`）加同事务的账本插入，由 Postgres 在它本来就要拿的行锁下决定这笔付不付得起；输的那次拿到零行，而不是一个事后才发现的负数。
- **幂等靠数据库而不是靠记得先查**：`credit_transaction` 上 (`kind`, `referenceId`) 的部分唯一索引，让重投的 webhook、双击的重试、重复的退款各自只落一次。⚠ 判断这个冲突必须**沿着 `cause` 链走**：drizzle 不会原样抛驱动的错，而是包一层 `DrizzleQueryError`，顶层读 `code` 永远是 `undefined`——写错了看起来完全正确，然后把每一次 Stripe 重投变成 500。
- **失败即退款**，金额从那笔扣费行上读回来而不是重新报价：两次之间目录可能已经改过价，退得对不上的退款比不退更糟，它会凭空造出或销毁额度。唯一不退的是「生成成功但节点已被删」——模型跑了、厂商收了钱，退它等于把"生成完立刻删节点"变成免费通道。
- **`usage_event` 和账本是两张表，别合**：一次生成是**一笔**扣费和**两次**网关调用（媒体 + 命名），而落到替身 provider 的生成是一笔零元扣费和零次调用。合成一张要么凭空造出零元的资金流水，要么直接丢掉命名那次。`chargedAmount` 和 `upstreamCost` 并排放着，两列一减就是毛利。
- 网关报的 cost 藏在 `providerMetadata` 里，SDK 只负责原样透传、没有 schema，各模态还不一定都有。`upstreamCost` 因此**可空**：读不到就是 null，不是 0——报表有洞是诚实的，每个洞里塞个零不是。
- **失败路径上那条命名的计量行必须交给 `waitUntil`**（`meterInBackground`）。裸 `void promise` 在 Workers 上不行：isolate 答完就可以不再执行，那行会时有时无，而这是计量最坏的一种行为。不能改成 await——命名自己有 20 秒的耐心，不该拿它拖住一次已经失败的生成。
- **余额不足是提前说的**，跟席位满同一个道理：真正的检查在离按钮很远的地方，"点了没反应"是最差的知情方式。`generate()` 在建节点**之前**问一次，不够就 toast 并**返回 false**——`onSubmit` 返回 false 时 composer 不清空草稿，因为拒绝不该顺手把人刚写的提示词也收走。服务端仍然是权威（缓存会旧，同组织的另一个人会花掉同一笔钱），它拒绝时那一次会在画布上留一个失败节点；但 `useGenerations` 在 `finally` 里 invalidate 了 `["credits"]`，所以下一次按下就会被客户端拦住并给出人话——这条链是自我纠正的。
- **发送按钮旁边常驻价格**，因为钱是按次花的，决定发生在那里。`formatUsd` 因此最多显示四位小数：生成价是模型价加那笔命名费，两位小数会把 $0.091 印成 $0.09 然后扣 $0.091——屏幕上的数和实际扣的数不一样，而这恰恰是唯一不能不一致的那块屏幕。整分的金额不受影响，$100 照样是 $100.00。
- **充值不走 better-auth 的 stripe 插件**：那个插件只卖订阅，建 session 时把 `mode: "subscription"` 写死。充值是一次性付款，用同一个 client 自己建 session，并且结算在 **`payment_intent.succeeded`** 上——这是插件会直接丢给 `onEvent`、不试图解读的那类事件。选它而不是 `checkout.session.completed` 是因为后者的处理函数会对任何非 setup 的完成结账去读 `session.subscription`，一次性付款上那是 null，它自己的 try/catch 能扛住（照返 200），但每笔充值要白搭一次注定 404 的 Stripe 往返和一行 error 日志。
- `onEvent` 抛错会让端点返 **非 200**（跟 `onSubscriptionComplete` 只 log 相反），这对发放额度正是想要的方向：Stripe 会重投，而 `applyPaidTopup` 幂等。
- **入账金额只认 `credit_topup` 那一行**，绝不认事件里的数字：事件说的是收了多少（含手续费），入账的是买了多少。拿付款额去入账等于把手续费当额度还给所有人。
- 手续费 5%，**是「到账额的 5%」而不是「收款额的 5%」**：充 $100 收 $105，$5 占 $105 是 4.76%。`credit_topup.feeRateBps` 在下单时把当时的费率盖章存下，之后改公开费率也改不了旧单。
- 四张表的外键一律 `restrict` 指向 organization，跟 `asset.organizationId` 同一个理由：cascade 会把有人付过钱的余额悄悄烧掉。删一个还有钱的组织必须是先清空钱包的显式动作，在那之前 Postgres 直接拒绝——响亮的失败好过安静的失败。
- **组织可以自带 AI Gateway key**（`server/generation/gateway-key.ts` + `gateway.ts` 的 `resolveGateway`）。这首先是一个**计费**决定而不是技术决定：自带 key 的组织由 Vercel 直接开票，所以这边就**不再从余额扣费**——两边都收就是为一次生成收两遍钱。
- key 因此绑在**组织**上、由 owner/admin 设置，跟钱包同一层。挂在人身上的话，同一个组织里 A 的卡会悄悄替 B 的生成付账，而 A 事后连是哪几次都说不清。
- **优先级写死、没有第二个开关**：`resolveGateway` 先查组织的 key，没有才用 `env.AI_GATEWAY_API_KEY`。"用我的 key"由"存在一把 key"表达，而不是由一个可以跟它对不上的 boolean 表达。
- **一次生成只解析一次**，结果同时喂给媒体调用、命名调用和报价。否则一次生成的两半可能跑在两把不同的 key 上，账也就对不起来了。
- key **加密后入库**（AES-GCM，密钥由 `BETTER_AUTH_SECRET` 经 HKDF 派生，`info` 串区分用途）。这是别人账户的活凭证，一份 dump、一条被记下的查询、一次恢复到不那么小心的地方的备份，都不该足以花掉他们的钱。⚠ **轮换 `BETTER_AUTH_SECRET` 会让已存的 key 全部解不开**：解不开时按"没有 key"处理并 log,组织回落到系统 key 而不是每次生成都失败，设置页仍显示装着一把——那正是提示人重新粘一次的地方。真要避免这条，就给它一个自己的 secret。
- **key 只往一个方向走**：上行一次，永不回传。所有读路径答的是最后四位加一个时间戳（`preview` 列是明文存的，够认出是哪一把、不够用）。没有"显示 key"、没有就地编辑——能被显示的凭证最终会出现在截图、工单或 bug 报告里。
- **存之前先验**（`getCredits()`，最便宜的一个鉴权调用，什么都不生成）。验证失败不写库，组织留在原来那把 key 上；一把没验过的 key 会把整个组织的生成变成原因不在屏幕上的失败。验证的报错也不透传——它来自一个手里攥着凭证的调用栈。
- 校验只查长度不查前缀：`vck_` 是今天的样子，照它写正则会在前缀一变时开始拒绝合法的 key，而 Gateway 自己才是"这把 key 行不行"的权威。
- **`usage_event.keySource` 单独记一列**，不从 `chargedAmount` 反推：0 有两个意思——跑在自己 key 上，和扣了又退了——而用量报表正是有人会去问这个区别的地方。报表按它分组，两种行的"收了多少"混在一起算是个没有指称的数。

- `fake-stripe.ts` 相应长出了三样东西：`price_data` 内联价格（充值金额只为这一单存在，为每个面额建一个 Price 等于把费率表放两处）、`mode: "payment"` 的结算（产出 `payment_intent`，带 `amount_received` 而不只是 `amount`——那才是处理方该读的字段）、以及按 `mode` 分流的假结账页地址。

### 成员与邀请（`src/lib/members.ts`、`src/lib/invitations.ts`）

两个文件是同一批行的两种视角，鉴权模型完全相反，所以没合成一个：`members.ts` 是**拥有者视角**（读成员名单、发邀请、撤邀请、移除人），`invitations.ts` 是**收件人视角**（读一条邀请、接受、拒绝）。

- **读走 `createServerFn`，写走 `authClient`**，这不是风格问题：`inviteMember` 是发邮件的那一步，`removeMember` 会跑 organizationHooks，`acceptInvitation` 会跑 `beforeAcceptInvitation` 里的席位检查——绕过它们直接写 `member`/`invitation` 表，等于把 SSO/SCIM 已有的那个缺口再开一个，而且是从自家 UI 开的。写路径一律不传 `organizationId`，让端点回落到会话的活动组织。
- **`fetchOrganizationMembers` 自己也查 owner**，不只靠侧栏藏链接：server fn 是裸 HTTP 端点，谁登录了都能打，而一个组织的成员名单正是不该因为"知道 URL"就拿到的东西。四种拿不到的情况（没会话／没活动组织／private／不是 owner）**答案完全一样**，都是 `organization: null`。
- **接受邀请要求邮箱已验证**，这条不能关。better-auth 的判据是 `hasBuiltInOpaqueInvitationIdGeneration`——我们设了 `advanced.database.generateId: false`（id 由 Postgres 的 `uuidv7()` 给），于是它认定 id 不是它的不透明 id，默认要求 `emailVerified`。看着像个麻烦，实际是必需的：email/password 注册不校验邮箱所有权，关掉它就等于任何人都能注册 `ceo@target.com` 然后接受发给对方的邀请走进组织。**因此邮箱验证信也一并接上了**（见下一节）。
- **`/accept-invitation/$id` 的每一种拒绝都给出路**，这是 `InvitationView` 做成判别联合而不是"一个可空的 blocker"的原因：登错账号（→ 登出）、邮箱没验证（→ 发验证信，验证完跳回本页）、席位满了（→ 说清邀请还有效）、邀请失效（→ 回项目页）。四种情况的出路各不相同，一句"你不能接受"会把它们全糊掉。
- **席位满是提前说的**，不是提交后才发现：真正的检查在 `beforeAcceptInvitation` 里，离按钮很远，"点了没反应只弹个错"是最差的知情方式。管理页同理，标题旁常驻 `N of M seats used`。
- 邀请链接里**只有 invitation id**，可以随便转发：接受时会重新比对登录者的邮箱和被邀请的邮箱，链接落到别人手里打开的是一个拒绝页。这也是管理页敢提供"复制链接"的原因——邮件没到时的后路。
- 移除按钮不出现在 owner 和自己身上：移除 owner 会让 `organization.ownerId` 指向一个非成员，而"移除自己"是另一件事（better-auth 有 `leave`）。
- 确认框的描述**用一个单独记住的名字**而不是 `removing?.name`：对话框退出动画有 150ms，那期间它还挂着，而成功回调已经把 `removing` 置 null——屏幕上会有 150ms 的 "undefined will lose access"。

### 账号与密码（`routes/login|signup|forgot-password|reset-password|email-verified`）

签出状态的五个页面共用 `components/block/auth-shell.tsx`：它们在 `_auth` 之外，也在应用那套只有暗色的皮肤之外——是陌生人看到的第一屏，所以跟随系统主题，而不是替他决定。样式常量抽出来是因为五个页面本来要各抄一份，那正是某个没人再看第二眼的页面上焦点环变成另一种蓝的方式。

- **三条进门的路，两条自带验证**：密码、邮箱验证码（`emailOTP`）、登录链接（`magicLink`），外加 Google。
- **`requireEmailVerification: true`**：邮箱没验证就不能用**密码**登录。它只管 email/password 那一条路——`requireEmailVerification` 在整个 better-auth 里只被 `sign-in.mjs:312` 读一次，社交登录走 `link-account.mjs`，`emailVerified` 直接抄 provider 的（Google 给 true），**从不经过那道闸**。所以"社交账号免验证"不需要写任何代码，本来就是这样。
- 那道闸堵的是真窟窿：谁都能拿 `ceo@target.com` 注册而不必读得到那个邮箱，而一个未验证账号是可以被塞进一张本该发给地址真主人的组织邀请的——邀请系统正是拿 `emailVerified` 当"这地址真是他的"的证据。
- **OTP 和魔法链接本身就是验证**：收到码/链接再拿回来，证明的和验证信证明的是同一件事——这个人读得到这个邮箱。better-auth 因此在这两条路上直接写 `emailVerified: true`：**全新地址会被就地建号且已验证**（连 `credential` account 都不建，因为从没设过密码），已存在的未验证账号则被就地升级，升级前先 `revokeUnprovenAccountAccess` 掐掉它原有的会话——万一是别人先抢注了这个地址却从没证明过。
- 于是"验证邮箱"从一件差事变成了登录的副作用，也给**被验证要求锁在门外的账号一条自救路**：改用验证码登录一次就解开了，不需要工单。（`databaseHooks` 照常触发，所以这两条路建出来的账号一样会自动获得 private 组织。）
- **`overrideDefaultEmailVerification` 故意不开**：密码注册仍旧走它自己的验证**链接**，OTP 和魔法链接是**多出来的两扇门**而不是替换掉那一扇。
- 验证码信的 subject 里带码（`123456 is your Producer sign-in code`），这不是抄格式：新发送域会进垃圾箱，而垃圾箱列表显示的是 subject——**不打开邮件就能读到的码**能活下来，链接不能。代价是锁屏通知也会显示它，这是登录码普遍接受的取舍，也是它 10 分钟过期、一次性、错三次即作废的原因。
- **没有人会拿到空名字，也没有表单问过名字**：注册页只要邮箱和密码，无密码那两扇门只要一个码或一个链接。`databaseHooks.user.create.before` 用 `nameFromEmail` 把空名字补上——`1234@xxx.com` 的名字就是 `1234`，私有组织就叫 `1234's Organization`。它**只填空的**：Google 和 SSO 给的真名字一律不动。各处显示名字的回退链（`AccountMenu`、`privateOrganizationName`）保留着当第二道防线，因为这个 hook 之前建的老账号仍可能是空的。
- **`nameFromEmail` 会剥掉 plus 标签，但绝不碰点**（`lib/organization.ts`，名字、组织名、slug 三处共用）。`foo+producer@x.com` 的名字是 `foo`：那个标签是收件人给自己留的记号，不比域名更算是他的名字，留着就会变成第一屏上的 `foo+producer's Organization`。**只影响显示**——`user.email` 一个字符都不动，因为那串东西是投递地址，也是邀请比对的依据。点则相反：Gmail 忽略用户名里的点，但只有 Gmail 这样，对多数域名 `zhang.san@` 和 `zhangsan@` 是两个人，"规范化"等于把两个陌生人并成一个。
- 开这个开关顺带把注册也变严了：better-auth 对**已存在的邮箱**改用通用响应（还会照样 hash 一遍密码来抹平耗时差），所以注册表单不再能用来试探谁有账号。注册页那句"检查你的邮箱"对新地址和已占用地址是同一句，这是有意的。
- `requireEmailVerification` 下**注册不会自动登录**（better-auth 自己把 `autoSignIn` 跳过），所以注册页提交后不导航，直接换成"去收信"。
- `sendOnSignUp` 和 `sendOnSignIn` 都开：前者让注册自成闭环，后者是**没收到第一封的人的唯一活路**——否则未验证用户在登录处被拒，却没有任何地方能再要一封。登录页因此把 `EMAIL_NOT_VERIFIED` 当作"已经给你重发了"来说，而不是当错误。
- `autoSignInAfterVerification`：那个链接同时证明了地址是他的、人也在，验证完再要一次密码是多一步却不多一道检查。
- **`/email-verified` 和 `/reset-password` 都必须在 `_auth` 之外**，因为 token 失效时 better-auth 会带 `?error=` 重定向回同一个 URL——放在守卫后面，失败就变成一次静默弹回登录页。两个路径写在 `lib/session.ts` 的常量里：它们是"请求邮件时传的 option"和"几天后在另一台设备上被点开的路由"之间的约定，两头永远见不到面。
- 重置密码 `revokeSessionsOnPasswordReset: true` 并在完成后发一封**没有链接**的通知信。没链接是刻意的：这封信正是钓鱼邮件的标准形状，而对它的正确反应是自己打开应用，不是点邮件里的 URL。
- 忘记密码页**不挡已登录的人**（不像登录/注册页有 `beforeLoad` 弹开）：人可以在这台设备上登录着，同时忘了另一台上要用的密码。

### 事务邮件（`src/server/email/*`）

发六封信，都是有人在等的东西：组织邀请、地址验证、登录验证码、登录链接、密码重置，以及密码已被修改的通知。**不是营销通道**——退信会赔掉发送域的声誉，而赔掉的是这几封信的送达率。

- 走 Workers 的 `send_email` 绑定（`env.EMAIL`），不是 REST API：Worker 里用绑定不需要任何 key。`wrangler.jsonc` 里这一项拼的是 **`name` 而不是 `binding`**，写错 wrangler 直接拒绝整个配置。
- `"remote": true`，和 R2 桶同一个理由：本地模拟绑定会把信吞掉，而这两封信的全部意义就是机器外面有人收到。本地开发也打真实服务。
- **发件域必须是已 onboard 的**（`wrangler email sending list`，目前发信用 `withproducer.com`），别的域会被 `E_SENDER_NOT_VERIFIED` 拒。所以 `SENDER` 不是一句可以随手改的文案——换域名要先 `wrangler email sending enable <domain>`（域名得在同一个 Cloudflare 账号下，命令会自己补 DNS 记录）。
- **`sendEmail` 报告失败而不抛**：调用它的时候，信所讲的那件事已经落库了（邀请行在、验证 token 在），一次发信失败不该把成功的动作变成错误页。它必须**可见**——调用方 log，管理页给出可复制的邀请链接。
- 模板是浅色、纯内联样式、无图片：邮件由别人的客户端渲染，深色模板总会在某个客户端里变成不可读；`<style>` 块会被好几个主流客户端剥掉，外链样式表全都会。按钮下面**重复一遍纯文本 URL**——客户端不渲染 anchor、被转成纯文本、企业网关改写 href，这三种情况下那行 URL 是唯一还能用的东西。
- 验证信**不在注册时发**：验证过的地址在这里只解锁一件事（接受邀请），而多数账号永远收不到邀请；接受邀请页在真正需要的那一刻才请人验证，`callbackURL` 指回邀请本身，验证完直接回到能点"加入"的地方。
- **成功也记一行日志**（带 Cloudflare 返回的 `messageId`）。把信交给 Email Service 之后我们就看不见了，没有这一行，"没收到"和"没发出去"在本地是分不清的；`messageId` 是 dashboard 索引投递记录的句柄。
- 邀请信带 `Reply-To: <邀请人的地址>`，`From` 仍是 `noreply@`：后者是过滤器用来积累声誉的稳定身份，而"这谁邀请我的"该有个能问的地方——一封能回的事务邮件对过滤器本身也是正向信号。验证信没有这个人，所以不带。
- **新域名冷启动是真实存在的**：`withproducer.com` 刚开通时，同一封信 Gmail 进收件箱（它主要看认证，而 SPF/DKIM/DMARC 都是齐的——注意 SPF 挂在 return-path 子域 `cf-bounce.<domain>` 上而不是根域，查根域会以为没配），iCloud 进垃圾箱（它更看发件域历史）。这不是配置问题，靠时间和"标记为非垃圾"积累，代码这边没有开关可拧。

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
- **草稿只在被接受时清空**：`onSubmit` 返回 `false` 表示这次按下被拒了（今天唯一的拒法是余额不够），composer 就把编辑器里的东西原样留着。清掉等于拿人刚写的提示词当拒绝的手续费——而那正是他充完值马上要再用一次的东西。
- **提示框可以收起来**（工具栏上的 `ComposerToggle`）。它是**平移出画面而不是卸载**：编辑器只创建一次、手里攥着没写完的 prompt，卸载等于把草稿吃掉，再回来还是空的。`translate-y-full` 恰好是它自身连下边距的高度，无需估算；React Flow 的容器会裁掉溢出，所以外面不会多出滚动条。过渡写 `transition-[translate,opacity]` 而**不是** `transform`——Tailwind v4 的 `translate-y-*` 写的是独立的 `translate` 属性，盯 `transform` 等于什么都没盯上，面板会直接跳过去只剩透明度在渐变（菜单那边的 `transition-[opacity,scale]` 是同一个坑）。`inert` 是"藏起来"真正生效的那一半：opacity 为 0 的元素照样吃点击、照样占一个 tab 位。
- 节点靠三个 context 拿它不该写进文档的东西：`DragModeContext`（按键级状态，写进每个节点的 data 等于一次按键重写整张图）、`NodeActionsContext`（`canRetry`/`retry` 描述的是**这个 tab 的能力**，不是结果的属性）、`RetryContext`（同一个 retry，已绑定到当前节点，省得深处的失败提示还要接 id 和 data）。
- **画布上的连线只有一种含义：被参考的节点 → 由它生成的节点**（`reference-edge.tsx`）。提交时把 `referenceAssetIds`（`@` 提及给的是**资产** id）对到画布节点，与新节点同一个 Yjs 事务写进 `edges`——同一个文件被两个节点显示时两条都画，`@` 每个文件只给一次候选，挑其中一个当"真正的"来源没有依据。删节点时 React Flow 自己会把连着的边一并发成 `remove`，走 `applyEdgesChange` 落到文档。
- **曲线是 React Flow 的，端点不是**（`getBezierPath` + `BaseEdge`）。端点由 `exitAt` 现算：从各自矩形中心朝对方出去、在边界处截断，顺带得出撞的是哪条边，交给 bezier 当 `sourcePosition`/`targetPosition`。这是 React Flow floating edges 的做法，**不能退回钉死在 handle 上**：节点停在被拖到的任意位置，钉在右侧的话，结果落在源左边的线会从远端出去、绕回来、横躺在两张卡片上。
- **没有手画连线**：节点上那两个 handle 是锚点不是控件（`isConnectable={false}`，不可见、不吃 pointer），只为让 React Flow 肯放置这条边——它对端点解析不到 handle 的边是直接丢掉、不报错的。它们**摆在哪里不影响任何东西**，画线不读它们。
- **线上没有任何自定义效果**：`getBezierPath` 取形、`BaseEdge` 画线，颜色是主题给 `--xy-edge-stroke` 的灰。没有箭头、没有流动的光、没有任何动画——一块摆满图片的板子上，会动的只应该是图片。方向因此只存在于 `source`/`target` 里，屏幕上不表达。

### 资产层（`asset` 表 + R2）

核心不变量：**行先于字节，墓碑先于删字节**。所以桶里永远不会有数据库不认识的对象，代价是需要 `src/server/asset-sweep.ts` 的 cron 清扫（24h 宽限期后回收 tombstoned / 长期 pending / failed 三类行）。

- 上传三步：`POST /api/assets`（校验 mime 与大小 → 插 pending 行 → 返回预签名 PUT URL）→ 浏览器直传 R2（字节不经过 Worker）→ `POST /api/assets/:id/complete`（`head()` 实测大小与 ETag，翻 ready）。预签名同时签死 Content-Type 与 Content-Length（`aws4fetch` 需要 `allHeaders: true`，否则只签 host）。
- 生成两步（`src/lib/generate-asset.ts`）：`startGeneration` 只建行并返回 assetId，客户端先把 id 绑到画布节点；`runGeneration` 先抢跑认领（`updated_at = created_at` 才认领得到——insert 时两列同值，输家在写字节前就出局），再跑 provider 并把字节 bind 回行（`where status='pending' and deleted_at is null`；bind miss 只剩一种含义：行已被删）。模型 provider 的接缝在 `src/server/generation/provider.ts`。
- **失败重试分三层，各管各的**（`src/lib/retry.ts` 是共用的退避工具）：① 服务端 `putGeneratedBytes` 对 R2 写退避重试——provider 已经交出字节，为一次网络抖动丢掉整次生成是管线里最亏的一笔；但**只有 ArrayBuffer 能重放**，定长流已被失败的那次尝试消费光，而为了买一次重试把无上限的视频整个物化进 isolate 内存不值得，所以定长流只试一次。② 客户端上传对 PUT 退避重试（同 URL 同 key 同字节，天然幂等；预签名 URL 5 分钟寿命远长于重试窗口，中途不用重签），创建与 `complete` 只对网络错误和 5xx 重试——4xx 是业务拒绝（409 = 行已不在等上传），重试不会改变答案。③ 失败节点上的手动重试。
- **`runGeneration` 不可重跑**：认领靠 `updated_at = created_at`，第一次调用就把它消费掉了，且没有任何回到"未认领"的路径是别的客户端伪造不了的。所以重试走 `retryGeneration`——服务端从失败行复制 prompt/model/kind/params 与 `asset_reference` 建**新行新 key**，旧行墓碑化。参数必须从行里取而不是从节点：`resolution`/`duration`/引用列表从来没进过画布文档，客户端只能靠猜。
- 上传的手动重试只能由**还握着 `File` 的那个 tab** 提供（`useUploads` 的 sources map），刷新即失效。所以 `canRetry` 是 `NodeActionsContext` 上的一个函数而不是节点数据的一个字段——它描述的是这个 tab 的能力，不是结果的属性，写进 Yjs 文档就成了向所有人承诺只有自己能兑现的事。
- **所有模型请求都走 Vercel AI SDK + AI Gateway**（`src/server/generation/gateway.ts`）。一个 key、一个账单、一个可追踪的出口，模型 id 是数据（`creator/model`）而不是一次 import 选择——这正是目录能是一张普通列表的原因。**key 必须显式传**：SDK 默认实例读 `process.env.AI_GATEWAY_API_KEY`，而 Workers 上环境是 binding，`process.env` 即便开了 `nodejs_compat` 也是空的，默认实例会拿着空凭证去请求、每次 401。客户端按 isolate 建一次。
- **目录是唯一的模型真相**（`src/lib/models.ts`，从 composer 里搬出来的，因为服务端也要读它）。每条的 `gateway` 字段既是 Gateway 上的 id，也是"这个选项是不是真的"的开关：有则真跑，无则落回 `sampleProvider` 返回替身文件——`getProvider` 的全部路由规则就是这一条。**字段值全部是从 Gateway 自己的模型表（`https://ai-gateway.vercel.sh/v1/models`，免鉴权）读出来核对过的**，不是照厂商文档猜的；目录里原先标注"未核实"的两个 id 也因此定案，且两个都是错的（ByteDance 发布的是 `bytedance/seedream-5.0-pro`）。缺失不是遗漏：Sora / ElevenLabs / Lyria 根本不在 Gateway 上，Google 的 Nano Banana 在但属于**语言**模型（图片在 `result.files` 里回来），是另一种调用形状。
- **一个模态一个 SDK 函数**（`gateway-provider.ts`）：`generateImage` / `experimental_generateVideo` / `generateSpeech`。三者都把整份文件物化进 isolate（都只回 `Uint8Array`，没有流式版本），图片和语音无所谓，**视频是这条路的上限**——Worker isolate 只有 128MB，长片 1080p 会撞上去。参考图以**预签名 URL** 传给厂商而不是字节：SDK 两者都收，URL 省掉"Worker 先从 R2 取回来再发出去"这一整趟。图片的分辨率档位**故意没接**：`generateImage` 只收 `size` 或 `aspectRatio` 二选一，而各家对 `size` 的支持不一致（xAI 完全不收），算出来的像素对会在一半目录上失败；比例是全都认的，所以只发比例。
- **音乐没有 Gateway 后端**：Gateway 上没有 music 类型的模型，不是没接，是货架空的。`GATEWAY_MODALITIES` 因此只列 image/video/voice。
- **取字节分两条路，按消费者分，不要合并**：浏览器走 `/api/assets/:id/content`（同源、稳定、每次重新鉴权）；**非登录**的模型 provider 走 R2 预签名 URL（`src/server/asset-url.ts` 的 `assetDownloadUrl`，10 分钟）。合并成一条都会赔：全用签名 URL 则 URL 每次续期都变、浏览器缓存全废且撤权在 TTL 内无效；全用 cookie 路由则 provider 根本取不到。
- 画布节点**只存 `assetId`**，URL 由 `assetContentUrl(assetId)` 纯函数派生（`src/lib/asset-links.ts`），不查询、不续期、不入档。
- **URL 稳定带来一个坑**：`assetId` 在生成*开始*时就写进节点，而字节要到 ready 才有，中间请求会 404 并把媒体元素**永久**标记为 broken（URL 不再变化，没有第二次加载）。`assetSrc` 因此以 `status === "ready"` 为闸门。
- 预签名 URL 里钉死了 `response-content-type` 与 `response-content-disposition`（值取自 `servableMime`），所以白名单裁决在 R2 侧照旧生效；改查询参数会被 R2 403（已实测）。
- **每个资产都有 `title`**：上传取原始文件名（去扩展名），AI 生成由模型总结提示词（`src/server/generation/title.ts`，走 Gateway 上的 `anthropic/claude-haiku-4.5`）——这一步必须用模型，把"生成一张在草地上奔跑的小狗的照片"变成"奔跑的小狗"没有机械算法，而图像/视频/音频 API 只回字节和 `Content-Type`，从不回文件名。命名与生成**并行**跑（provider 才是慢的那半），失败只返回 null 不拖垮生成，`assetTitle` 有完整回退链。**没配 `AI_GATEWAY_API_KEY` 时直接跳过、不发请求**——否则 SDK 会开一个注定失败的连接，错误从 `fetch` 深处异步抛出，绕过 catch 并在 dev server 上弹错误覆盖层。
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
- 用 curl 打 `/api/auth/*` 必须带 `Origin`，否则一律 `MISSING_OR_NULL_ORIGIN`；且值要匹配 `BETTER_AUTH_URL`（`http://localhost:3000`）而非实际监听端口——3000 被占时 dev server 会换端口，请求打新端口、Origin 仍写 3000 才通得过。另外 `accept-invitation` 要求 `email_verified`（原因见"成员与邀请"），脚本里造的测试账号得先把这列置 true。
- **测邮件流程时别真发信到 `@example.com`**：那个域不收邮件，退信会记在发送域头上。把 `wrangler.jsonc` 里 `send_email` 的 `"remote"` 临时改成 `false`，miniflare 会把每封信**写成文件**并在控制台打出路径（`.wrangler/tmp/email/*/email-text/*.txt`）——验证链接、重置链接都能直接从里面 grep 出来，注册→验证→自动登录、忘记密码→重置→会话清零这些整条链路都能在不发一封真信的前提下跑完。**跑完记得改回 `true`**。真要试投递，发给自己控制的地址。

## 代码风格

- 注释写"为什么"，不写"是什么"。现有代码里大量块注释记录权衡与失败模式，改动时保持这个密度，推翻某个决定时同步更新对应注释。
- `oxfmt` 负责格式化（无尾逗号、import 排序、tailwind class 排序），`oxlint` 只开 correctness 类。
- 提交信息用中文 Conventional Commits，例如 `feat(studio): 画布接入多人协同`。
