# 通知插件

TuneXPay 的管理员通知与业务 Webhook 是两套不同的契约：

- **业务 Webhook**：支付协议的一部分。业务系统依赖它完成充值/发货，使用 `WebhookDelivery`、业务签名、ACK 与 8 次重试。
- **通知插件**：给管理员和自动化系统看的旁路消息。发送失败不会改变支付事实，也不会阻塞业务 Webhook。

## 模型

```text
PaymentEvent / Collector failure
          |
NotificationSubscription
          |
NotificationInstance
          |
NotificationPlugin
  |-- SMTP
  |-- FEISHU_BOT
  |-- TELEGRAM
  |-- WEBHOOK
  '-- FEISHU_APP
```

一个插件可以创建多个实例。实例配置使用现有 `SECRETS_ENCRYPTION_KEY` 加密入库，管理 API 只返回非敏感字段和 `*Configured` 标记。

## 内置插件

| code | 用途 | 关键配置 |
|---|---|---|
| `SMTP` | 邮件 | 公网 SMTP、465/587、账号、授权码、收发件地址 |
| `FEISHU_BOT` | 飞书群机器人 | 官方 bot webhook，可选签名 secret |
| `TELEGRAM` | Telegram Bot | Bot Token、Chat ID、可选 Thread ID |
| `WEBHOOK` | 自动化通知 | HTTPS/安全 URL、可选 HMAC secret |
| `FEISHU_APP` | 飞书自建应用 | App ID/Secret、receive id type、receive id |

通知 Webhook 会发送 JSON：
```json
{"event":"ORDER_SUCCEEDED","title":"TuneXPay 收款成功","message":"...","data":{},"createdAt":"..."}
```
配置 secret 时增加 `x-tunexpay-signature: sha256=<hex>`。它复用业务 Webhook 的 SSRF 安全检查，但不会复用业务 Webhook 的密钥或 ACK 规则。

## 可订阅事件

- `ORDER_SUCCEEDED`
- `PAYMENT_LATE_DUPLICATE`
- `RECEIPT_MISMATCH`
- `BUSINESS_WEBHOOK_DEAD`
- `COLLECTOR_FAILURE`

每个实例拥有独立订阅集合。事件收集、seen marker 和投递任务在事务内提交；投递使用租约，失败最多 5 次并指数退避。不同实例彼此隔离。

## 旧配置迁移

首次读取新通知实例时，如果库中还没有任何 `NotificationInstance`，系统会读取旧的 `owner_notification_settings`：

- 原邮件配置迁移为 `legacy-email / SMTP`
- 原飞书机器人迁移为 `legacy-feishu / FEISHU_BOT`
- 原事件开关转换为实例订阅

旧表暂时保留用于兼容和回滚；新 Worker 只使用插件化实例发送后续通知。

## 管理 API

所有路径位于 `/admin/v1`，沿用管理鉴权、同源写保护和审计：

- `GET /notification-plugins`
- `GET/POST /notification-instances`
- `GET/POST /notification-instances/:id`
- `POST /notification-instances/:id/subscriptions`
- `POST /notification-instances/:id/test`
- `POST /notification-instances/:id/delete`
- `GET /notification-deliveries`
- `POST /notification-deliveries/:id/retry`
