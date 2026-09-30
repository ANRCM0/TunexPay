/**
 * 性能/正确性改动的并发验收脚本。
 *
 * 用法（在 apps/api 目录下，必须显式确认写库）：
 *   npx tsx src/scripts/verify-concurrency.ts --yes [--rounds 20] [--force] [--help]
 *
 * 覆盖 4 个场景：
 *   S1 并发创建同一订单（同业务单号 + 同幂等键）—— 验证 createOrder 去掉 Serializable 后仍只有一行。
 *   S2 同订单两笔支付并发成功（默认 20 轮）—— 验证 markPaymentSucceeded 保留 Serializable 后
 *      「恰好一个胜出者 + 恰好一条晚到重复」这个资金不变量从未被破坏。
 *   S3 并发保存同一通道配置（同 revision）—— 验证 saveChannel 保留 Serializable 后仍然只允许一个写入。
 *   S4 并发退款超过累计上限（需要 MOCK_CHANNEL_ENABLED=true）—— 验证退款上限判断不失真。
 *
 * 安全护栏：
 *   - 必须带 --yes；NODE_ENV=production 时还必须额外带 --force。
 *   - 所有测试数据挂在 appId 前缀 `perf-verify-` 下，脚本结束时会按外键顺序硬删除自己创建的数据。
 *   - 脚本会打印目标数据库（隐藏口令），请确认不是生产库。
 */
import { config } from "../config.js";
import { db } from "../db.js";
import { generateId, randomSecret, seal, sha256 } from "../lib/crypto.js";
import { createOrder } from "../services/order-service.js";
import { createPayment, markPaymentSucceeded, mockSucceed } from "../services/payment-service.js";
import { createRefund } from "../services/refund-service.js";
import { loadChannel, saveChannel } from "../services/channel-instance-service.js";
import type { Application } from "@prisma/client";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("Usage: npx tsx src/scripts/verify-concurrency.ts --yes [--rounds 20] [--force]");
  console.log("会写入并清理以 perf-verify- 命名的测试数据；无需 MySQL 之外的依赖。");
  process.exit(0);
}
if (!args.includes("--yes")) {
  console.error("本脚本会写入测试数据，必须显式加 --yes 确认。生产库还需额外加 --force。");
  process.exit(1);
}
if (config().NODE_ENV === "production" && !args.includes("--force")) {
  console.error("NODE_ENV=production：本脚本会创建订单/支付/退款测试数据。确认目标库后加 --force 再跑。");
  process.exit(1);
}
const requestedRounds = Number(args[args.indexOf("--rounds") + 1]);
const rounds = Number.isFinite(requestedRounds) && requestedRounds > 0 ? Math.min(requestedRounds, 200) : 20;
if (!process.env.DATABASE_URL) {
  console.error("未设置 DATABASE_URL。请在部署机上加载 .env（set -a; . ./.env; set +a），或容器内执行：docker compose exec app npx tsx apps/api/src/scripts/verify-concurrency.ts --yes");
  process.exit(1);
}

const prefix = `perf-verify-${Date.now().toString(36)}`;
let application: Application | null = null;
let channelId: string | null = null;
let failures = 0;
let skips = 0;

const deadlockPattern = /1213|Deadlock|1205|Lock wait timeout/i;
const lockIssues: string[] = [];

function report(status: "PASS" | "FAIL" | "SKIP", title: string, detail = ""): void {
  if (status === "FAIL") failures += 1;
  if (status === "SKIP") skips += 1;
  console.log(`[${status}] ${title}${detail ? `\n        ${detail}` : ""}`);
}

function describe(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  if (deadlockPattern.test(text)) lockIssues.push(text.slice(0, 200));
  return text.slice(0, 300);
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (value && typeof value === "object" && typeof (value as { toNumber?: unknown }).toNumber === "function") {
    return (value as { toNumber(): number }).toNumber();
  }
  return Number(value ?? 0) || 0;
}

async function ensureApplication(): Promise<Application> {
  return db.application.create({ data: {
    appId: `${prefix}-app`,
    name: "性能验收应用（可删除）",
    apiKeyHash: sha256(randomSecret()),
    webhookSecretEncrypted: seal("perf-verify-webhook-secret"),
    epayPid: prefix.slice(0, 32),
    epayKeyEncrypted: seal("perf-verify-epay-key"),
    defaultChannel: "MOCK",
  } });
}

