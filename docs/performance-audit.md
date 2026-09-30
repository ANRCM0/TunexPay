# 性能审计与优化记录

本文件记录一次以「不新增功能、只做性能优化」为边界的热点审计：找到的瓶颈、已经落地的改动，
以及需要真实 MySQL/Redis 环境才能验证、因此留待决策的候选优化。

## 审计方法与环境限制

本次环境的限制必须先说清楚，避免把推断当成实测：

- **没有 Docker、没有 MySQL、没有 Redis**，因此无法跑 `EXPLAIN`、无法做压测、无法测量真实延迟与 QPS。
- 结论来自三类可复核的证据：Prisma schema 与已有迁移里的**索引清单**、各查询的**谓词与排序形态**、
  以及 Node/Prisma 调用次数可直接读出的**语句放大点**。
- 可用 MySQL 的机器上，应按本文「验证清单」补做 `EXPLAIN` 与并发验证。

## 已经落地的优化

### 1. 默认通道不再无条件 upsert（写入放大）

`ensureLegacyChannels()` 原来对 3 个默认通道固定 `upsert(update: {})`。这个函数在
发起支付时的绑定检查、通道列表、后台通道操作里都会被调用，稳定态下每次调用就是 3 条写入语句
外加 3 个通道行上的写锁。

改为一次主键集合读取，只补缺失的行，并发建行交给主键唯一约束（P2002 视为「已存在」）。

- 稳定态：3 写 + 1 读 → **1 读**。
- 相关代码：[channel-instance-service.ts](../apps/api/src/services/channel-instance-service.ts)

### 2. 账单配置读取不再自我 upsert

`loadBillSettings()` 原来用 `upsert(update: {})` 初始化默认行，于是**每一次读配置**都带一条写入
语句和一次行锁。读配置出现在：外部 Watcher 每投递一次流水、采集器每一轮、后台每次读取、
`ensureLegacyChannels()`。

改为「先读、缺了才补」（P2025 才创建，P2002 回读），并且把 `FOR UPDATE` 放在读取之前而不是之后：

- 普通读取：写 + 读 → **1 读**。
- 加锁路径（`saveBillSettings`、账单支付创建）：upsert + 锁 + 读 → **锁 + 读**。
- 相关代码：[bill-settings-service.ts](../apps/api/src/services/bill-settings-service.ts)

### 3. 支付宝账单采集器的空闲开销

采集器由 Worker **每一跳（3 秒）**调用，原来每一跳都会：在 `bill_channel_settings` 上取一次
`FOR UPDATE`，读一次配置，查一次到账需求，然后**无条件写一次心跳**。三处调整：

1. 配置只取快照、不再取写锁。锁在事务提交时就释放，而真正的采集在事务之外进行，中途的配置变更
   由既有的 `billRevision` 复查负责；每一跳对共享配置行取写锁只会给面板保存配置制造锁等待。
2. 空闲心跳改为条件刷新（心跳确实超过 30 秒才写）。无到账需求时状态页显示 `IDLE` 且不读心跳，
   所以以前那种每跳一次的空写没有观测价值。
3. 采集关闭时把 `nextRunAt` 推后 30 秒（条件更新，推过的一跳不会再推）。面板保存配置会把
   `nextRunAt` 拉回当前时间，所以重新打开采集仍会被紧接着的一跳发现。

- 空闲路径：读配置 + 取写锁 + 查需求 + 空写心跳 → 读配置 + 查需求（心跳约 1/10 的跳才写一次）。
- 相关代码：[alipay-bill-collector-service.ts](../apps/api/src/services/alipay-bill-collector-service.ts)

### 4. 补 6 个缺失索引

迁移：`prisma/migrations/202609180001_query_indexes/migration.sql`。索引名与列序已用
`prisma migrate diff --from-empty --to-schema-datamodel` 的输出逐字对齐（不是手写猜测）。

| 索引 | 服务的查询 | 现状问题 |
| --- | --- | --- |
| `orders(deletedAt, paidAt)` | 总览「今日实收」`paidAt >= 今天` | `paidAt` 上**没有任何索引**，每 10 秒轮询一次全表扫描 |
| `payments(status, paidAt)` | 今日成功支付金额聚合 | 只有 `(status, updatedAt)`，会扫描当天之前的所有成功支付 |
| `orders(deletedAt, createdAt)` | 今日订单数、后台订单列表排序 | 时间范围能走索引，但 `deletedAt` 要回表过滤 |
| `refunds(createdAt, id)` | 退款列表按时间倒序 | 没有 `createdAt` 前缀索引，整表 filesort |
| `webhook_deliveries(createdAt, id)` | 通知列表按时间倒序 | 同上 |
| `receipts(occurredAt, id)` | 对账流水不筛状态时按时间倒序 | 同上 |

