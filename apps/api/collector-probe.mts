import { readFileSync } from "node:fs";
import { AlipayChannel } from "./src/channels/alipay.js";
import { accountLogPage, alipayTime, paymentFlowFromAccountLog } from "./src/lib/alipay-account-log.js";

function loadLocalConfig() {
  const lines = readFileSync(new URL("../../alipay.txt", import.meta.url), "utf8").split(/\r?\n/).map(line => line.trim());
  const pick = (label: string) => {
    const index = lines.indexOf(label);
    if (index < 0 || !lines[index + 1]) throw new Error(`alipay.txt 缺少 ${label}`);
    return lines[index + 1]!;
  };
  const wrap = (body: string, type: string) => `-----BEGIN ${type}-----\n${body.match(/.{1,64}/g)!.join("\n")}\n-----END ${type}-----`;
  return {
    appId: pick("支付宝应用 AppID"),
    privateKey: wrap(pick("应用私钥"), "PRIVATE KEY"),
    publicKey: wrap(pick("支付宝公钥"), "PUBLIC KEY"),
    userId: pick("支付宝用户ID"),
  };
}

const local = loadLocalConfig();
const channel = new AlipayChannel({
  ALIPAY_APP_ID: local.appId,
  ALIPAY_PRIVATE_KEY: local.privateKey,
  ALIPAY_PUBLIC_KEY: local.publicKey,
  ALIPAY_GATEWAY: process.env.ALIPAY_GATEWAY ?? "https://openapi.alipay.com/gateway.do",
  ALIPAY_SIGN_TYPE: "RSA2",
});

const hours = Number(process.env.PROBE_HOURS ?? 6);
const now = new Date();
console.log(`网关: ${process.env.ALIPAY_GATEWAY ?? "https://openapi.alipay.com/gateway.do"}`);
console.log(`查询范围: 最近 ${hours} 小时（30 分钟窗口）, bill_user_id=${local.userId}\n`);

let totalFlows = 0;
for (let cursor = now.getTime() - hours * 3_600_000; cursor < now.getTime(); cursor += 1_800_000) {
  const start = new Date(cursor);
  const end = new Date(Math.min(cursor + 1_800_000, now.getTime()));
  const label = `${alipayTime(start)} ~ ${alipayTime(end)}`;
  try {
    const response = await channel.queryAccountLogs({
      bill_user_id: local.userId,
      start_time: alipayTime(start),
      end_time: alipayTime(end),
      page_no: 1,
      page_size: 100,
    });
    console.log(`[${label}] 响应字段: ${Object.keys(response).join(", ")}`);
    if (cursor === now.getTime() - hours * 3_600_000) console.log("首个窗口完整响应:", JSON.stringify(response, null, 2).slice(0, 3000));
    if (Array.isArray(response.detail_list) && response.detail_list.length) {
      console.log("首条 detail_list 记录:", JSON.stringify(response.detail_list[0], null, 2).slice(0, 2000));
    }
    const page = accountLogPage(response, 1, 100);
    console.log(`[${label}] total_size=${response.total_size} 本页 ${page.records.length} 条`);
    for (const record of page.records) {
      const raw = record as Record<string, unknown>;
      const flow = paymentFlowFromAccountLog(record);
      console.log(`  完整记录: ${JSON.stringify(raw)}`);
      if (flow) {
        totalFlows += 1;
        console.log(`    → 可采集: tradeNo=${flow.providerTradeNo} amount=${flow.amount}分 paidAt=${flow.paidAt} remark=${JSON.stringify(flow.remark)}`);
      } else {
        console.log(`    → 跳过（支出/退款/无交易号）`);
      }
    }
  } catch (error) {
    const info = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
    console.log(`[${label}] 查询失败 ${code} ${info}`);
    if (/signature|验签|app.?id|permission|权限/i.test(info + code)) {
      console.log("\n鉴权/权限类错误，提前终止。若是沙箱应用请用 ALIPAY_GATEWAY=https://openapi-sandbox.dl.alipaydev.com/gateway.do 重试。");
      process.exit(1);
    }
  }
}
console.log(`\n完成，共解析出 ${totalFlows} 条可采集收入流水。`);
