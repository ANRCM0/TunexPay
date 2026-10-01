# TuneXPay Agent

Agent 是 MCP 工具层之上的可选运维助手，不属于支付主链路。

## 架构

```text
Telegram / Feishu
      |
   验签 + 白名单
      |
  AgentInbox (DB)
      |
     Worker
      |
 OpenAI-compatible LLM
      |
  MCP Tool Registry
 READ / OPERATE / FINANCIAL-request
      |
 人工审批（资金类）
      |
  TuneXPay services/state machines
```

Webhook 收到消息后只入队并立即返回；模型故障不会阻塞支付 API、业务 Webhook 或账单采集。

## 模型

在管理台 **系统 → Agent** 配置：

- Base URL：默认 `https://api.deepseek.com`
- Model：默认 `deepseek-chat`
- API Key：加密入库，不回显
- 最大工具权限：READ / OPERATE / FINANCIAL
- 最大工具步数：1–8
- 附加系统说明

需要 OpenAI-compatible Chat Completions，并支持 function/tool calling。工具定义来自与 MCP 完全相同的 registry；Agent 没有额外的“内部后门”。

## Telegram

在通知插件中创建/编辑 `TELEGRAM` 实例，并设置：

- Bot Token
- Chat ID
- Agent 对话入口 = 启用
- Agent Webhook Secret
- 允许的 Chat ID / User ID（可选）

保存后点击 **注册 Agent Webhook**。TuneXPay 调用 Telegram `setWebhook`，URL 为：

```text
https://<API_PUBLIC_URL>/agent/telegram/<notification-instance-id>
```

并使用 `secret_token`。入站请求必须携带匹配的 `X-Telegram-Bot-Api-Secret-Token`。如果未额外填写允许 Chat ID，则只允许该通知实例本身配置的 Chat ID。

## 飞书应用

在 `FEISHU_APP` 实例中启用 Agent，并配置：

- App ID / App Secret
- Verification Token
- 允许的 Chat ID / Open ID（建议显式填写）

点击 **复制 Agent 回调地址**，把地址配置到飞书开放平台的事件与回调，订阅 `im.message.receive_v1`。

当前实现支持未加密的事件回调（Verification Token 校验）与 URL verification challenge；如果在飞书控制台启用了 Encrypt Key，需要先关闭事件加密或后续增加加密体解密支持。

## 安全边界

- 入站通道必须先通过平台验证 + 白名单。
- 数据库字段、订单标题、Webhook 内容与工具输出全部被 Agent 系统提示标记为“不可信数据”，不能作为指令。
- Agent API Key 与通知密钥均加密入库且不通过管理 API 回显。
- Agent 默认 READ。
- FINANCIAL 只允许创建审批，不允许直接退款或关闭支付。
- Agent 对话失败最多重试 3 次，独立于支付 Worker 的业务任务。
