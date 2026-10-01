# TuneXPay MCP（只读）

TuneXPay 提供一个可选的 MCP HTTP endpoint，让 DSH、ChatGPT、Claude 等 Agent 查询支付系统。第一阶段严格只读，不能退款、关单、改状态、改配置或读取任何密钥。

## 开启

默认关闭：

```env
MCP_ENABLED=false
MCP_TOKEN=
```

生产环境开启时：

```env
MCP_ENABLED=true
MCP_TOKEN=<至少 32 字符的独立随机 token>
```

**不要复用 `ADMIN_TOKEN`。** MCP Token 只授予 MCP 查询面，便于后续单独轮换和进一步做 scope。

Appliance 对外 endpoint：

```text
POST https://pay.example.com/mcp
Authorization: Bearer <MCP_TOKEN>
Content-Type: application/json
```

Gateway 会把 `/mcp` 直接路由到 Hono API。服务采用无 session 的 Streamable HTTP JSON-RPC 形态，支持 `initialize`、`notifications/initialized`、`ping`、`tools/list` 和 `tools/call`，当前协议版本为 `2026-07-28`，并兼容常见 2025 协议版本的 initialize 协商。

## 工具

| Tool | 能力 |
|---|---|
| `tunexpay_system_status` | API / MySQL / Redis / Worker / 队列状态 |
| `tunexpay_dashboard` | 当日看板汇总 |
| `tunexpay_list_applications` | 在用业务应用 |
| `tunexpay_list_orders` | 最近订单，可按状态过滤 |
| `tunexpay_get_order` | 单个订单完整支付/退款/事件/业务 Webhook 历史 |
| `tunexpay_list_payments` | 最近支付尝试 |
| `tunexpay_list_refunds` | 最近退款 |
| `tunexpay_list_exceptions` | 支付异常 |
| `tunexpay_list_channels` | 支付通道与检测状态，不返回凭据 |
| `tunexpay_list_notifications` | 管理员通知投递 |

## 安全边界

MCP 层不会暴露以下能力：

- `markPaymentSucceeded` 或任何直接资金状态写入；
- 创建退款、关闭支付、异常处置；
- API Key、Webhook Secret、支付通道密钥、通知插件 Secret；
- 任意 SQL / 任意 URL fetch。

后续如果增加操作型 MCP，应将 READ / OPERATE / FINANCIAL 分层，并让资金动作经过显式人工确认，而不是扩大当前 Token 的权限。


## 权限分层（Phase 4）

MCP 使用三个**互不相同**的 Bearer Token，凭证本身决定最大能力：

| Token | Scope | 能力 |
|---|---|---|
| `MCP_TOKEN` | READ | 查询 |
| `MCP_OPERATE_TOKEN` | OPERATE | READ + 重试通知/业务 Webhook、主动查单、通道检测、启停通知 |
| `MCP_FINANCIAL_TOKEN` | FINANCIAL | OPERATE + 创建资金/异常审批请求 |

FINANCIAL 不代表“直接动钱”。`tunexpay_request_refund`、`tunexpay_request_payment_close` 和 `tunexpay_request_exception_resolution` 只创建 15 分钟有效的审批单。管理员必须在 **系统 → Agent** 页面批准，服务才调用现有 `createRefund` / `closePayment` / 异常状态机执行。

这使 MCP/Agent 无法绕过支付核心的不变量，也避免模型提示注入直接触发资金动作。
