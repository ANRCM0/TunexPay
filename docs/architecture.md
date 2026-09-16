# TUOXIN Pay v0.1 架构说明

## 设计边界

系统只服务 TUOXIN 自有业务，因此第一版以 `Application` 代替完整商户体系。不包含余额、冻结、分账、清算、提现、商户费率与多级权限。

## 核心不变量

1. 金额一律保存为整数分，币种第一版固定 CNY。
2. `Order` 表示业务应收；`Payment` 表示一次通道支付尝试。二者不得合并。
3. 一张 Order 最多有一个胜出的 Payment；其他晚到成功记为 `PAYMENT_LATE_DUPLICATE`，不重复通知业务。
4. 所有成功来源（支付宝回调、主动查单、Mock、账单匹配）最终只能调用 `markPaymentSucceeded()`。
5. Payment、Order、Event、WebhookDelivery 在同一个数据库事务内提交。
6. Redis 不保存支付事实。Webhook 和查单 Worker 丢任务时，分别由数据库的 `PENDING + nextAttemptAt` 与业务记录上的 `nextQueryAt` 重新发现。
7. 回调验签成功不代表业务处理成功；`ChannelCallback.processed=false` 的重复回调必须继续处理。

## 状态模型

```text
Payment
CREATED → PROCESSING → SUCCESS
                    ├→ FAILED
                    ├→ UNKNOWN → SUCCESS / FAILED / PROCESSING
                    └→ CLOSED → SUCCESS (晚到成功)

Order
CREATED → PENDING → SUCCESS → PARTIALLY_REFUNDED → REFUNDED
    └──────────────→ CLOSED (过期)

WebhookDelivery
PENDING → PROCESSING → SUCCESS
    ↑          │
    └──────────┘ lease expired / retry
               └→ DEAD (达到重试上限)

Refund
CREATED → PROCESSING → SUCCESS
                    ├→ FAILED → SUCCESS (可信查单恢复)
                    └→ UNKNOWN → PROCESSING / SUCCESS / FAILED
```

`FAILED` 和 `CLOSED` 仍允许被可信通道结果推进到 `SUCCESS`。这是为了处理请求超时、关闭竞态以及上游晚到回调，不能因为本地已经进入终态就把真实到账静默丢掉。

## 支付成功事务

```text
BEGIN
  lock Payment
  validate amount and transition
  lock Order
  update Payment = SUCCESS

  if Order already has a winning payment:
    insert PAYMENT_LATE_DUPLICATE
    upsert PaymentException(LATE_DUPLICATE)
    COMMIT
  else:
    update Order = SUCCESS
    insert PAYMENT_SUCCEEDED
    insert ORDER_SUCCEEDED
    insert WebhookDelivery (Outbox)
    COMMIT
```

晚到重复支付会创建独立 `PaymentException`，阻断第二次业务成功通知。管理员可进入处理、解决或忽略；对该重复 Payment 完成全额 API 退款时异常单自动解决，但不会改变原业务订单的退款状态，也不会发送业务退款通知。账单收款不具备 API 原路退款能力，需要人工退款并填写凭证后关闭异常。

## Webhook 可靠性

- API 事务只写 MySQL Outbox，不把“成功入 Redis”当成可靠性前提。
- Worker 每 3 秒扫描到期记录并将 ID 投递到 BullMQ。
- 真正执行前使用条件更新认领任务，并设置 30 秒租约。
- Worker 崩溃后，`lockedUntil` 过期的任务重新回到 PENDING。
- 失败采用带抖动的指数退避，默认最多 8 次；超过后进入 DEAD，可从后台手动重试。
- 禁止自动跟随 30x，生产默认阻止 HTTP、localhost、私网及保留地址，降低 SSRF 风险。

## 支付与退款恢复

- 外部请求发出前先写入 `PROCESSING + nextQueryAt`，即使进程随后崩溃，Worker 也能重新发现。
- Worker 使用 `status + nextQueryAt + queryAttempts` 条件更新认领记录，多实例不会重复执行同一次查询。
- 查询从 15 秒开始指数退避，最长 15 分钟，最多 20 次。
- 通道返回旧状态时不得让本地状态回退；可信 `SUCCESS` 仍可恢复 `FAILED`、`CLOSED` 或 `UNKNOWN`。
- 达到上限后清空 `nextQueryAt` 并写入 `*_RECOVERY_EXHAUSTED` 事件，保留原状态等待人工处理。
- Mock 支付不自动查询，避免开发环境的待点击付款被无意义轮询。

