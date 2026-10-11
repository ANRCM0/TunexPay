// 界面验收脚本：在真实浏览器里驱动「创建通道」等弹窗，量出高度与滚动行为。
//
// 用法：
//   1. 启动假后端（按组件类型返回定长数据的空壳，不连库）：
//        node scripts/verify-forms.mjs --api &
//   2. 启动 dev server（admin.css 只在 admin 布局里加载，所以必须登录取到 cookie）：
//        cd apps/web && ADMIN_PASSWORD=... ADMIN_SESSION_SECRET=... npx next dev -p 3000
//   3. 跑脚本：
//        node scripts/verify-forms.mjs
//
// 不放进 package.json scripts：它依赖本地 dev server 和假后端，属于一次性排查工具。
// 弹窗布局的回归由 components/modal-form-layout.test.tsx 的源码不变量长期守护。

import { createServer } from "node:http";
import { chromium } from "playwright";

const BASE = process.env.FORM_BASE ?? "http://localhost:3000";
const API = process.env.FORM_API ?? "http://localhost:3001";
const CHROMIUM = process.env.CHROMIUM_PATH ?? "/usr/local/bin/chromium";
const PASSWORD = process.env.ADMIN_PASSWORD ?? "dev-admin-password-123456";

// ---------- 假后端 ----------
const FIELDS = [
  { key: "appId", label: "App ID", type: "text", required: true },
  { key: "gateway", label: "官方网关", type: "select", required: true, options: [
    { value: "https://openapi.alipay.com/gateway.do", label: "生产环境" },
    { value: "https://openapi-sandbox.dl.alipaydev.com/gateway.do", label: "沙箱环境" },
  ] },
  { key: "userId", label: "用户 ID", type: "text" },
  { key: "qrContent", label: "收款码内容", type: "text" },
  { key: "matchMode", label: "匹配模式", type: "select", options: [
    { value: "AMOUNT", label: "金额偏移（内置采集推荐）" }, { value: "REMARK", label: "付款备注（仅外部 Watcher）" },
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

const EMPTY_PATHS = ["/admin/v1/applications", "/admin/v1/routing-groups", "/admin/v1/system", "/admin/v1/dashboard", "/admin/v1/exceptions", "/admin/v1/notification-plugins", "/admin/v1/notification-instances", "/admin/v1/webhooks", "/admin/v1/refunds", "/admin/v1/audits", "/admin/v1/mcp/clients", "/admin/v1/mcp/approvals", "/admin/v1/reconciliation/receipts", "/admin/v1/channel-instances"];

function startApi() {
  return createServer((req, res) => {
    const url = new URL(req.url, API);
    const send = (payload, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (url.pathname === "/admin/v1/plugins") {
      return send({ data: [
        { code: "ALIPAY", name: "支付宝当面付", description: "支付宝当面付（扫码支付 / 主动查单 / 原路退款）", capabilities: ["扫码支付", "主动查单", "原路退款"], fields: FIELDS.filter(f => !["userId", "qrContent", "matchMode"].includes(f.key)) },
        { code: "ALIPAY_BILL", name: "支付宝账单收款", description: "支付宝账单收款（收款码 / 备注 / 金额匹配）", capabilities: ["收款码", "备注 / 金额匹配", "内置采集", "外部 Watcher"], fields: FIELDS },
        { code: "MOCK", name: "Mock 模拟支付", description: "Mock 模拟支付", capabilities: ["模拟付款", "模拟退款"], fields: [] },
      ] });
    }
    if (EMPTY_PATHS.includes(url.pathname)) return send({ data: [], meta: { page: 1, pageSize: 20, total: 0 } });
    send({ error: { code: "NOT_FOUND", message: `mock: ${url.pathname}` } }, 404);
  }).listen(Number(new URL(API).port), "127.0.0.1");
}

// ---------- 浏览器 ----------
async function login(browser) {
  const page = await browser.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.fill("#admin-password", PASSWORD);
  await Promise.all([
    page.waitForNavigation({ timeout: 60000 }).catch(() => {}),
    page.click('button[type="submit"]'),
  ]);
  await page.waitForTimeout(2000);
  return page;
}

/** 打开 URL，点开指定弹窗，测量尺寸/可滚性/最后一个可聚焦元素是否可达 */
async function measure(browser, w, h, path, openSelector) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.goto(`${BASE}${path}`, { waitUntil: "networkidle", timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(2200);
  if (openSelector) {
    await page.locator(openSelector).first().click({ timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2200);
  }
  const result = await page.evaluate(() => {
    const modal = document.querySelector(".arco-modal");
    if (!modal) return { error: "未打开弹窗" };
    const content = modal.querySelector(".arco-modal-content");
    const actions = modal.querySelector(".bill-settings-actions, .dialog-actions");
    const vh = window.innerHeight;
    const mr = modal.getBoundingClientRect();
    const ar = actions?.getBoundingClientRect();
    const focusables = [...modal.querySelectorAll("input,select,textarea,button")].filter(e => e.getBoundingClientRect().height > 0);
    const last = focusables.at(-1)?.getBoundingClientRect();
    return {
      弹窗: `${Math.round(mr.width)}x${Math.round(mr.height)}`,
      限高内: mr.bottom <= vh + 1,
      内容可滚: content ? content.scrollHeight > content.clientHeight + 1 : null,
      操作栏常驻: ar ? ar.top >= -1 && ar.bottom <= vh + 1 : null,
      末个控件可达: last ? last.bottom <= vh + 1 : null,
      控件数: modal.querySelectorAll("input,select,textarea,.arco-switch").length,
    };
  });
  await page.close();
  return result;
}

const CASES = [
  { label: "创建通道", path: "/plugins", open: 'button:has-text("创建通道")', sizes: [[1440, 900], [1440, 720], [1366, 640], [390, 844]] },
  { label: "创建轮询组", path: "/routing-groups", open: 'button:has-text("创建轮询组")', sizes: [[1440, 720], [1366, 640]] },
  { label: "新建应用", path: "/applications", open: 'button:has-text("新建应用")', sizes: [[1440, 720]] },
];

if (process.argv.includes("--api")) {
  startApi();
  console.log("mock API ready");
} else {
  const browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] });
  const authed = await login(browser);
  await authed.close();
  for (const testCase of CASES) {
    for (const [w, h] of testCase.sizes) {
      const r = await measure(browser, w, h, testCase.path, testCase.open);
      console.log(`${testCase.label} @ ${w}x${h}`.padEnd(26), JSON.stringify(r));
    }
  }
  await browser.close();
}
