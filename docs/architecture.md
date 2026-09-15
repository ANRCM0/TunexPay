# TUOXIN Pay v0.1 架构说明

## 设计边界

系统只服务 TUOXIN 自有业务，因此第一版以 `Application` 代替完整商户体系。不包含余额、冻结、分账、清算、提现、商户费率与多级权限。

## 核心不变量

1. 金额一律保存为整数分，币种第一版固定 CNY。
2. `Order` 表示业务应收；`Payment` 表示一次通道支付尝试。二者不得合并。
3. 一张 Order 最多有一个胜出的 Payment；其他晚到成功记为 `PAYMENT_LATE_DUPLICATE`，不重复通知业务。
4. 所有成功来源（支付宝回调、主动查单、Mock、未来的账单匹配）最终只能调用 `markPaymentSucceeded()`。
5. Payment、Order、Event、WebhookDelivery 在同一个数据库事务内提交。
6. Redis 不保存支付事实。Worker 丢任务时，由数据库的 `PENDING + nextAttemptAt` 索引重新发现。
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

WebhookDelivery
PENDING → PROCESSING → SUCCESS
    ↑          │
    └──────────┘ lease expired / retry
               └→ DEAD (达到重试上限)
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
    COMMIT
  else:
    update Order = SUCCESS
    insert PAYMENT_SUCCEEDED
    insert ORDER_SUCCEEDED
    insert WebhookDelivery (Outbox)
    COMMIT
```

晚到重复支付第一版只做显式事件和阻断重复通知，不擅自自动退款。管理员应确认后创建退款，后续版本可增加异常处置单。

## Webhook 可靠性

- API 事务只写 MySQL Outbox，不把“成功入 Redis”当成可靠性前提。
- Worker 每 3 秒扫描到期记录并将 ID 投递到 BullMQ。
- 真正执行前使用条件更新认领任务，并设置 30 秒租约。
- Worker 崩溃后，`lockedUntil` 过期的任务重新回到 PENDING。
- 失败采用带抖动的指数退避，默认最多 8 次；超过后进入 DEAD，可从后台手动重试。
- 禁止自动跟随 30x，生产默认阻止 HTTP、localhost、私网及保留地址，降低 SSRF 风险。

## 密钥

- API Key 只保存 SHA-256 摘要。Key 本身有 192 bit 随机部分，不依赖用户口令强度。
- Webhook Secret 和 ePay Key 因为需要用于出站签名，使用 `SECRETS_ENCRYPTION_KEY` 做 AES-256-GCM 加密。
- 支付宝私钥通过环境变量注入，不进入数据库、日志或代码库。

## 后续路线

- v0.2：UNKNOWN 自动查单、退款查单、订单关闭任务、操作审计。
- v0.3：支付宝日账单下载、标准 Receipt、ReceiptMatcher 和差错告警。
- v0.4：正式身份系统、可观测性、备份恢复演练、第二支付通道。
