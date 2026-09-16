import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ publicPayment: vi.fn() }));

vi.mock("../services/payment-service.js", () => ({
  publicPayment: mocks.publicPayment,
  handleAlipayWebhook: vi.fn(),
  mockSucceed: vi.fn(),
}));

import { app } from "../app.js";

beforeEach(() => vi.clearAllMocks());

describe("GET /api/v1/channels/public/payments/:paymentNo long polling", () => {
  it("returns immediately without a wait parameter", async () => {
    mocks.publicPayment.mockResolvedValue({ paymentNo: "pay_1", status: "PROCESSING" });
    const started = Date.now();
    const response = await app.request("/api/v1/channels/public/payments/pay_1");
    expect(response.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(350);
    expect(mocks.publicPayment).toHaveBeenCalledTimes(1);
  });

  it("returns as soon as the payment turns terminal inside the wait window", async () => {
    mocks.publicPayment
      .mockResolvedValueOnce({ paymentNo: "pay_1", status: "PROCESSING" })
      .mockResolvedValue({ paymentNo: "pay_1", status: "SUCCESS" });
    const response = await app.request("/api/v1/channels/public/payments/pay_1?wait=10");
    expect(response.status).toBe(200);
    expect((await response.json()).data.status).toBe("SUCCESS");
    expect(mocks.publicPayment).toHaveBeenCalledTimes(2);
  });

  it("gives up after the wait budget and returns the latest state", async () => {
    mocks.publicPayment.mockResolvedValue({ paymentNo: "pay_1", status: "PROCESSING" });
    const started = Date.now();
    const response = await app.request("/api/v1/channels/public/payments/pay_1?wait=1");
    expect(response.status).toBe(200);
    expect((await response.json()).data.status).toBe("PROCESSING");
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(Date.now() - started).toBeLessThan(2500);
  }, 10_000);
});