### 5. 收银台长轮询改为事件唤醒（数据库负载影响最大的一项）

原来的 `?wait=` 长轮询内部是**每 400ms 查一次库**（[channels.ts](../apps/api/src/routes/channels.ts)），
收银台固定 `wait=12`（[cashier.tsx:23](../apps/web/components/cashier.tsx)）。按每个「未付款的收银台
页面」算：12 秒窗口 ≈ 30 次查询 ≈ **2.5 次/秒**，每次 `publicPayment` 还要带出订单行，支付高峰时
明显超过支付流程本身的十几条语句。

现在：支付核心在状态**提交之后**调用 `publishPaymentChange()`，通过 Redis 频道
`tuoxin:pay:payment-changed` 唤醒正在等待的长轮询，等待者醒来立刻重查数据库（以数据库为准）。
发布点：`updatePaymentObservation`（仅在状态真的推进时）、`markPaymentSucceeded`、`closePayment`。

- 命中唤醒：确认延迟从「最多 400ms」降到「一次 Redis 往返」，实测用例 0.66ms 返回。
- 兜底：`PAYMENT_WAKE_FALLBACK_MS = 1_500`。Redis 不可用、消息丢失或状态由不发布唤醒的路径改动时，
  等待者仍在 1.5 秒内重查，行为只会变慢不会错。等待者按支付单登记，只被自己那条消息唤醒。
- 发布/订阅失败只记 warn，永远不影响资金流程；订阅失败自动退回纯兜底轮询。
- 查询量：每个未付款收银台从约 30 次/12 秒降到约 9 次/12 秒（兜底）+ 每次真实状态变更 1 次。
- 相关代码：[payment-wake.ts](../apps/api/src/lib/payment-wake.ts)、
  [channels.ts](../apps/api/src/routes/channels.ts)、[payment-service.ts](../apps/api/src/services/payment-service.ts)

### 6. `createOrder` 去掉多余的 Serializable

该事务里只有两条 `INSERT`、没有任何 `SELECT`，隔离级别不影响可见性判断，去掉可省掉 Prisma 在每个
事务前发出的 `SET TRANSACTION ISOLATION LEVEL` 往返（[order-service.ts](../apps/api/src/services/order-service.ts)）。

这是本节唯一一处可以安全去掉 `Serializable` 的地方 —— 其余位置**不能**用同样理由处理，原因见下面
「C」一节（原假设已被证伪）。

### 7. 账单流水批量投递改为批内有界并发

[receipt-flow-service.ts](../apps/api/src/services/receipt-flow-service.ts) 原来对一批最多 100 条流水
逐条 `await`（每条 8–12 条 SQL）；内置采集器更是**逐条**校验 + 逐条投递。现在：

- `ingestAlipayBillFlows` 用内部工作池 `runBounded` 以 `FLOW_CONCURRENCY = 4` 并发处理，
  **返回值严格保持输入顺序**（结果按下标写回），失败时停止领取新记录、等在飞任务结算后抛第一个错误。
- 归一化仍留在每条流水自己的步骤里，与原来的逐条循环一致：某条流水格式不合法时，它前面的合法
  流水已经入库，不会因为一条坏数据把整批变成「什么都没发生」而卡住调用方的重试。
- 采集器页循环改为「先整页逐条校验窗口，再整页一次投递」（`PAGE_SIZE` 与 100 条上限一致），
  租约续期、游标推进、`processedRecords` 累加、失败退避全部未动。

### 8. 总览接口 15 条语句 → 2 条

[admin.ts](../apps/api/src/routes/admin.ts) 的 `/admin/v1/dashboard` 原来用 `Promise.all` 跑 14 条
`count/aggregate`（大多带 `order.deletedAt IS NULL` 关联条件），前端每 10 秒轮询一次
（[dashboard.tsx:30](../apps/web/components/dashboard.tsx)）。现在这 14 个计数合并成**一条**
`db.$queryRaw` 条件聚合（[dashboard-stats.ts](../apps/api/src/lib/dashboard-stats.ts)，8 张表各一个
标量子查询），加上保留原样的 `recentEvents`，每次刷新只剩 2 条语句。

