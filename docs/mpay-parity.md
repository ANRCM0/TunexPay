# MPAY 业务规则迁移矩阵

TUOXIN Pay 不复制 MPAY 的 PHP/Webman 分层，但逐项迁移支付正确性规则。删除多商户运营复杂度时，不删除资金安全约束。

| MPAY 规则 | TUOXIN Pay 处理 |
| --- | --- |
| 支付单与业务单分离 | `Order` 与 `Payment` 分离，一张订单允许多次支付尝试 |
| 回调只进入统一生命周期服务 | 所有回调、查单、Watcher 和对账都进入 `markPaymentSucceeded()` |
| 终态后的可信成功不能丢弃 | `FAILED/CLOSED/UNKNOWN` 允许恢复成功 |
| 业务单已成功时登记晚到重复支付 | 创建可检索 `PaymentException`，阻止第二次业务通知；重复 Payment 全额 API 退款后自动解决，人工退款可手动解决 |
| 回调校验支付单号、金额和渠道引用 | 标准化后逐项精确校验，冲突时不推进状态 |
| Watcher 流水先去重、再加锁、成功后消费 | `Receipt.fingerprint` 唯一约束 + 数据库租约；MySQL 是事实源 |
| 优先渠道单号，其次备注，最后金额 | `ALIPAY_BILL` 按同样顺序匹配；多候选不猜测，转异常处理 |
| 金额/备注匹配受订单时间窗约束 | 只接受 `receiptValidFrom <= paidAt <= receiptValidUntil` 的流水 |
| 金额偏移只用于识别 | `Payment.amount` 始终是业务金额，`channelAmount/receivedAmount` 单独保存 |
| 恢复任务使用租约和退避 | MySQL 条件认领与过期租约；Redis 只加速 Webhook 调度 |

明确不迁移：Merchant、余额、冻结、服务费、清算、提现、插件市场、Watcher 授权平台和多级渠道路由。
