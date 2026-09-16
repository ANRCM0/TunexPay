import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { config } from "./config.js";
import { db } from "./db.js";
import { log } from "./lib/logger.js";
import { deliverWebhook, listDueDeliveryIds, recoverExpiredDeliveries } from "./services/webhook-worker-service.js";
import { runDuePaymentRecoveries, runDueRefundRecoveries } from "./services/recovery-service.js";
import { runDueOrderExpirations } from "./services/expiration-service.js";
import { recoverStaleAlipayBillFlows } from "./services/receipt-flow-service.js";
import { runAlipayBillCollector } from "./services/alipay-bill-collector-service.js";
import { runOwnerNotifications } from "./services/owner-notification-service.js";
import { WORKER_HEARTBEAT_KEY } from "./lib/system-status.js";

const connection = new Redis(config().REDIS_URL, { maxRetriesPerRequest: null });
const queue = new Queue("tuoxin-pay-webhooks", { connection });
const worker = new Worker("tuoxin-pay-webhooks", async (job) => {
  await deliverWebhook(String(job.data.id));
}, { connection, concurrency: 8 });

worker.on("completed", (job) => log("info", "webhook.completed", { jobId: job.id }));
worker.on("failed", (job, error) => log("warn", "webhook.failed", { jobId: job?.id, error: error.message }));
worker.on("error", (error) => log("error", "worker.error", { error: error.message }));

let polling = false;
async function poll(): Promise<void> {
  if (polling) return;
  polling = true;
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
    const [payments, refunds, expirations, receiptFlows] = await Promise.all([runDuePaymentRecoveries(), runDueRefundRecoveries(), runDueOrderExpirations(), recoverStaleAlipayBillFlows()]);
    if (payments.claimed || refunds.claimed) log("info", "recovery.completed", { payments, refunds });
    if (expirations.claimed) log("info", "expiration.completed", { expirations });
    if (receiptFlows.found) log("info", "receipt_flow.recovered", { receiptFlows });
  } catch (error) {
    log("error", "worker.poll_failed", { error: error instanceof Error ? error.message : String(error) });
  } finally {
    polling = false;
  }
}

let pollTask: Promise<void> | null = null;
let collectorTask: Promise<void> | null = null;
let ownerTask: Promise<void> | null = null;
function tick(): void {
  void connection.set(WORKER_HEARTBEAT_KEY, new Date().toISOString()).catch((error: unknown) => log("warn", "worker.heartbeat_failed", { error: error instanceof Error ? error.message : String(error) }));
  if (!ownerTask) ownerTask = runOwnerNotifications().catch(() => log("error", "owner_notification.worker_failed", { code: "NOTIFICATION_WORKER_ERROR" })).finally(() => { ownerTask = null; });
  if (!pollTask) pollTask = poll().finally(() => { pollTask = null; });
  if (!collectorTask) collectorTask = runAlipayBillCollector().catch(() => log("error", "alipay_bill.collector_unavailable", { code: "DATABASE_OR_CONFIG_ERROR" })).finally(() => { collectorTask = null; });
}
const interval = setInterval(tick, 3_000);
tick();
log("info", "worker.started", { queue: "tuoxin-pay-webhooks" });

async function shutdown(): Promise<void> {
  clearInterval(interval);
  await connection.del(WORKER_HEARTBEAT_KEY).catch(() => undefined);
  await Promise.allSettled([pollTask, collectorTask, ownerTask].filter((task): task is Promise<void> => Boolean(task)));
  await worker.close();
  await queue.close();
  await connection.quit();
  await db.$disconnect();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