## 账单对账

- 支付宝 CSV 先转换为与通道格式无关的 `Receipt`，账单原始行保存在 `rawPayload`。
- `fingerprint` 对渠道、日期、方向、各类单号、金额和发生时间做 SHA-256，同一流水重复上传不会重复处理。
- Matcher 只匹配 ALIPAY 支付；商户单号与渠道流水号指向不同记录时立即标记 `MISMATCH`。
- 金额必须以整数分完全一致。差一分也不会推进资金状态。
- 收入通过 `markPaymentSucceeded()`，退款通过退款服务的统一成功事务；Matcher 不直接更新 Order、Payment 或 Refund 状态。
- `UNMATCHED` 表示对应业务单可能尚未入库，可人工重跑；`MISMATCH` 表示存在标识或金额冲突，需要先调查。
- `ReconciliationRun` 记录每个账单日的导入、重复、跳过、匹配和差错数量。当前由管理员上传文件，后续自动下载仍复用同一 Parser 和 Matcher。

## 账单收款 Watcher

- `ALIPAY_BILL` 是个人收款码 + 流水监听支付渠道，与官方支付宝日账单对账是两条独立链路。
- 发起支付时为该 Payment 预约备注码或唯一金额，并保存 `receiptValidFrom/receiptValidUntil`；业务金额 `amount` 永不被临时改写。
- Watcher 使用专用令牌向 `/api/v1/channels/alipay-bill/flows` 投递标准流水，也兼容 MPAY 的 `{record:{order_no,price,paid_at,remark}}` 结构。
- 流水先通过唯一指纹去重，再使用数据库租约认领；匹配顺序为交易号、备注码、有效期内金额。
- API 在状态推进途中崩溃时，Worker 会扫描租约已过期的 `PROCESSING` 流水并重新处理，不依赖 Watcher 恰好再次投递。
- 多笔候选时不选择“时间最近”的订单，而是标记差错并创建 `RECEIPT_AMBIGUOUS` 异常，避免错单入账。
- 识别预约保留到有效期结束，即使支付成功或本地关单也不提前复用金额；这样晚到付款仍能被识别。

## 订单过期

- 创建订单时同时写入 `expiresAt` 与持久化调度字段 `expirationNextAttemptAt`。
- Worker 通过条件更新和 60 秒租约认领到期订单，多实例不会同时处理同一订单。
- 支付宝支付先主动查单；确认未支付后才调用通道关闭，所有活跃支付均关闭后才更新 Order。
- 网络错误或关闭结果不确定时保留订单状态，按 30 秒至 1 小时的指数退避重试。
- `CLOSED` 后的可信回调仍允许通过统一成功事务恢复为 `SUCCESS`，避免真实到账被本地终态吞掉。

## 管理审计

- 管理端身份验证通过后的所有变更请求都会写入 `AdminAuditLog`。
- 审计保留动作、资源、成功结果、HTTP 状态、错误码、Request ID、来源 IP 和 User-Agent。
- 请求正文和响应正文不会进入审计表，避免 API Key、账单数据及其他秘密二次落库。
- 审计写入失败只记录服务错误，不回滚已经成功的支付管理操作。

## 密钥

- API Key 只保存 SHA-256 摘要。Key 本身有 192 bit 随机部分，不依赖用户口令强度。
- Webhook Secret 和 ePay Key 因为需要用于出站签名，使用 `SECRETS_ENCRYPTION_KEY` 做 AES-256-GCM 加密。
- 支付宝私钥通过环境变量注入，不进入数据库、日志或代码库。

## 后续路线

- v0.2：订单过期关闭任务、操作审计。（已完成）
- v0.3：支付宝日账单自动下载、定时对账与差错通知。
- v0.4：正式身份系统、可观测性、备份恢复演练、第二支付通道。
