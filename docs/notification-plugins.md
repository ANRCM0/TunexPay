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

每个实例拥有独立订阅集合。事件收集、seen marker 和投递任务在事务内提交；投递使用租约，失败最多 5 次并指数退避。不同实例彼此隔离。新建实例默认关闭，配置写入数据库并加密，独立于业务 Webhook。

## 配置细则与保存语义

- 敏感字段不回显，管理 API 只返回非敏感字段和 `*Configured` 标记（`SMTP.password`、`FEISHU_BOT.webhook/secret`、Telegram Bot Token、通知 Webhook secret、飞书应用 App Secret）。
- 留空视为保留原值，只有显式勾选清除（提交 `null`）才会删除。`SMTP` 的密码/授权码与 `FEISHU_BOT` 的 Webhook 是必需项：清空后保存会被配置校验拒绝，需要重新填写有效值。
- 保存必须携带当前 `revision`，冲突时返回 `NOTIFICATION_CONFIG_CONFLICT`，重新加载后再提交；实例创建后不能更换插件。

### SMTP

- 只允许 465（TLS）或 587（强制 STARTTLS）；证书必须有效，禁止明文 SMTP、自签名证书和内网地址。
- 主机解析结果先校验全部为公网地址，连接时固定到已验证的地址，TLS 仍使用原主机名做 SNI 与证书校验。
- 供应商可能要求单独开启 SMTP 并生成授权码，登录密码不一定可用，因此该字段填写的是“密码 / 授权码”。

### 飞书机器人

- 只接受 `https://open.feishu.cn/open-apis/bot/v2/hook/...` 形式的官方自定义机器人地址；其他域名，或带端口、凭据、查询参数、锚点的地址一律拒绝。
- 启用机器人签名校验时填写对应密钥，按官方 timestamp + secret 的 HMAC-SHA256 规则签名。
- 机器人关键词安全策略可设置为 `TuneXPay`，所有通知标题都包含该文本；若启用了来源 IP 白名单，须包含服务器实际出口 IP。
- 这是群机器人通知，不是给个人账号发私聊消息；需要投递给指定用户时使用飞书自建应用插件。

飞书配置参考：[官方自定义机器人指南](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot)。

## 测试与投递状态

- 测试前必须先保存并启用实例，否则返回 `NOTIFICATION_DISABLED`。测试按钮只创建一条投递任务，不代表已经发送成功；每个实例每分钟最多测试一次（`TEST_RATE_LIMIT`）。
- 投递状态：`PENDING` 待发送、`PROCESSING` 发送中（带 120 秒租约）、`SUCCESS` 插件返回成功、`DEAD` 重试耗尽、`CANCELLED` 实例已停用或归档。
- `SUCCESS` 只表示 SMTP 服务接受邮件或飞书接口返回成功，不保证邮箱最终投递或对方已读。
- 失败退避上限 1 小时，耗尽后进入 `DEAD`；错误记录只保存通用错误码（如 `SEND_FAILED_CHECK_PLUGIN_CONFIG`），避免 SDK 异常泄露 Webhook 或 SMTP 凭证。
- 支持手动重发：`POST /notification-deliveries/:id/retry` 把记录重置为 `PENDING`；旧版未绑定实例的投递记录不能重试（`NOTIFICATION_LEGACY_DELIVERY`）。
- 管理台显示最近 50 条投递记录。

## 提醒范围与限频

- 业务订单收款成功：应用、订单号、支付单、金额、时间。
- 晚到重复支付、流水差错：只提示登录后台核对，不发送原始流水、付款人、备注或密钥。
- 业务 Webhook 重试耗尽：提醒业务系统可能尚未完成充值，不对每一次暂时失败刷屏。
- 账单采集连续失败至少 3 次：每个通道每 15 分钟最多生成一次提醒。
- Mock 收款不生成管理员提醒。

尚未包含：未匹配但非差错的流水、每日摘要、恢复提醒，以及账号绑定冲突与 Worker 整体离线的外部监控。Worker 停止时无法依赖自身发送告警，需要额外监控。

## 可靠性与边界

- Worker 从业务事务已提交的事件生成通知，seen 标记与投递任务在同一事务提交，不改变支付结果。
- 按 seen 标记逐条处理而不是按自增 ID 游标跳过，避免事务提交次序造成漏事件；首个实例创建之前的历史事件不补发。事件生成失败时，下一轮重扫未处理事件。
- 每个实例有独立任务、去重键、租约与状态。停用实例后，其未发送任务在投递时被置为 `CANCELLED`；归档实例同时清理未发送队列。事件订阅只影响后续生成，不取消已生成的任务。
- 保存后尚未投递的任务使用最新配置。
- 发送与状态提交不能原子化：网络超时或进程崩溃恢复后仍可能出现重复提醒。管理员通知只供参考，不作为业务入账凭证。
- 面板写入需要正确的同源来源：`WEB_PUBLIC_URL` 必须设置为实际对外 HTTPS Origin，否则配置与测试请求会被拒绝。

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
