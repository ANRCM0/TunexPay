# 接入与联调

业务侧接入 TuneXPay 需要知道的东西：应用凭证、创建订单与发起支付、支付宝配置、ePay / NewAPI 对接、原生 Webhook 验签，以及不接真实资金的本地 Mock 全链路。

- 接口定义见 [openapi.yaml](openapi.yaml)。
- 通道、插件实例与轮询组的面板配置见 [plugin-channels.md](plugin-channels.md) 与 [routing-groups.md](routing-groups.md)。
- 资金正确性与状态机的设计依据见 [architecture.md](architecture.md)。

## 1. 应用与凭证

在管理台「应用」页面创建应用，也可以走命令行：

```bash
npm run app:create -- --name "TUOXIN Matrix" --webhook "https://example.com/pay/webhook" --channel ALIPAY
```

- API Key、Webhook Secret、ePay PID/Key 只在创建或重置时显示一次，请立即保存。
- 重置凭证会同时换掉 API Key、Webhook Secret 与 ePay Key（`epayPid` 作为商户标识不变），旧凭证立即失效。
- 删除应用按业务数据量分两条路径：从未产生订单/退款/通知投递的直接删行；已经承载过资金数据的走**归档删除** —— 凭证立即失效、不再出现在各页面，但已成功的支付与已发起的退款记录保留在库中（通道侧的钱已经动了），DBA 可按 `orders.deletedWithApplicationId` 还原。

凭证生命周期与归档语义的完整说明见 [plugin-channels.md](plugin-channels.md)。

## 2. 创建订单与发起支付

金额一律是整数「分」。同一个 `Idempotency-Key` 的重复请求返回同一结果。

```bash
curl -X POST http://localhost:3000/api/v1/orders \
  -H 'Content-Type: application/json' \
  -H 'X-App-Id: app_xxx' \
  -H 'X-Api-Key: txp_app_xxx_xxx' \
  -H 'Idempotency-Key: recharge-10001' \
  -d '{"externalOrderNo":"recharge-10001","amount":1999,"currency":"CNY","subject":"余额充值"}'
```

用返回的 `orderNo` 发起支付：

```bash
curl -X POST http://localhost:3000/api/v1/orders/ord_xxx/pay \
  -H 'Content-Type: application/json' \
  -H 'X-App-Id: app_xxx' \
  -H 'X-Api-Key: txp_app_xxx_xxx' \
  -H 'Idempotency-Key: payment-10001' \
  -d '{"channel":"MOCK","method":"alipay"}'
```

响应里的 `cashierUrl` 是收银台地址。**退款没有 API 直调入口**：只能由管理员在管理台「退款记录 → 人工发起退款」发起，或经 MCP 审批，之后同样由人工查单推进状态。

## 3. 本地 Mock 全链路

不接真实资金即可跑通「下单 → 支付 → 事件 → Webhook」。仅在隔离的本地环境中，在 `.env` 显式开启：

```dotenv
MOCK_CHANNEL_ENABLED=true
ALLOW_PRIVATE_WEBHOOKS=true
```

按上一节创建订单并把 `channel` 设为 `MOCK` 发起支付，浏览器打开 `cashierUrl`，点击「模拟支付成功」。后台应出现 `ORDER_SUCCEEDED`；配置了 Webhook 的应用还会生成投递任务。

Mock 收银台允许付款人自行点击模拟成功，**不能用于真实收款或真实业务入账**，生产环境必须保持这两个开关为 `false`。

## 4. 支付宝接入

`.env` 填写（或在管理台「支付通道」页面按通道配置）：

```dotenv
ALIPAY_APP_ID=支付宝开放平台应用ID
ALIPAY_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
ALIPAY_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"
ALIPAY_GATEWAY=https://openapi.alipay.com/gateway.do
API_PUBLIC_URL=https://pay.example.com
WEB_PUBLIC_URL=https://pay.example.com
```

应用默认通道改为 `ALIPAY`。支付宝异步通知入口：

```text
https://pay.example.com/api/v1/channels/alipay/webhook
```

先在沙箱完成预创建、扫码、异步回调、重复回调、主动查单与退款测试，再切生产网关与生产密钥。支付宝私钥只通过环境变量注入，不进入数据库、日志或代码库。

个人收款码承接（`ALIPAY_BILL` 通道）是另一条链路，配置与验收见 [alipay-bill-collector.md](alipay-bill-collector.md)。

## 5. ePay V1 / NewAPI 接入

在 NewAPI 的易支付配置中填写：

- 网关地址：`https://pay.example.com`
- 商户 ID：应用创建时返回的 `epayPid`
- 商户密钥：应用创建时返回的 `epayKey`
- 支付类型：`alipay`

TuneXPay 把 ePay 的 `out_trade_no` 映射为 `externalOrderNo`，支付成功后按 ePay MD5 规则向原 `notify_url` 发起通知，并要求接收端返回纯文本 `success`。

入口为 `submit.php`、`mapi.php` 与 `api.php` 查询；`act=refund` 已停用。

## 6. 原生 Webhook 验签

请求头：

```text
X-Tuoxin-Event: payment.succeeded
X-Tuoxin-Delivery: <delivery-id>
X-Tuoxin-Timestamp: <unix-seconds>
X-Tuoxin-Signature: v1=<hex-hmac-sha256>
```

签名原文：

```text
timestamp + "." + 原始请求体
```

接收端应使用应用的 `webhookSecret` 计算 HMAC-SHA256，进行常量时间比较，并拒绝时间戳相差超过 5 分钟的请求。投递是「至少一次」，同一 `X-Tuoxin-Delivery` 会重试，接收端必须按它去重。

## 7. 账单收款 Watcher 调用

外部 Watcher 查到个人收款码到账流水后投递：

```bash
curl -X POST https://pay.example.com/api/v1/channels/alipay-bill/flows \
  -H 'Content-Type: application/json' \
  -H 'X-Watcher-Token: your-watcher-token' \
  -d '{"record":{"order_no":"支付宝流水号","price":"19.99","paid_at":"2026-09-16 12:00:00","remark":"TXA1B2C3D4E5"}}'
```

原生格式也可使用 `providerTradeNo`、整数分 `amount`、`paidAt`、`remark`，并通过 `{records:[...]}` 一次提交最多 100 条。Watcher 必须重试网络失败，并对响应中仍为 `PROCESSING` 的流水再次投递；终态为 `MATCHED`、`MISMATCH` 或 `IGNORED`。同一支付宝流水号重复提交是幂等的；即使 API 在处理中崩溃，Worker 也会在数据库租约到期后自动恢复。

匹配严格按交易号、备注码、有效期内金额进行：备注或金额只负责定位候选，系统仍会校验精确实收金额和支付时间窗；出现多候选时不会猜单，而是进入「支付异常」后台。注意官方账务明细接口不下发付款备注，内置采集器只能用 `AMOUNT` 金额匹配，`REMARK` 仅对能抓到备注的外部 Watcher 有效。
