import { describe, expect, it, vi } from "vitest";
import { cashierAccess, safeReturnUrl } from "../lib/cashier-security.js";
const mocks = vi.hoisted(() => ({ find: vi.fn() }));
vi.mock("../db.js", () => ({ db: { payment: { findUnique: mocks.find } } }));
import { publicPayment } from "../services/payment-service.js";

const now = new Date("2026-09-16T04:00:00Z");
const base = { status: "PROCESSING", receiptValidUntil: new Date("2026-09-16T04:05:00Z"), order: { status: "PENDING", expiresAt: new Date("2026-09-16T04:10:00Z") } };
describe("cashier payment disclosure", () => {
  it("does not render script/data or credential-bearing return links", () => {
    for (const value of ["javascript:alert(1)", "data:text/html,test", "https://user:pass@example.com", "/relative"]) expect(safeReturnUrl(value)).toBeNull();
    expect(safeReturnUrl("https://example.com/return")).toBe("https://example.com/return");
  });
  it("uses the earliest deadline and blocks at the exact expiry", () => {
    expect(cashierAccess(base, now)).toEqual({ payable: true, validUntil: base.receiptValidUntil });
    expect(cashierAccess(base, base.receiptValidUntil).payable).toBe(false);
    expect(cashierAccess({ ...base, order: { ...base.order, expiresAt: now } }, now).payable).toBe(false);
  });
  it("blocks terminal or uncertain attempts and ended business orders", () => {
    for (const status of ["SUCCESS", "FAILED", "CLOSED", "UNKNOWN"]) expect(cashierAccess({ ...base, status }, now).payable).toBe(false);
    for (const status of ["SUCCESS", "CLOSED", "PARTIALLY_REFUNDED", "REFUNDED"]) expect(cashierAccess({ ...base, order: { ...base.order, status } }, now).payable).toBe(false);
  });
  it("public API withholds QR payload after expiry even before worker closes payment", async () => {
    mocks.find.mockResolvedValue({ ...base, receiptValidUntil: new Date(0), paymentNo: "pay_test", channel: "ALIPAY_BILL", clientPayload: { type: "qr_code", value: "secret-qr", remark: "TXA1B2C3D4E5" } });
    expect(await publicPayment("pay_test")).toMatchObject({ payable: false, clientPayload: null, status: "PROCESSING" });
  });
  it("fails closed for a bill payment without a receipt deadline", () => {
    expect(cashierAccess({ ...base, channel: "ALIPAY_BILL", receiptValidUntil: null }, now).payable).toBe(false);
  });
  it("public API withholds QR of a second attempt when the business order is paid", async () => {
    mocks.find.mockResolvedValue({ ...base, receiptValidUntil: null, order: { status: "SUCCESS", expiresAt: null }, clientPayload: { value: "secret-qr" } });
    expect(await publicPayment("pay_test")).toMatchObject({ payable: false, clientPayload: null });
  });
});