/** 并发创建同一订单：唯一索引 + P2002 分支必须收敛成一行。 */
async function scenarioOrderIdempotency(app: Application): Promise<void> {
  const input = { externalOrderNo: `${prefix}-order`, amount: 1234, currency: "CNY" as const, subject: "并发下单验收", expiresInSeconds: 1_800 };
  const settled = await Promise.allSettled(Array.from({ length: 8 }, () => createOrder(app, input, `${prefix}-idem`)));
  const rejected = settled.filter((item): item is PromiseRejectedResult => item.status === "rejected");
  const orderNos = new Set(settled.filter(item => item.status === "fulfilled").map(item => item.value.order.orderNo));
  const rows = await db.order.count({ where: { applicationId: app.id, externalOrderNo: input.externalOrderNo } });

  if (rejected.length) {
    return report("FAIL", "S1 并发创建同一订单", `${rejected.length}/8 个请求失败：${rejected.map(item => describe(item.reason)).join(" | ")}`);
  }
  if (rows !== 1) return report("FAIL", "S1 并发创建同一订单", `数据库里有 ${rows} 行相同业务单号，期望恰好 1 行`);
  if (orderNos.size !== 1) return report("FAIL", "S1 并发创建同一订单", `8 个请求返回了 ${orderNos.size} 个不同订单号，幂等收敛失败`);
  report("PASS", "S1 并发创建同一订单", "8 路并发全部返回同一订单号，库里恰好 1 行");
}

/**
 * 同订单两笔支付并发成功：资金不变量是「恰好一个胜出者 + 恰好一条晚到重复 + 恰好一条异常」。
 * 这是隔离级别决策的直接回归：如果把 markPaymentSucceeded 的 Serializable 降级，重读订单状态
 * 可能命中旧快照，两笔都会被当成首次成功（ORDER_SUCCEEDED = 2）。
 */
async function scenarioLateDuplicate(app: Application): Promise<void> {
  const violations: string[] = [];
  for (let round = 0; round < rounds; round += 1) {
    const order = await db.order.create({ data: {
      orderNo: generateId("ord"),
      externalOrderNo: `${prefix}-late-${round}`,
      applicationId: app.id,
      amount: 1_000,
      currency: "CNY",
      subject: "并发晚到重复验收",
      status: "PENDING",
      requestHash: sha256(`${prefix}-late-${round}`),
      expiresAt: new Date(Date.now() + 600_000),
    } });
    const payments = await Promise.all([1, 2].map(attemptNo => db.payment.create({ data: {
      paymentNo: generateId("pay"),
      orderId: order.id,
      attemptNo,
      channel: "MOCK",
      method: "alipay",
      status: "PROCESSING",
      amount: 1_000,
      channelAmount: 1_000,
    } })));

    const settled = await Promise.allSettled(payments.map((payment, index) => markPaymentSucceeded({
      eventKey: `${prefix}:${payment.paymentNo}`,
      paymentNo: payment.paymentNo,
      status: "SUCCESS",
      amount: 1_000,
      channelTradeNo: `${prefix}-trade-${round}-${index + 1}`,
      paidAt: new Date(),
      raw: { verify: true },
    }, "VERIFY")));

    const failed = settled.filter((item): item is PromiseRejectedResult => item.status === "rejected");
    if (failed.length) { violations.push(`第 ${round} 轮有 ${failed.length} 笔成功事务报错：${describe(failed[0]!.reason)}`); continue; }

    const [succeeded, lateDuplicate, exceptions, current, successPayments] = await Promise.all([
      db.paymentEvent.count({ where: { orderId: order.id, type: "ORDER_SUCCEEDED" } }),
      db.paymentEvent.count({ where: { orderId: order.id, type: "PAYMENT_LATE_DUPLICATE" } }),
      db.paymentException.count({ where: { orderId: order.id, type: "LATE_DUPLICATE" } }),
      db.order.findUniqueOrThrow({ where: { id: order.id }, select: { status: true, winningPaymentId: true } }),
      db.payment.count({ where: { orderId: order.id, status: "SUCCESS" } }),
    ]);
    if (succeeded !== 1) violations.push(`第 ${round} 轮 ORDER_SUCCEEDED=${succeeded}，期望 1（出现两次首次成功就是重复入账）`);
    else if (lateDuplicate !== 1) violations.push(`第 ${round} 轮 PAYMENT_LATE_DUPLICATE=${lateDuplicate}，期望 1`);
    else if (exceptions !== 1) violations.push(`第 ${round} 轮 LATE_DUPLICATE 异常单=${exceptions}，期望 1`);
    else if (current.status !== "SUCCESS") violations.push(`第 ${round} 轮订单状态=${current.status}，期望 SUCCESS`);
    else if (!current.winningPaymentId || successPayments !== 2) violations.push(`第 ${round} 轮胜出者=${current.winningPaymentId ?? "NULL"}，成功支付单=${successPayments}，期望 2 笔成功、1 个胜出者`);
  }

  if (violations.length) report("FAIL", `S2 并发晚到重复（${rounds} 轮）`, violations.slice(0, 5).join(" | "));
  else report("PASS", `S2 并发晚到重复（${rounds} 轮）`, `每轮都是 1 个胜出者 + 1 条晚到重复事件 + 1 条异常单`);
}

