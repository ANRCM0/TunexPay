import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  publish: vi.fn(),
  subscribe: vi.fn(),
  disconnect: vi.fn(),
  log: vi.fn(),
  handlers: new Map<string, (...args: unknown[]) => void>(),
}));

vi.mock("ioredis", () => ({
  Redis: class {
    on = (event: string, handler: (...args: unknown[]) => void) => { mocks.handlers.set(event, handler); return this; };
    publish = mocks.publish;
    subscribe = mocks.subscribe;
    disconnect = mocks.disconnect;
  },
}));
vi.mock("../config.js", () => ({ config: () => ({ REDIS_URL: "redis://test" }) }));
vi.mock("../lib/logger.js", () => ({ log: mocks.log }));

import { PAYMENT_WAKE_CHANNEL, closePaymentWake, publishPaymentChange, waitForPaymentChange } from "../lib/payment-wake.js";

function emitMessage(channel: string, message: string): void {
  mocks.handlers.get("message")?.(channel, message);
}

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.handlers.clear();
  mocks.publish.mockResolvedValue(1);
  mocks.subscribe.mockResolvedValue(undefined);
  // 每个用例都从「没有任何连接」的状态开始。
  await closePaymentWake();
});

afterEach(async () => { await closePaymentWake(); });

describe("payment wake channel", () => {
  it("publishes the payment number on the shared channel after a state change", async () => {
    publishPaymentChange("pay_1");
    expect(mocks.publish).toHaveBeenCalledWith(PAYMENT_WAKE_CHANNEL, "pay_1");
    await sleep(0);
  });

  it("never throws when publishing fails", async () => {
    mocks.publish.mockRejectedValue(new Error("redis down"));
    publishPaymentChange("pay_1");
    await sleep(0);
    expect(mocks.log).toHaveBeenCalledWith("warn", "payment_wake.publish_failed", expect.objectContaining({ error: "redis down" }));
  });

  it("resolves a waiter when the matching payment changes", async () => {
    const waiting = waitForPaymentChange("pay_1", 5_000);
    await sleep(0);
    emitMessage(PAYMENT_WAKE_CHANNEL, "pay_1");
    await expect(waiting).resolves.toBeUndefined();
  });

  it("ignores changes for other payments and other channels", async () => {
    const waiting = waitForPaymentChange("pay_1", 40);
    await sleep(0);
    emitMessage("some:other:channel", "pay_1");
    emitMessage(PAYMENT_WAKE_CHANNEL, "pay_2");
    await expect(Promise.race([waiting.then(() => "woken"), sleep(15).then(() => "still-waiting")])).resolves.toBe("still-waiting");
    // 超时兜底：没有人唤醒也必须返回，长轮询不会永远挂住。
    await expect(waiting).resolves.toBeUndefined();
  });

  it("wakes every waiter registered for the same payment", async () => {
    const first = waitForPaymentChange("pay_1", 5_000);
    const second = waitForPaymentChange("pay_1", 5_000);
    await sleep(0);
    emitMessage(PAYMENT_WAKE_CHANNEL, "pay_1");
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
  });

  it("disconnects both connections on shutdown and still releases waiters by timeout", async () => {
    publishPaymentChange("pay_1");
    const waiting = waitForPaymentChange("pay_1", 30);
    await sleep(0);
    await closePaymentWake();
    // 发布连接 + 订阅连接各断开一次。
    expect(mocks.disconnect).toHaveBeenCalledTimes(2);
    await expect(waiting).resolves.toBeUndefined();
  });
});
