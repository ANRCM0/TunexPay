import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findMany: vi.fn(), updateMany: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn(), eventCreate: vi.fn(), transaction: vi.fn(), send: vi.fn() }));

vi.mock("../db.js", () => ({
  db: {
    webhookDelivery: { findMany: mocks.findMany, updateMany: mocks.updateMany, findUniqueOrThrow: mocks.findUniqueOrThrow, update: mocks.update },
    paymentEvent: { create: mocks.eventCreate },
    $transaction: mocks.transaction,
  },
}));
vi.mock("../lib/webhook-security.js", async importOriginal => ({
  ...await importOriginal<typeof import("../lib/webhook-security.js")>(),
  sendWebhookRequest: mocks.send,
}));

import { epaySign, seal, webhookSignature } from "../lib/crypto.js";
import { isPrivateAddress } from "../lib/webhook-security.js";
import { deliverWebhook, recoverExpiredDeliveries, retryDelaySeconds } from "../services/webhook-worker-service.js";

describe("webhook delivery safety", () => {
  it.each(["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.1.1", "::1", "fd00::1"])("blocks private address %s", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it("uses bounded exponential backoff", () => {
    expect(retryDelaySeconds(1, 0.5)).toBe(5);
    expect(retryDelaySeconds(2, 0.5)).toBe(10);
    expect(retryDelaySeconds(20, 0.5)).toBe(3600);
  });
});

// 停机重启后的第一跳不能一次更新掉所有过期租约，必须分批。
describe("recoverExpiredDeliveries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateMany.mockResolvedValue({ count: 0 });
  });

  it("caps one tick at the batch size and only touches those rows", async () => {
    mocks.findMany.mockResolvedValue(Array.from({ length: 100 }, (_, index) => ({ id: `wh_${index}` })));
    mocks.updateMany.mockResolvedValue({ count: 100 });

    expect(await recoverExpiredDeliveries()).toBe(100);
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 100 }));
    const update = mocks.updateMany.mock.calls[0]![0];
    expect(update.where.id.in).toHaveLength(100);
    expect(update.data.status).toBe("PENDING");
    expect(update.data.lockedUntil).toBeNull();
  });

  it("skips the update entirely when nothing has expired", async () => {
    mocks.findMany.mockResolvedValue([]);
    expect(await recoverExpiredDeliveries()).toBe(0);
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("honours a custom batch size", async () => {
    mocks.findMany.mockResolvedValue([{ id: "wh_1" }]);
    mocks.updateMany.mockResolvedValue({ count: 1 });
    await recoverExpiredDeliveries(5);
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 5 }));
  });
});

describe("delivery signatures through the safe transport", () => {
  const payload = { orderNo: "ord_1", amount: 1234 };
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.update.mockResolvedValue({});
    mocks.eventCreate.mockResolvedValue({});
    mocks.send.mockResolvedValue({ status: 200, body: "success" });
    mocks.transaction.mockImplementation(async input => Array.isArray(input) ? Promise.all(input) : input({ webhookDelivery: { update: mocks.update }, paymentEvent: { create: mocks.eventCreate } }));
    mocks.findUniqueOrThrow.mockResolvedValue({
      id: "wh_1", orderId: "order_1", applicationId: "app_1", eventType: "payment.succeeded", attempts: 1, maxAttempts: 8,
      protocol: "NATIVE_V1", url: "https://example.com/hook?existing=1", payload,
      application: { webhookSecretEncrypted: seal("native-secret"), epayKeyEncrypted: seal("epay-secret") }, order: { orderNo: "ord_1" },
    });
  });

  it("sends the unchanged native JSON body and matching HMAC headers", async () => {
    await deliverWebhook("wh_1");
    expect(mocks.send).toHaveBeenCalledTimes(1);
    const [url, input] = mocks.send.mock.calls[0]!;
    expect(url).toBe("https://example.com/hook?existing=1");
    expect(input.method).toBe("POST");
    expect(input.body).toBe(JSON.stringify(payload));
    expect(input.headers).toMatchObject({ "content-type": "application/json", "x-tuoxin-event": "payment.succeeded", "x-tuoxin-delivery": "wh_1" });
    expect(input.headers["x-tuoxin-signature"]).toBe(`v1=${webhookSignature("native-secret", input.headers["x-tuoxin-timestamp"], input.body)}`);
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "SUCCESS", responseBody: "success" }) }));
  });

  it("sends ePay as GET with the same MD5 signature and existing query preserved", async () => {
    const delivery = await mocks.findUniqueOrThrow();
    mocks.findUniqueOrThrow.mockResolvedValue({ ...delivery, protocol: "EPAY_V1" });
    await deliverWebhook("wh_1");
    const [value, input] = mocks.send.mock.calls[0]!;
    const url = new URL(value);
    expect(input).toEqual({ method: "GET" });
    expect(url.searchParams.get("existing")).toBe("1");
    expect(url.searchParams.get("orderNo")).toBe("ord_1");
    expect(url.searchParams.get("amount")).toBe("1234");
    expect(url.searchParams.get("sign_type")).toBe("MD5");
    expect(url.searchParams.get("sign")).toBe(epaySign({ ...payload, sign_type: "MD5" }, "epay-secret"));
  });

  it("still rejects a 200 ePay response without the success ACK", async () => {
    const delivery = await mocks.findUniqueOrThrow();
    mocks.findUniqueOrThrow.mockResolvedValue({ ...delivery, protocol: "EPAY_V1" });
    mocks.send.mockResolvedValue({ status: 200, body: "not acknowledged" });
    await expect(deliverWebhook("wh_1")).rejects.toMatchObject({ code: "WEBHOOK_ACK_INVALID" });
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "PENDING" }) }));
  });

  it("still accepts any native 2xx response and trims the persisted response", async () => {
    mocks.send.mockResolvedValue({ status: 204, body: "x".repeat(3000) });
    await deliverWebhook("wh_1");
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "SUCCESS", responseStatus: 204, responseBody: "x".repeat(2000) }) }));
  });

  it("retries non-2xx HTTP responses instead of marking success", async () => {
    mocks.send.mockResolvedValue({ status: 503, body: "temporarily unavailable" });
    await expect(deliverWebhook("wh_1")).rejects.toMatchObject({ code: "WEBHOOK_HTTP_ERROR" });
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "PENDING", lockedUntil: null }) }));
  });

  it("does not send anything when another worker already owns the lease", async () => {
    mocks.updateMany.mockResolvedValue({ count: 0 });
    await deliverWebhook("wh_1");
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
