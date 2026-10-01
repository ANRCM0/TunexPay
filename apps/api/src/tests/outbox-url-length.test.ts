import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createPaymentSucceededDelivery, createRefundSucceededDelivery } from "../services/outbox-service.js";
import { createOrderSchema } from "../services/order-service.js";

vi.mock("../db.js", () => ({ db: {} }));
const root = new URL("../../../../", import.meta.url);
const schema = readFileSync(new URL("prisma/schema.prisma", root), "utf8");
const migration = readFileSync(new URL("prisma/migrations/202610010004_webhook_url_length/migration.sql", root), "utf8");
const initial = readFileSync(new URL("prisma/migrations/202609160001_init/migration.sql", root), "utf8");

function urlAtLength(length: number) {
  const base = "https://example.com/";
  return base + "a".repeat(length - base.length);
}

describe("outbox URL contract", () => {
  it("preserves the existing 500-character order notification contract", () => {
    const input = { externalOrderNo: "external_1", amount: 100, subject: "test", notifyUrl: urlAtLength(500) };
    expect(createOrderSchema.parse(input).notifyUrl).toHaveLength(500);
    expect(createOrderSchema.safeParse({ ...input, notifyUrl: urlAtLength(501) }).success).toBe(false);
  });

  it.each(["payment", "refund"])("copies a full 500-character URL into the %s outbox", async kind => {
    const upsert = vi.fn();
    const tx = { webhookDelivery: { upsert } } as never;
    const url = urlAtLength(500);
    const application = { id: "a1", webhookUrl: url } as never;
    const order = { id: "o1", amount: 100, protocol: "NATIVE_V1" } as never;
    const payment = { paymentNo: "pay_1" } as never;
    if (kind === "payment") await createPaymentSucceededDelivery(tx, application, order, payment);
    else await createRefundSucceededDelivery(tx, application, order, payment, { refundNo: "ref_1", amount: 100 } as never);
    const input = upsert.mock.calls[0]![0];
    expect(input.create.url).toBe(url);
    expect(input.where.orderId_eventType_url.url).toBe(url);
    expect(input.create.eventType).toMatch(/^[\x00-\x7f]+$/);
  });

  it("retains the full-column unique key while migrating the URL length", () => {
    const delivery = schema.split("model WebhookDelivery {")[1]!.split("\n}")[0]!;
    expect(delivery).toMatch(/url\s+String\s+@db\.VarChar\(500\)/);
    expect(delivery).toContain("@@unique([orderId, eventType, url])");
    expect(migration).toMatch(/MODIFY `url` VARCHAR\(500\) NOT NULL/);
    expect(migration).toMatch(/MODIFY `eventType` VARCHAR\(80\) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL/);
    expect(migration).toContain("STRICT_ALL_TABLES");
    expect(migration).not.toMatch(/\b(?:DROP|DELETE|TRUNCATE)\b/i);
    expect(initial).toContain("`url` VARCHAR(300) NOT NULL");
    expect(191 * 4 + 80 + 500 * 4).toBeLessThanOrEqual(3072);
  });
});