/** 并发保存同一通道配置：revision 校验必须只放行一个。 */
async function scenarioChannelRevision(): Promise<void> {
  const created = await saveChannel({ name: `${prefix}-channel`, plugin: "MOCK", enabled: false, settings: {} });
  channelId = String(created.id);
  const revision = created.revision;
  const settled = await Promise.allSettled([
    saveChannel({ name: `${prefix}-channel-a`, plugin: "MOCK", enabled: false, revision, settings: {} }, channelId),
    saveChannel({ name: `${prefix}-channel-b`, plugin: "MOCK", enabled: false, revision, settings: {} }, channelId),
  ]);
  const fulfilled = settled.filter(item => item.status === "fulfilled").length;
  const rejected = settled.filter((item): item is PromiseRejectedResult => item.status === "rejected");
  if (fulfilled !== 1) {
    return report("FAIL", "S3 并发保存通道配置", `同 revision 的两次保存有 ${fulfilled} 次成功，期望恰好 1 次（并发覆盖配置）`);
  }
  if (!rejected.length || !/CHANNEL_CONFIG_CONFLICT|CHANNEL_CHECK_RUNNING/.test(describe(rejected[0]!.reason))) {
    return report("FAIL", "S3 并发保存通道配置", `被拒的那次报错不是版本冲突：${rejected.map(item => describe(item.reason)).join(" | ")}`);
  }
  const latest = await loadChannel(channelId);
  report("PASS", "S3 并发保存通道配置", `一次成功一次冲突，revision 递增到 ${latest.revision}`);
}

/** 并发退款超过累计上限：上限判断不能失真（需要 MOCK 通道启用）。 */
async function scenarioRefundCap(app: Application): Promise<void> {
  if (!config().MOCK_CHANNEL_ENABLED) {
    return report("SKIP", "S4 并发退款上限", "MOCK_CHANNEL_ENABLED=false，跳过（设置 MOCK_CHANNEL_ENABLED=true 后可跑）");
  }
  const created = await createOrder(app, { externalOrderNo: `${prefix}-refund`, amount: 10_000, currency: "CNY", subject: "并发退款验收", expiresInSeconds: 1_800 }, `${prefix}-refund-idem`);
  const payment = await createPayment(app, created.order.orderNo, { channel: "MOCK", method: "alipay" }, `${prefix}-refund-pay`);
  await mockSucceed(payment.paymentNo);

  const settled = await Promise.allSettled([
    createRefund(app, { paymentNo: payment.paymentNo, externalRefundNo: `${prefix}-r1`, amount: 6_000 }),
    createRefund(app, { paymentNo: payment.paymentNo, externalRefundNo: `${prefix}-r2`, amount: 6_000 }),
  ]);
  const fulfilled = settled.filter(item => item.status === "fulfilled").length;
  const rejected = settled.filter((item): item is PromiseRejectedResult => item.status === "rejected");
  const reserved = toNumber((await db.refund.aggregate({ where: { paymentId: (await db.payment.findUniqueOrThrow({ where: { paymentNo: payment.paymentNo }, select: { id: true } })).id, status: { in: ["CREATED", "PROCESSING", "UNKNOWN", "SUCCESS"] } }, _sum: { amount: true } }))._sum.amount);

  if (fulfilled > 1) return report("FAIL", "S4 并发退款上限", `两笔各 60% 的退款都成功了（累计 ${reserved} 分 > 10000 分），上限判断失真`);
  if (reserved > 10_000) return report("FAIL", "S4 并发退款上限", `累计退款 ${reserved} 分超过支付金额 10000 分`);
  if (!rejected.length || !/REFUND_AMOUNT_EXCEEDED/.test(describe(rejected[0]!.reason))) {
    return report("FAIL", "S4 并发退款上限", `被拒的那笔报错不是超额：${rejected.map(item => describe(item.reason)).join(" | ")}`);
  }
  report("PASS", "S4 并发退款上限", `一笔成功一笔超额，累计 ${reserved} 分 ≤ 10000 分`);
}

