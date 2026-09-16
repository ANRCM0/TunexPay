# 从 MPAY 提取的设计经验

`mpay.zip` 仅作为架构教材，TUOXIN Pay 没有复制它的 PHP/Webman 实现。

## 保留并简化

| MPAY 经验 | TUOXIN Pay v0.1 的处理 |
| --- | --- |
| 支付单与业务单分别建模 | `Order` 与 `Payment` 分离，一张 Order 可有多次 Payment |
| 终态支付仍可能收到成功结果 | `FAILED`、`CLOSED`、`UNKNOWN` 均允许可信成功；重复到账记业务事件 |
| 回调需要验签和去重 | `ChannelCallback(channel,eventKey)` 唯一约束；未处理完成的重复回调继续执行 |
| 通知失败必须重试 | `WebhookDelivery` 是 MySQL Outbox，Redis 只做任务调度 |
| Worker 崩溃需要恢复 | 条件认领、执行租约、过期恢复、指数退避、DEAD 手工重试 |
| 退款必须有独立生命周期 | `Refund` 独立单号、状态、幂等与累计可退金额校验 |
| 支付异常需要可追溯 | `PaymentEvent` 记录业务事实，不依赖普通文本日志还原 |
| 账单是最后一道资金核验 | 支付宝行先标准化为 `Receipt`，再由 Matcher 通过支付核心统一推进状态 |

## 第一版明确删除

- Merchant、Merchant Group 与多级商户后台。
- 账户余额、冻结、分录、清算、提现和平台服务费。
- 支付插件市场、商户自助配置与复杂支付路由。
- 多种银行及聚合支付插件、转账和进件。
- Watcher 授权体系及其专用部署链路。

这些能力不是“支付正确性”的必要条件，而是多商户平台的运营复杂度。TUOXIN Pay 先以 Application 服务自有业务，避免从第一天重新长成第二个 MPAY。