合并时特别处理了三点：关系过滤必须是**内连接语义**（`LEFT JOIN ... WHERE o.deletedAt IS NULL` 会把
`orderId` 为空的行也算进来，是错的），`OR: [{ payment: {...} }, { payment: null }]` 要写成
`paymentId IS NULL OR EXISTS (...)`，以及 MySQL 下 `COUNT/SUM` 返回 BigInt/Decimal 必须显式收敛成
number（否则 `JSON.stringify` 会抛 `Do not know how to serialize a BigInt`）。

**边界值按 UTC 约定传入**：Prisma 对 MySQL 的 `DATETIME` 一律按 UTC 存取，所以「今天零点」必须换算成
UTC 字面量。这里不能用本地时间字段 —— compose 只给 mysql 服务设了 `TZ: Asia/Shanghai`，app 容器没有设
（是 UTC），而裸机或 `dev` 运行时进程时区可能是 `+08:00`，用本地字段会把「今天零点」整体平移。

## 已评估但不采纳的优化

### A. 热路径的 Serializable 隔离级别（只有 `createOrder` 例外，见第 6 项）

原来的假设是：这几处事务已经用 `SELECT ... FOR UPDATE` 显式锁住关键行，互斥不依赖隔离级别，
所以可以降级省掉锁开销。逐条核对「先加锁读、再用普通 SELECT 重读」的顺序后，这个假设**被证伪**：

| 位置 | 顺序 | 这次重读决定什么 |
| --- | --- | --- |
| `createPayment`（[payment-service.ts:42](../apps/api/src/services/payment-service.ts)） | 先 `FOR UPDATE` 订单行，再 `tx.order.findFirst` | 订单是否仍可发起支付 |
| `markPaymentSucceeded`（[payment-service.ts:164](../apps/api/src/services/payment-service.ts)） | 先 `FOR UPDATE` 订单行，再 `tx.order.findUniqueOrThrow` | 是否晚到重复支付、谁是胜出支付单 |
| `saveChannel`（[channel-instance-service.ts:125](../apps/api/src/services/channel-instance-service.ts)） | 先 `FOR UPDATE` 通道行，再读当前实例 | revision 冲突检查 |
| `createRefund` / `finalizeRefund`（[refund-service.ts:33](../apps/api/src/services/refund-service.ts)、`:112`） | 先锁支付单/退款单，再聚合已退金额、重读订单 | 累计退款上限、订单退款状态 |

关键点：MySQL 在 `Serializable` 下会把普通 `SELECT` **隐式升级为加锁读**，加锁读会等待并发写事务
提交并读取最新已提交版本。也就是说，这些「先锁行、再用普通 SELECT 重读」的写法之所以成立，恰恰
是因为隔离级别让重读变成了加锁读。降到 REPEATABLE READ 之后重读退化为事务开始时的快照读，后果
分别是：在已支付成功的订单上再创建支付单、把重复支付误判成首次成功并改写胜出支付单、并发保存
互相覆盖通道配置、退款累计上限判断失真 —— 都是资金语义问题，收益（少几个共享锁）远不值这个风险。

本轮因此**只对 `createOrder` 去掉了 `Serializable`**：该事务内部只有两条 `INSERT`、没有任何
`SELECT`，隔离级别不影响可见性判断，去掉可省掉 Prisma 每个事务前的
`SET TRANSACTION ISOLATION LEVEL` 往返。其余位置一律保持原状。

真正值得继续看的是**事务时长的另一面**：`createPayment` 为了让通道配置保持最新，会对共享的
`channel_instances` 行取写锁，等于把「同一通道下的所有并发支付创建」串行化。这与隔离级别无关，
要动它必须重新推导通道校验的可见性需求，并且只能在真实 MySQL 上做并发验证，本轮不动。

### B. 给采集器加 `nextRunAt` 门控（会让空闲语句数再降约 3 倍）

采集器由 Worker 每一跳（3 秒）调用。只有在「已存在 `billCollectorState` 行且 `nextRunAt` 在未来」
时才值得跳过；但当前实现里，上一轮采集成功后 `nextRunAt` 只被推到 +1 秒，而没有到账需求时
`nextRunAt` 根本不会被推进，所以门控现在几乎不会生效。

