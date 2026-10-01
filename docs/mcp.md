# TuneXPay MCP / Agent Access

TuneXPay 是 **MCP Tool Server**，不是 Agent Runtime。

Codex、Hermes、OpenClaw、DSH 等外部 Agent 负责理解用户意图、规划和对话；TuneXPay 只负责暴露受控工具、验证权限、记录审计，并把资金动作送入人工审批。

```text
Codex / Hermes / OpenClaw / DSH
              |
      Streamable HTTP MCP
              |
        TuneXPay /mcp
              |
       McpClient Policy
     Scope + Tool Allowlist
              |
        MCP Tool Registry
              |
     TuneXPay Core Services
              |
 FINANCIAL → Human Approval
```

## Endpoint

```text
POST https://pay.example.com/mcp
Authorization: Bearer <TOKEN>
Content-Type: application/json
```

使用管理后台 **系统 → MCP / Agent Access** 为每个外部 Agent 单独创建 Token。

旧的环境变量 `MCP_TOKEN` 继续作为向后兼容的 READ-only 凭证。新客户端不应共用它。

## 客户端权限

每个 `McpClient` 都有：

- 独立 Token（只显示一次，数据库只保存 SHA-256）
- 名称，例如 Hermes / Codex / OpenClaw
- `READ / OPERATE / FINANCIAL` 最大 Scope
- 精确 Tool Allowlist
- 启用 / 停用
- 可选过期时间
- Last Used
- 独立调用审计

Scope 是权限上限，Tool Allowlist 是第二层限制。例如 Hermes 可以是 `OPERATE`，但只开放：

```text
tunexpay_system_status
tunexpay_get_order
tunexpay_list_exceptions
tunexpay_query_payment
tunexpay_retry_business_webhook
```

即使它具有 OPERATE Scope，也无法调用未加入 Allowlist 的其它 OPERATE 工具。

## Scope

### READ

查询：

- 系统状态 / Dashboard
- 应用
- 订单及完整订单详情
- 支付
- 退款
- 支付异常
- 支付通道
- 管理员通知
- MCP 人工审批状态

### OPERATE

包含 READ，并可按 Allowlist 开放：

- 主动查询支付状态
- 主动查询退款状态
- 检测支付通道
- 重试业务 Webhook
- 重试管理员通知
- 启停通知实例

这些动作仍调用 TuneXPay 原有 service / state machine，不提供任意 SQL 或任意内部函数调用。

### FINANCIAL

包含 OPERATE，但资金相关工具仍然 **不能直接执行**：

- `tunexpay_request_refund`
- `tunexpay_request_payment_close`
- `tunexpay_request_exception_resolution`

调用只会创建一个 15 分钟有效的 `McpActionApproval`。管理员必须到 **MCP / Agent Access** 页面确认后，TuneXPay 才通过现有退款、关闭支付或异常处理服务执行。

**退款不再有任何自动或商户直调的执行路径**：Native REST 的 `POST /refunds` 与 ePay V1 的 `act=refund` 都已停用（返回 410 / 明确错误信息）。能创建退款单的只剩两处人工入口——管理台「退款记录 → 人工发起退款」（`POST /admin/v1/refunds`，写 `REFUND_CREATE` 审计），以及本页的 MCP 审批。审批或人工发起后创建出来的退款单也不会被自动查单，状态由管理员在退款页人工查单推进。

## 审计

每一次 `tools/call` 都记录：

- MCP 客户端
- Scope
- Tool
- 截断并脱敏后的参数摘要
- 成功 / 失败
- 错误码
- 耗时
- Request ID
- 来源 IP / User-Agent
- 时间

不会记录 Bearer Token、密码、Secret、API Key 或私钥。

## Token 轮换与吊销

- **轮换 Token**：立即生成新 Token，旧 Token 立即失效。
- **停用客户端**：该客户端 Token 立即无法认证。
- Token 明文只在创建或轮换时返回一次。
- 建议 Codex、Hermes、OpenClaw 等各自使用独立客户端，不共享 Token。

## 外部 Agent 接入

TuneXPay 不关心 Agent 是通过 Telegram、飞书、CLI、Web 还是其它界面和你交互。

例如：

```text
Telegram → Hermes → TuneXPay MCP
CLI      → Codex  → TuneXPay MCP
Feishu   → OpenClaw → TuneXPay MCP
```

在外部 Agent 的 Streamable HTTP MCP 配置中填入：

- URL：管理台显示的 `/mcp` Endpoint
- Header：`Authorization: Bearer <该 Agent 的独立 Token>`

具体配置文件格式由 Codex / Hermes / OpenClaw 自身决定，TuneXPay 不在内部运行这些 Agent。

## 安全边界

- 没有模型 API Key、对话历史或 LLM runtime 存在 TuneXPay 中。
- 外部 Agent 无法直接访问数据库。
- Tool Scope 和 Allowlist 同时通过才可调用。
- FINANCIAL 工具只能申请人工审批。
- `markPaymentSucceeded` 等核心资金不变量不会暴露为 MCP Tool。
- 每个外部 Agent 可以单独轮换、停用和审计。
