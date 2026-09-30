import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ publicPayment: vi.fn(), wait: vi.fn() }));

vi.mock("../services/payment-service.js", () => ({
  publicPayment: mocks.publicPayment,
  handleAlipayWebhook: vi.fn(),
  mockSucceed: vi.fn(),
}));
// 唤醒通道依赖 Redis 连接：测试里替换掉，只验证长轮询的等待策略。
vi.mock("../lib/payment-wake.js", () => ({
  waitForPaymentChange: mocks.wait,
  publishPaymentChange: vi.fn(),
  PAYMENT_WAKE_FALLBACK_MS: 1_500,
}));

import { app } from "../app.js";

const FALLBACK = 1_500;

beforeEach(() => {
  vi.clearAllMocks();
  // 默认按兜底间隔到点返回，等价于「没有收到唤醒消息」。
  mocks.wait.mockImplementation((_paymentNo: string, ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
});

describe("GET /api/v1/channels/public/payments/:paymentNo long polling", () => {
  it("returns immediately without a wait parameter", async () => {
    mocks.publicPayment.mockResolvedValue({ paymentNo: "pay_1", status: "PROCESSING" });
    const started = Date.now();
    const response = await app.request("/api/v1/channels/public/payments/pay_1");
    expect(response.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(350);
    expect(mocks.publicPayment).toHaveBeenCalledTimes(1);
  });

  it("wakes on a payment change instead of polling every 400ms", async () => {
    // 唤醒消息到达 → 立刻重查，不必等兜底间隔。
    mocks.wait.mockResolvedValueOnce(undefined);
    mocks.publicPayment
      .mockResolvedValueOnce({ paymentNo: "pay_1", status: "PROCESSING" })
      .mockResolvedValue({ paymentNo: "pay_1", status: "SUCCESS" });
    const started = Date.now();
    const response = await app.request("/api/v1/channels/public/payments/pay_1?wait=10");
    expect(response.status).toBe(200);
    expect((await response.json()).data.status).toBe("SUCCESS");
    expect(mocks.publicPayment).toHaveBeenCalledTimes(2);
    expect(Date.now() - started).toBeLessThan(500);
    // 等待时长是兜底间隔（而不是旧实现的 400ms 轮询），等待者按支付单登记。
    expect(mocks.wait).toHaveBeenCalledWith("pay_1", FALLBACK);
  });

  it("falls back to the safety interval when no wake arrives", async () => {
    mocks.publicPayment
      .mockResolvedValueOnce({ paymentNo: "pay_1", status: "PROCESSING" })
      .mockResolvedValue({ paymentNo: "pay_1", status: "SUCCESS" });
    const started = Date.now();
    const response = await app.request("/api/v1/channels/public/payments/pay_1?wait=10");
    expect((await response.json()).data.status).toBe("SUCCESS");
    expect(mocks.publicPayment).toHaveBeenCalledTimes(2);
    // 兜底间隔到点才重查：确认「没有消息时也不靠高频轮询」。
    expect(Date.now() - started).toBeGreaterThanOrEqual(FALLBACK - 200);
  });

  it("keeps waiting while the payment is still not terminal", async () => {
    mocks.wait.mockResolvedValue(undefined);
    mocks.publicPayment
      .mockResolvedValueOnce({ paymentNo: "pay_1", status: "PROCESSING" })
      .mockResolvedValueOnce({ paymentNo: "pay_1", status: "UNKNOWN" })
      .mockResolvedValue({ paymentNo: "pay_1", status: "SUCCESS" });
    const response = await app.request("/api/v1/channels/public/payments/pay_1?wait=10");
    expect((await response.json()).data.status).toBe("SUCCESS");
    expect(mocks.publicPayment).toHaveBeenCalledTimes(3);
  });

  it("gives up after the wait budget and returns the latest state", async () => {
    mocks.publicPayment.mockResolvedValue({ paymentNo: "pay_1", status: "PROCESSING" });
    const started = Date.now();
    const response = await app.request("/api/v1/channels/public/payments/pay_1?wait=1");
    expect(response.status).toBe(200);
    expect((await response.json()).data.status).toBe("PROCESSING");
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(Date.now() - started).toBeLessThan(2500);
    // 等待时长不能超过剩余预算，否则长轮询会超出 wait 参数承诺的时间。
    expect(mocks.wait.mock.calls[0]![1]).toBeLessThanOrEqual(1_000);
  }, 10_000);
});
