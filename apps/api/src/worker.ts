import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { config } from "./config.js";
import { db } from "./db.js";
import { log } from "./lib/logger.js";
import { WORKER_TICK_MS, heavyScanStride } from "./lib/worker-policy.js";
import { deliverWebhook, listDueDeliveryIds, recoverExpiredDeliveries } from "./services/webhook-worker-service.js";
import { runDuePaymentRecoveries, runDueRefundRecoveries } from "./services/recovery-service.js";
import { runDueOrderExpirations } from "./services/expiration-service.js";
import { recoverStaleAlipayBillFlows } from "./services/receipt-flow-service.js";
import { runAllBillCollectors } from "./services/alipay-bill-collector-service.js";
import { runNotifications } from "./services/notification-service.js";
import { WORKER_HEARTBEAT_KEY } from "./lib/system-status.js";
import { runAgentInbox } from "./services/agent-inbox-service.js";

const connection = new Redis(config().REDIS_URL, { maxRetriesPerRequest: null });
const queue = new Queue("tuoxin-pay-webhooks", { connection });
const worker = new Worker("tuoxin-pay-webhooks", async (job) => {
  await deliverWebhook(String(job.data.id));
}, { connection, concurrency: 8 });

worker.on("completed", (job) => log("info", "webhook.completed", { jobId: job.id }));
worker.on("failed", (job, error) => log("warn", "webhook.failed", { jobId: job?.id, error: error.message }));
worker.on("error", (error) => log("error", "worker.error", { error: error.message }));

// 心跳代表「快速通道刚刚跑通」：能连上 MySQL、能读到到期投递、能把任务交给 Redis。
// 只有成功才写，所以数据库出错或快速通道卡住时心跳会自然停更，管理台 15 秒后即显示 STALE，
// 而不是像以前那样无论成败都刷新心跳、永远显示 ONLINE。
function writeHeartbeat(): void {
  void connection.set(WORKER_HEARTBEAT_KEY, new Date().toISOString()).catch((error: unknown) => log("warn", "worker.heartbeat_failed", { error: error instanceof Error ? error.message : String(error) }));
}

// 快速通道：每跳都跑。它决定支付成功通知的时效，因此单独守卫，
// 不能排在可能耗时上百秒的查单恢复后面等（以前两者在同一个守卫里，恢复扫描会拖慢通知）。
let fastPolling = false;
let fastTask: Promise<void> | null = null;
async function pollDueDeliveries(): Promise<void> {
  if (fastPolling) return;
  fastPolling = true;
  try {
    await recoverExpiredDeliveries();
    const due = await listDueDeliveryIds();
    for (const item of due) {
      await queue.add("deliver", { id: item.id }, {
        jobId: `${item.id}-${item.attempts}`,
        removeOnComplete: { age: 3_600, count: 1_000 },
        removeOnFail: { age: 86_400, count: 5_000 },
      });
    }
    writeHeartbeat();
  } catch (error) {
    log("error", "worker.poll_failed", { error: error instanceof Error ? error.message : String(error) });
  } finally {
    fastPolling = false;
  }
}

// 慢速通道：查单恢复 / 过期关闭 / 流水恢复。空闲时按 stride 拉长间隔，领到任务立刻回到每跳。
let idleTicks = 0;
let ticksSinceHeavy = 0;
let heavyScanning = false;
let heavyTask: Promise<void> | null = null;
async function scanDueRecoveries(): Promise<void> {
  if (heavyScanning) return;
  heavyScanning = true;
  try {
    const [payments, refunds, expirations, receiptFlows] = await Promise.all([runDuePaymentRecoveries(), runDueRefundRecoveries(), runDueOrderExpirations(), recoverStaleAlipayBillFlows()]);
    const claimed = payments.claimed + refunds.claimed + expirations.claimed + receiptFlows.found;
    idleTicks = claimed > 0 ? 0 : idleTicks + 1;
    if (payments.claimed || refunds.claimed) log("info", "recovery.completed", { payments, refunds });
    if (expirations.claimed) log("info", "expiration.completed", { expirations });
    if (receiptFlows.found) log("info", "receipt_flow.recovered", { receiptFlows });
  } catch (error) {
    // 出错说明不是「空闲」：不要退避，下一跳立刻重试
    idleTicks = 0;
    log("error", "worker.scan_failed", { error: error instanceof Error ? error.message : String(error) });
  } finally {
    heavyScanning = false;
  }
}

let ownerTask: Promise<void> | null = null;
let collectorTask: Promise<void> | null = null;
let agentTask: Promise<void> | null = null;

function tick(): void {
  ticksSinceHeavy += 1;
  const runHeavy = ticksSinceHeavy >= heavyScanStride(idleTicks);
  if (runHeavy) ticksSinceHeavy = 0;

  if (!fastTask) fastTask = pollDueDeliveries().finally(() => { fastTask = null; });
  if (runHeavy && !heavyTask) heavyTask = scanDueRecoveries().finally(() => { heavyTask = null; });
  if (runHeavy && !ownerTask) ownerTask = runNotifications().catch(() => log("error", "notification.worker_failed", { code: "NOTIFICATION_WORKER_ERROR" })).finally(() => { ownerTask = null; });
  // 采集器有自己的 nextRunAt 与 demand 唤醒路径，必须每跳检查，不参与退避
  if (!collectorTask) collectorTask = runAllBillCollectors().catch(() => log("error", "alipay_bill.collector_unavailable", { code: "DATABASE_OR_CONFIG_ERROR" })).finally(() => { collectorTask = null; });
  if (!agentTask) agentTask = runAgentInbox().catch(error => log("error","agent.worker_failed",{error:error instanceof Error?error.message:String(error)})).finally(() => { agentTask = null; });
}

const interval = setInterval(tick, WORKER_TICK_MS);
tick();
log("info", "worker.started", { queue: "tuoxin-pay-webhooks" });

async function shutdown(): Promise<void> {
  clearInterval(interval);
  await connection.del(WORKER_HEARTBEAT_KEY).catch(() => undefined);
  await Promise.allSettled([fastTask, heavyTask, collectorTask, ownerTask, agentTask].filter((task): task is Promise<void> => Boolean(task)));
  await worker.close();
  await queue.close();
  await connection.quit();
  await db.$disconnect();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
