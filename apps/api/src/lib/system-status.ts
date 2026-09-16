import { config } from "../config.js";
import { db } from "../db.js";
import { monitorRedis, monitorWebhookQueue } from "../redis.js";

export const WORKER_HEARTBEAT_KEY = "tuoxin:worker:heartbeat";

const API_VERSION = "0.1.0";

type SubsystemOk = { ok: true; latencyMs: number; version?: string };
type SubsystemDown = { ok: false; error: string };

async function checkMysql(): Promise<SubsystemOk | SubsystemDown> {
  const start = performance.now();
  try {
    const rows = await db.$queryRaw<{ version: string }[]>`SELECT VERSION() AS version`;
    return { ok: true, latencyMs: Math.round(performance.now() - start), version: String(rows[0]?.version ?? "") };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function checkRedis(): Promise<SubsystemOk | SubsystemDown> {
  const start = performance.now();
  try {
    await monitorRedis().ping();
    return { ok: true, latencyMs: Math.round(performance.now() - start) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

type WorkerStatus =
  | { status: "ONLINE" | "STALE" | "OFFLINE"; heartbeatAt: string | null; ageSeconds: number | null }
  | { status: "UNKNOWN"; heartbeatAt: null; ageSeconds: null };

async function checkWorker(): Promise<WorkerStatus> {
  try {
    const heartbeatAt = await monitorRedis().get(WORKER_HEARTBEAT_KEY);
    if (!heartbeatAt) return { status: "OFFLINE", heartbeatAt: null, ageSeconds: null };
    const ageMs = Date.now() - Date.parse(heartbeatAt);
    const status = ageMs < 15_000 ? "ONLINE" : ageMs < 60_000 ? "STALE" : "OFFLINE";
    return { status, heartbeatAt, ageSeconds: Math.max(0, Math.floor(ageMs / 1000)) };
  } catch {
    return { status: "UNKNOWN", heartbeatAt: null, ageSeconds: null };
  }
}

type QueueStatus = { ok: true; waiting: number; active: number; delayed: number; failed: number } | { ok: false };

async function checkWebhookQueue(): Promise<QueueStatus> {
  try {
    const counts = await monitorWebhookQueue().getJobCounts("waiting", "active", "delayed", "failed");
    return {
      ok: true,
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      delayed: counts.delayed ?? 0,
      failed: counts.failed ?? 0,
    };
  } catch {
    return { ok: false };
  }
}

async function collectTasks() {
  const [pendingWebhooks, deadWebhooks, recoveringPayments, recoveringRefunds, openPaymentExceptions, nextDelivery, nextPaymentQuery, nextRefundQuery] = await Promise.all([
    db.webhookDelivery.count({ where: { status: { in: ["PENDING", "PROCESSING"] } } }),
    db.webhookDelivery.count({ where: { status: "DEAD" } }),
    db.payment.count({ where: { status: { in: ["PROCESSING", "UNKNOWN"] }, nextQueryAt: { not: null } } }),
    db.refund.count({ where: { status: { in: ["PROCESSING", "UNKNOWN"] }, nextQueryAt: { not: null } } }),
    db.paymentException.count({ where: { status: { in: ["OPEN", "PROCESSING"] } } }),
    db.webhookDelivery.findFirst({ where: { status: { in: ["PENDING", "PROCESSING"] } }, orderBy: { nextAttemptAt: "asc" }, select: { nextAttemptAt: true } }),
    db.payment.findFirst({ where: { nextQueryAt: { not: null } }, orderBy: { nextQueryAt: "asc" }, select: { nextQueryAt: true } }),
    db.refund.findFirst({ where: { nextQueryAt: { not: null } }, orderBy: { nextQueryAt: "asc" }, select: { nextQueryAt: true } }),
  ]);
  const dueCandidates = [nextDelivery?.nextAttemptAt, nextPaymentQuery?.nextQueryAt, nextRefundQuery?.nextQueryAt]
    .filter((value): value is Date => Boolean(value));
  const nextTaskAt = dueCandidates.length ? new Date(Math.min(...dueCandidates.map(value => value.getTime()))) : null;
  return { pendingWebhooks, deadWebhooks, recoveringPayments, recoveringRefunds, openPaymentExceptions, nextTaskAt };
}

export async function collectSystemStatus() {
  const [mysql, redis, worker, webhookQueue, tasks] = await Promise.all([checkMysql(), checkRedis(), checkWorker(), checkWebhookQueue(), collectTasks()]);
  return {
    api: {
      version: API_VERSION,
      nodeEnv: config().NODE_ENV,
      startedAt: new Date(Date.now() - process.uptime() * 1000),
      uptimeSeconds: Math.floor(process.uptime()),
    },
    mysql,
    redis,
    worker,
    webhookQueue,
    tasks,
  };
}
