// 只用于本地界面验收的最小假后端：按组件里声明的类型返回定长数据，
// 不连数据库。目的只有一个 —— 让「创建通道」这类弹窗装满字段后，
// 能在真实浏览器里量出高度与滚动行为是否符合预期。
import { createServer } from "node:http";

const PORT = 3001;

function json(data, status = 200) {
  return { status, headers: { "content-type": "application/json" }, body: JSON.stringify(data) };
}

const FIELDS = [
  { key: "appId", label: "App ID", type: "text", required: true, placeholder: "支付宝开放平台 APPID" },
  { key: "gateway", label: "官方网关", type: "select", required: true, options: [
    { value: "https://openapi.alipay.com/gateway.do", label: "生产环境" },
    { value: "https://openapi-sandbox.dl.alipaydev.com/gateway.do", label: "沙箱环境" },
  ] },
  { key: "userId", label: "用户 ID", type: "text" },
  { key: "qrContent", label: "收款码内容", type: "text" },
  { key: "matchMode", label: "匹配模式", type: "select", options: [
    { value: "AMOUNT", label: "金额偏移（内置采集推荐）" },
    { value: "REMARK", label: "付款备注（仅外部 Watcher）" },
  ] },
  { key: "validSeconds", label: "识别有效期（秒）", type: "number" },
  { key: "amountOffsetMax", label: "最大金额偏移（分）", type: "number" },
  { key: "pollSeconds", label: "采集间隔（秒）", type: "number" },
  { key: "overlapSeconds", label: "重叠补拉（秒）", type: "number" },
  { key: "lagSeconds", label: "采集延迟（秒）", type: "number" },
  { key: "lookbackSeconds", label: "首次回看（秒）", type: "number" },
  { key: "privateKey", label: "应用 RSA2 私钥", type: "password", secret: true },
  { key: "publicKey", label: "支付宝 RSA2 公钥", type: "password", secret: true },
  { key: "watcherToken", label: "Watcher 令牌", type: "password", secret: true },
];

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const send = ({ status, headers, body }) => {
    res.writeHead(status, headers);
    res.end(body);
  };

  if (url.pathname === "/admin/v1/plugins") {
    return send(json({
      data: [
        { code: "ALIPAY", name: "支付宝当面付", description: "支付宝当面付（扫码支付 / 主动查单 / 原路退款）", capabilities: ["扫码支付", "主动查单", "原路退款"], fields: FIELDS.filter(f => !["userId", "qrContent", "matchMode"].includes(f.key)) },
        { code: "ALIPAY_BILL", name: "支付宝账单收款", description: "支付宝账单收款（收款码 / 备注 / 金额匹配）", capabilities: ["收款码", "备注 / 金额匹配", "内置采集", "外部 Watcher"], fields: FIELDS },
        { code: "MOCK", name: "Mock 模拟支付", description: "Mock 模拟支付（模拟付款 / 模拟退款）", capabilities: ["模拟付款", "模拟退款"], fields: [] },
      ],
    }));
  }

  if (url.pathname === "/admin/v1/channel-instances") {
    return send(json({ data: [] }));
  }

  // 列表页通用：空数据即可，弹窗才是验收目标
  for (const path of ["/admin/v1/applications", "/admin/v1/routing-groups", "/admin/v1/system", "/admin/v1/dashboard", "/admin/v1/exceptions", "/admin/v1/notification-plugins", "/admin/v1/notification-instances", "/admin/v1/webhooks", "/admin/v1/refunds", "/admin/v1/audits", "/admin/v1/mcp/clients", "/admin/v1/mcp/approvals", "/admin/v1/reconciliation/receipts"]) {
    if (url.pathname === path) return send(json({ data: [], meta: { page: 1, pageSize: 20, total: 0 } }));
  }

  // 收银台与公开接口
  if (url.pathname.startsWith("/api/v1/channels/public/")) {
    return send(json({ data: { paymentNo: "PAY1", status: "PENDING", channel: "ALIPAY", amount: 100, currency: "CNY", subject: "测试", payable: true, validUntil: null, clientPayload: null, returnUrl: null } }));
  }

  send(json({ error: { code: "NOT_FOUND", message: `mock: ${url.pathname}` } }, 404));
});

server.listen(PORT, "127.0.0.1", () => console.log(`mock API on http://127.0.0.1:${PORT}`));
