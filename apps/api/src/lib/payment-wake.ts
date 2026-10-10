import { Redis } from "ioredis";
import { config } from "../config.js";
import { log } from "./logger.js";

// 收银台长轮询的唤醒通道。
//
// 支付核心在状态落库并提交之后发一条唤醒消息，正在等待的长轮询立刻回来重新查询；
// 同时保留一个兜底轮询间隔，保证「消息没发出/Redis 不可用/多实例」时行为仍然正确，
// 只是恢复到该间隔的延迟。兜底间隔越长越省数据库，代价是 Redis 异常时确认延迟变长。
export const PAYMENT_WAKE_CHANNEL = "tuoxin:pay:payment-changed";
export const PAYMENT_WAKE_FALLBACK_MS = 1_500;

type Waiter = { finish: () => void };

const waiters = new Map<string, Set<Waiter>>();
let publisher: Redis | undefined;
let subscriber: Redis | undefined;
let subscribeRequested = false;

function clientOptions() {
  // 与 Worker 保持一致：请求在连接恢复前排队，而不是直接失败。
  return { maxRetriesPerRequest: null as null };
}

function publisherClient(): Redis | undefined {
  if (publisher) return publisher;
  try {
    const client = new Redis(config().REDIS_URL, clientOptions());
    // ioredis 在连接失败时会持续重连，error 事件必须有人接，否则会冒泡成未捕获异常。
    client.on("error", (error: Error) => log("warn", "payment_wake.publisher_error", { error: error.message }));
    publisher = client;
  } catch (error) {
    log("warn", "payment_wake.publisher_unavailable", { error: error instanceof Error ? error.message : String(error) });
  }
  return publisher;
}

function ensureSubscriber(): void {
  if (subscriber || subscribeRequested) return;
  subscribeRequested = true;
  try {
    const client = new Redis(config().REDIS_URL, clientOptions());
    client.on("error", (error: Error) => log("warn", "payment_wake.subscriber_error", { error: error.message }));
    client.on("message", (channel: string, message: string) => {
      if (channel === PAYMENT_WAKE_CHANNEL) resolveWaiters(message);
    });
    subscriber = client;
    // 订阅失败只影响实时性：等待者仍由各自的兜底计时器兜住。
    // 必须显式断开，否则每次重试都会留下一个仍在重连的连接。
    void client.subscribe(PAYMENT_WAKE_CHANNEL).catch((error: Error) => {
      log("warn", "payment_wake.subscribe_failed", { error: error.message });
      client.disconnect();
      if (subscriber === client) subscriber = undefined;
      subscribeRequested = false;
    });
  } catch (error) {
    subscribeRequested = false;
    log("warn", "payment_wake.subscriber_unavailable", { error: error instanceof Error ? error.message : String(error) });
  }
}

function resolveWaiters(paymentNo: string): void {
  const set = waiters.get(paymentNo);
  if (!set) return;
  waiters.delete(paymentNo);
  for (const waiter of set) waiter.finish();
}

/**
 * 支付状态落库并提交之后调用。永远不抛异常：唤醒只是加速手段，不能影响资金流程。
 */
export function publishPaymentChange(paymentNo: string): void {
  const client = publisherClient();
  if (!client) return;
  void client.publish(PAYMENT_WAKE_CHANNEL, paymentNo).catch((error: unknown) => {
    log("warn", "payment_wake.publish_failed", { error: error instanceof Error ? error.message : String(error) });
  });
}

/**
 * 等待某个支付单发生变化，最多等 timeoutMs（到点即返回，不抛错）。
 * 返回值不携带状态：调用方醒来后重新查一次库，一切以数据库为准。
 */
export function waitForPaymentChange(paymentNo: string, timeoutMs: number): Promise<void> {
  ensureSubscriber();
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const set = waiters.get(paymentNo);
      set?.delete(waiter);
      if (set && set.size === 0) waiters.delete(paymentNo);
      resolve();
    };
    const waiter: Waiter = { finish };
    const timer = setTimeout(finish, Math.max(0, timeoutMs));
    // 等待者超时不应该拖住进程退出。
    timer.unref();
    const set = waiters.get(paymentNo) ?? new Set<Waiter>();
    set.add(waiter);
    waiters.set(paymentNo, set);
  });
}

export async function closePaymentWake(): Promise<void> {
  const clients = [subscriber, publisher].filter((client): client is Redis => Boolean(client));
  subscriber = undefined;
  publisher = undefined;
  subscribeRequested = false;
  // 进程正在退出，用 disconnect 直接断开：quit 需要一次往返，Redis 不可达时会拖住关闭流程。
  for (const client of clients) client.disconnect();
}