/** 按外键顺序硬删本脚本创建的数据。 */
async function cleanup(): Promise<void> {
  if (!application) return;
  const orderIds = (await db.order.findMany({ where: { applicationId: application.id }, select: { id: true } })).map(row => row.id);
  const paymentIds = (await db.payment.findMany({ where: { orderId: { in: orderIds } }, select: { id: true } })).map(row => row.id);
  await db.paymentException.deleteMany({ where: { OR: [{ orderId: { in: orderIds } }, { paymentId: { in: paymentIds } }] } });
  await db.paymentEvent.deleteMany({ where: { OR: [{ orderId: { in: orderIds } }, { paymentId: { in: paymentIds } }] } });
  await db.webhookDelivery.deleteMany({ where: { orderId: { in: orderIds } } });
  await db.receiptMatchReservation.deleteMany({ where: { paymentId: { in: paymentIds } } });
  await db.receipt.deleteMany({ where: { paymentId: { in: paymentIds } } });
  await db.refund.deleteMany({ where: { applicationId: application.id } });
  await db.payment.deleteMany({ where: { orderId: { in: orderIds } } });
  await db.order.deleteMany({ where: { applicationId: application.id } });
  await db.application.delete({ where: { id: application.id } });
  if (channelId) await db.channelInstance.deleteMany({ where: { id: channelId } });
  console.log(`已清理测试数据：应用 ${application.appId}${channelId ? `、通道 ${channelId}` : ""}`);
}

try {
  const connection = new URL(process.env.DATABASE_URL ?? "mysql://unknown");
  console.log(`目标数据库：${connection.host}${connection.pathname}`);
  console.log(`测试数据前缀：${prefix}（脚本结束时会删除）`);
  if (config().NODE_ENV === "production") console.log("注意：NODE_ENV=production 且已加 --force，正在对生产库写入测试数据。\n");
  else console.log("");

  application = await ensureApplication();
  await scenarioOrderIdempotency(application);
  await scenarioLateDuplicate(application);
  await scenarioChannelRevision();
  await scenarioRefundCap(application);

  console.log(`\n结果：失败 ${failures} 项，跳过 ${skips} 项。`);
  if (lockIssues.length) {
    console.log(`检测到 ${lockIssues.length} 次死锁/锁等待超时，请连同上下文一起评估并发上限：`);
    for (const item of lockIssues.slice(0, 5)) console.log(`  - ${item}`);
  } else {
    console.log("本次运行没有出现死锁（1213）或锁等待超时（1205）。");
  }
  if (failures) process.exitCode = 1;
} catch (error) {
  console.error("验收无法完成：", error instanceof Error ? error.stack : error);
  process.exitCode = 1;
} finally {
  try {
    await cleanup();
  } catch (error) {
    console.error("自动清理失败，请手工删除以 perf-verify- 开头的应用/订单数据：", error instanceof Error ? error.message : error);
  }
  await db.$disconnect();
}