要让它生效，需要把「无需求」分支也写成 `nextRunAt = now + pollSeconds`，并把 `nextRunAt` 当作唯一的
唤醒信号。这会改变语义：**任何不经过 `prepareReceiptPayment` 就出现的需求**（人工写库、未来新增的
入口）最多要等一个轮询周期才被采集。收益是空闲时语句数再降约 3 倍（约 80 → 约 27 条/分钟），代价是
在收款确认这条链路上引入一个「最多 10 秒」的新延迟来源，并需要调整 3 个已有时序用例。

本轮判断不值得：绝对量很小（自托管单库、每分钟几十条主键级短语句），而它动的是「扫码后多久看到
支付成功」的感知路径，风险与收益不匹配。

### C. 采集器关闭状态下的进程内配置缓存

若一个部署启用了 `ALIPAY_BILL` 插件但从未产生过账单支付，就没有 `billCollectorState` 行，
采集器仍会每一跳读一次配置。可选的缓解是进程内短期缓存「该通道采集已关闭」的结论（TTL 约 10–30 秒），
但这会让「面板打开采集」最多延迟一个 TTL 才生效，与「配置动态生效」的预期冲突。

本轮已经通过条件更新把**关闭状态**的重复检查压到 30 秒一次（见第 3 项第 3 点），剩下的只有
「已启用但当前没有待收流水」这一种情形，同样属于绝对量很小的空闲开销，因此不动。

**注意**：不要为了缓解它而去顺手创建 `billCollectorState` 行 —— 状态行的存在会被
`saveBillSettings` / `saveChannel` 当作「已有采集断点」，从而阻止运营在上线前修正填错的收款账号。

## 验证清单

配套的**可执行核对表**见 [性能改动验收核对表](perf-verification-runbook.md)：里面有逐步命令、期望观察值
和一张待填的实测表；两个脚本分别覆盖「索引与执行计划」和「并发正确性」：

```bash
cd apps/api
npx tsx src/scripts/verify-indexes.ts            # 只读，可在生产库跑
npx tsx src/scripts/verify-concurrency.ts --yes  # 写 perf-verify-* 测试数据并自动清理
```

在本仓库已完成：

- `npm run typecheck` 通过（api + web）。
- `npm test` 通过：api **29 文件 / 182 用例**、web **6 文件 / 38 用例**（改动前基线是 api 26 / 157、web 6 / 38）。
- `prisma validate` 通过。
- 6 个新索引在 `prisma/schema.prisma` 与迁移文件里都存在，名称与列序和
  `prisma migrate diff --from-empty --to-schema-datamodel` 的输出逐字一致。
- 收银台唤醒路径与兜底路径的用例：命中唤醒 0.66ms 返回、无唤醒时 1.5s 兜底、`wait=1` 在预算内返回。
- 流水并发用例：10 条一批的返回顺序与输入一致、并发峰值 >1 且 ≤4、失败后不再领取新记录、P2002 去重路径。
- 总览用例：BigInt/Decimal 收敛成 number、只发一条聚合查询、`recentEvents` 仍取 12 条、
  边界字面量按 UTC 格式化。

需要在有 MySQL/Redis 的环境补做：

1. `docker compose up -d` 后确认 `prisma migrate deploy` 正常应用新迁移，`SHOW INDEX FROM orders`
   等能看到 6 个新索引。
2. 对总览的 8 张表查询、订单/退款/通知/流水列表各跑一次 `EXPLAIN`，确认走索引而不是全表扫描或 filesort；
   并确认合并后的聚合 SQL 在真实 MySQL 上可执行、参数绑定正确、`COUNT/SUM` 的返回类型符合预期。
3. 长轮询：在真实 Redis 下验证「状态变更后等待者是否立刻返回」，并量出「每笔成功支付的平均查询数」
   相对 400ms 轮询的下降幅度；同时验证 Redis 挂掉时兜底轮询仍能让收银台正常确认。
4. 流水并发：真实 MySQL 上对比一批 100 条的串行 vs 并发 4 的 P95，并观察锁等待/死锁率（1213/1205），
   重点是同 `fingerprint` 并发 `create`、`markMismatch` 与 `markPaymentSucceeded` 两个事务的并发，
   以及 `openPaymentException` 在唯一键上的 P2002。
5. 采集器：确认空闲一轮的语句数下降、心跳仍按预期刷新、`nextRunAt` 退避与面板保存后的即时唤醒正常。
6. 隔离级别：本轮除 `createOrder` 外没有降级；若将来仍要尝试，必须先在同一订单并发支付、同一应用
   并发成功、并发创建退款、并发保存通道配置这些场景下验证「先锁行再重读」是否仍能读到最新值。
