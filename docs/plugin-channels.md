# 插件与通道

插件描述支付能力；通道是插件的一个账号配置实例。一个插件可创建多个通道，一个通道可分配给多个业务应用。

## 使用

1. 在“插件与通道”选择支付宝当面付、支付宝账单收款或 Mock，点击“创建通道”。
2. 填写通道名称和独立账号配置，启用并保存。密钥加密入库，管理接口只返回是否已配置；留空保留，勾选清除才删除。
3. 点击“真实接口检测”。支付宝当面付调用真实查单接口并验证响应签名；账单采集调用真实账务查询，验证签名和分页数据结构，不导入检测流水、不改变采集游标。
4. 点击“创建 ¥0.01 实付单”，打开收银台付款。它使用正常订单和支付核心，真实到账后显示“实付已验证”。账单金额模式可能有金额偏移，以收银台显示为准。测试款不自动退款，官方通道可按正常退款流程处理；账单收款需人工退款。
5. 在“应用通道分配”或创建应用时选择已启用且检测通过的通道。

## 检测状态的含义

| 状态 | 证据与边界 |
|---|---|
| 待检测 | 当前配置没有检测记录 |
| 接口已验证 | 当前账号成功访问对应上游接口；不证明付款、二维码归属、当面付签约或业务 Webhook 可用 |
| 实付已验证 | 当前配置创建的验收支付已通过正常支付核心确认成功；不证明业务系统 Webhook 已验收 |
| 待实付验证 | 外部 Watcher 无可主动探测的接口，必须实付并成功匹配到账流水 |
| 模拟配置通过 | Mock 配置有效，仅用于开发 |
| 检测失败 | 上游错误、签名失败、网络错误或返回结构异常；仅返回安全错误码 |

检测是某一时间点的证据，不承诺未来持续可用。每次保存配置都会增加版本并使原检测失效；已明确分配实例的应用会暂停新支付，直到重新检测。历史支付的查单、回调、关单和退款不受停用新订单影响。最近接口检测失败会覆盖较早的实付验证结果。

## 隔离与兼容

- `Application.defaultChannelId` 绑定应用默认实例，`Payment.channelId` 固定每次支付实际使用的实例。切换应用通道不会改变历史支付的查询、回调验签或退款账号。
- 新账号请创建新通道。存在交易或采集断点时不允许更换账号身份、网关或收款码；允许轮换密钥。
- 账单通道拥有独立的配置、Watcher URL/令牌、采集游标、租约、流水指纹、备注/金额预约与候选匹配范围。同一收款用户 ID 或收款码不得重复创建通道，应共用同一实例。
- 首次使用时导入三个原默认通道。`channelId = NULL` 的旧支付只归属于对应原默认通道，不能被其他实例匹配。
- 旧 ePay、原生 API 的 `channel` 仍表示插件类型。已分配具体实例的应用只允许使用该实例的插件，客户端不能自由指定其他实例 ID。未分配实例的旧应用沿用原默认通道，升级后建议逐一检测并显式分配。
- 原账单配置页和 `/alipay-bill/flows` 保留为默认账号入口；新通道使用 `/api/v1/channels/alipay-bill/{channelId}/flows`。
- 验收订单归属专用停用应用“通道实付验收”，没有对外 API 凭证或业务 Webhook，订单和流水照常保留。

## 升级

先备份数据库和加密密钥，再在目标环境执行：

```sh
npm ci
npm run db:generate
npm run db:deploy
npm run build
```

本次迁移只新增 `channel_instances` 表，以及应用/支付的可空通道绑定字段和索引。先完成迁移，再启动新版 API、Worker 和 Web。Docker Compose 的 API 启动命令已包含 `db:deploy`。

保留原加密密钥。默认通道首次导入后，以数据库为准，修改环境变量不会覆盖已经保存的实例。

## 管理接口

所有以下接口使用原管理鉴权与审计：

| 方法 | `/admin/v1` 下的路径 | 用途 |
|---|---|---|
| GET | `/plugins` | 内置插件目录与能力 |
| GET / POST | `/channel-instances` | 列出 / 创建实例 |
| GET / POST | `/channel-instances/{id}` | 读取 / 保存配置 |
| POST | `/channel-instances/{id}/check` | 检测保存后的配置，正文 `{revision}` |
| POST | `/channel-instances/{id}/test-payment` | 创建或复用当前配置验收单，正文 `{revision}` |
| GET | `/channel-instances/{id}/collector` | 当前账单通道的采集状态 |
| POST | `/applications/{id}/channel-instance` | 分配通道，正文 `{channelId}` |
| POST | `/applications/{id}/rotate-credentials` | 重置 API Key、Webhook Secret 与 ePay Key，返回值只显示这一次，`epayPid` 不变 |
| POST | `/applications/{id}/status` | 启用 / 停用，正文 `{status: "ACTIVE" \| "DISABLED"}` |
| POST | `/applications/{id}/delete` | 删除应用。无业务数据时直接删行；有订单 / 退款 / 通知投递时走归档删除，返回 `{archived: true, cleared}` 清理明细 |

删除分两条路径，由服务端按业务数据量自动判定，前端不需要传参：

- **直接删除**：订单、退款、通知投递都为 0 时物理删行。
- **归档删除**：存在任意一条业务数据时，在**同一事务**内把该应用从在用数据集摘除 —— 凭证重新随机、状态置 `DISABLED`、写入 `archivedAt` / `pausedAt`；该应用下的订单打上 `orders.deletedAt` + `deletedWithApplicationId`；未成功的支付尝试、未投递的通知、未处置的异常与回执线索一并清理；**已成功的支付单与已发起（含 PROCESSING/UNKNOWN）的退款保留行**，因为通道侧的钱已经动了，删掉就再也对不上账。行本身不删，DBA 可按 `orders.deletedWithApplicationId` 反查还原整批数据。

归档后生效的边界：业务接口与 ePay 接口一律拒绝该应用的凭证（`middleware/auth.ts`、`routes/epay.ts` 都查 `archivedAt`）；订单、支付、退款的业务查询统一带 `orders.deletedAt: null`；管理台的订单 / 通知 / 异常 / 看板计数同样排除归档数据，但**订单详情不做过滤**（按订单号仍可直接打开，这是追溯历史资金流向的唯一出口），退款列表也保留并标注「已归档」。归档集合由应用列表的「显示已归档」开关控制。

通道实付验收用的内部应用 `channel-diagnostics` 既不参与启停也不允许删除（`APPLICATION_INTERNAL`）。管理端变更统一使用 POST 动作式路径，因此前端 BFF 不需要放开 PATCH / DELETE。

创建/保存正文为 `{name, plugin, enabled, settings, revision?}`；修改必须带当前版本。插件注册在 `apps/api/src/channels/plugins.ts`，实例管理在 `channel-instance-service.ts`，运行时通过 `adapterForPayment()` 解析支付绑定。目前提供内置插件，不支持上传执行第三方插件代码。

## 验证边界

自动测试覆盖配置加密脱敏、版本失效、真实接口调用路径、错误处理、账号绑定、账单候选范围以及回调竞态。模拟上游和数据库的测试不能代替真实 MySQL 并发测试、数据库迁移验收、支付宝权限验收和小额实付。
