# TUOXIN Pay v0.1

TUOXIN Pay 是面向自有业务的轻量支付中台。它不是 MPAY 的改皮版本，而是一套重新建模的 TypeScript 项目：保留支付系统真正需要的事务、幂等、状态机、异常恢复和可靠通知，移除多商户运营、余额、清算、费率和复杂路由。

## v0.1 已实现

- Application：独立 API Key、Webhook Secret、ePay PID/Key；敏感密钥使用 AES-256-GCM 加密保存。
- Order / Payment 分离：一张业务订单支持多次支付尝试。
- 金额全程以整数“分”保存，不使用浮点数结算。
- 支付状态机：`CREATED → PROCESSING → SUCCESS / FAILED / UNKNOWN / CLOSED`，支持终态后的可信晚到成功。
- 支付宝官方 API：当面付预创建、主动查单、关闭、退款、RSA2 回调验签。
- Mock 通道：不接真实资金即可跑通本地闭环。
- ePay V1：`submit.php`、`mapi.php`、`api.php` 查询与退款，可供 NewAPI 等现有系统接入。
- 退款：独立退款单、外部退款单号幂等、累计金额上限校验、部分/全额退款状态。
- 可靠 Webhook：支付事务内写 Outbox；Worker 通过 Redis 调度，但以 MySQL 为事实来源，支持租约恢复、指数退避、手动重试。
- Event Timeline：订单、支付、退款、通知都写入可检索业务事件。
- Next.js 管理后台与收银台。
- Prisma/MySQL 迁移、Docker Compose、OpenResty 反向代理示例。

## 架构

```text
TUOXIN Matrix / Studio / Chat / NewAPI
                  │
       REST v1 或 ePay V1 Adapter
                  │
             Hono API
        ┌─────────┴─────────┐
        │ Payment Core      │
        │ Order / Payment   │
        │ Refund / Events   │
        │ State / Idempotency│
        └─────────┬─────────┘
                  │
         Alipay / Mock Adapter
                  │
      MySQL Outbox ── Redis ── Worker
                  │
             业务 Webhook
```

详细设计见 [docs/architecture.md](docs/architecture.md)，从 MPAY 提取/删除的内容见 [docs/mpay-reference-notes.md](docs/mpay-reference-notes.md)，接口定义见 [docs/openapi.yaml](docs/openapi.yaml)。

## 使用 Docker 启动

要求 Docker Compose v2。

```bash
cp .env.example .env
openssl rand -hex 32       # 写入 SECRETS_ENCRYPTION_KEY
openssl rand -base64 36    # 写入 ADMIN_TOKEN
openssl rand -base64 24    # 写入 MOCK_CHANNEL_TOKEN
docker compose up -d --build
```

生产环境同时修改 `MYSQL_PASSWORD` 与 `MYSQL_ROOT_PASSWORD`。如果仍保留示例占位密钥，API 会拒绝以 production 模式启动。

启动后：

- 管理后台：`http://localhost:3000`
- API 健康检查：`http://localhost:3001/health`
- MySQL 与 Redis 默认不暴露到公网。

首次可以在“应用”页面创建 `TUOXIN Matrix`。API Key、Webhook Secret、ePay Key 只显示一次，请立即保存。

## 本地 Mock 全链路

`.env` 中保持：

```dotenv
MOCK_CHANNEL_ENABLED=true
ALLOW_PRIVATE_WEBHOOKS=true
```

创建订单：

```bash
curl -X POST http://localhost:3001/api/v1/orders \
  -H 'Content-Type: application/json' \
  -H 'X-App-Id: app_xxx' \
  -H 'X-Api-Key: txp_app_xxx_xxx' \
  -H 'Idempotency-Key: recharge-10001' \
  -d '{"externalOrderNo":"recharge-10001","amount":1999,"currency":"CNY","subject":"余额充值"}'
```

使用返回的 `orderNo` 发起支付：

```bash
curl -X POST http://localhost:3001/api/v1/orders/ord_xxx/pay \
  -H 'Content-Type: application/json' \
  -H 'X-App-Id: app_xxx' \
  -H 'X-Api-Key: txp_app_xxx_xxx' \
  -H 'Idempotency-Key: payment-10001' \
  -d '{"channel":"MOCK","method":"alipay"}'
```

浏览器打开返回的 `cashierUrl`，点击“模拟支付成功”。后台应出现 `ORDER_SUCCEEDED`，配置了 Webhook 时还会生成投递任务。

## 支付宝配置

在 `.env` 填写：

```dotenv
ALIPAY_APP_ID=支付宝开放平台应用ID
ALIPAY_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
ALIPAY_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"
ALIPAY_GATEWAY=https://openapi.alipay.com/gateway.do
API_PUBLIC_URL=https://pay.example.com
WEB_PUBLIC_URL=https://pay.example.com
```

应用默认通道改为 `ALIPAY`。支付宝异步通知入口为：

```text
https://pay.example.com/api/v1/channels/alipay/webhook
```

先在支付宝沙箱完成预创建、扫码、异步回调、重复回调、主动查单和退款测试，再切生产网关及生产密钥。

## ePay / NewAPI 接入

在 NewAPI 的易支付配置中填写：

- 网关地址：`https://pay.example.com`
- 商户 ID：应用创建时返回的 `epayPid`
- 商户密钥：应用创建时返回的 `epayKey`
- 支付类型：`alipay`

TUOXIN Pay 将 ePay 的 `out_trade_no` 映射为 `externalOrderNo`，支付成功后按照 ePay MD5 规则向原 `notify_url` 发起通知，并要求接收端返回纯文本 `success`。

## 原生 Webhook 验签

原生 Webhook 使用以下请求头：

```text
X-Tuoxin-Event: payment.succeeded
X-Tuoxin-Delivery: <delivery-id>
X-Tuoxin-Timestamp: <unix-seconds>
X-Tuoxin-Signature: v1=<hex-hmac-sha256>
```

签名原文为：

```text
timestamp + "." + 原始请求体
```

接收端应使用应用的 `webhookSecret` 计算 HMAC-SHA256，进行常量时间比较，并拒绝时间戳相差超过 5 分钟的请求。

## 开发命令

```bash
npm install
npm run db:generate
npm run db:migrate
npm run dev:api
npm run dev:worker
npm run dev:web

npm test
npm run typecheck
npm run build
```

也可以使用命令行创建应用：

```bash
npm run app:create -- --name "TUOXIN Matrix" --webhook "https://example.com/pay/webhook" --channel ALIPAY
```

## 上线前必须完成

v0.1 已具备真实联调所需的主链，但尚不应直接承接无人值守的大额生产资金。正式上线前至少要完成：

1. 支付宝沙箱与小额生产回归，覆盖超时、重复回调、关闭后晚到成功和部分退款。
2. 增加自动支付查单任务，使 `UNKNOWN` 无需管理员手动查询。
3. 增加退款主动查询与日终账单对账。
4. 为管理端接入正式身份系统、限流、审计告警和备份策略。
5. 设置真实 HTTPS 域名，并保持 `ALLOW_PRIVATE_WEBHOOKS=false`、`MOCK_CHANNEL_ENABLED=false`。
6. 对 `SECRETS_ENCRYPTION_KEY` 做离线备份；丢失后已加密的 ePay/Webhook 密钥无法恢复。

这份边界是刻意保留的：v0.1 先把正确的支付核心跑通，不伪装成已经完成全部生产验证的成熟支付平台。
