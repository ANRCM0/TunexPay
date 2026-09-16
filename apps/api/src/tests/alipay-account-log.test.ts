import { createSign, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { accountLogPage, alipayTime, collectorWindow, paymentFlowFromAccountLog } from "../lib/alipay-account-log.js";
import { alipayCanonical, verifyAlipaySignature } from "../channels/alipay.js";

const payment = { direction: "收入", trans_amount: "19.99", alipay_order_no: "202609160001", account_log_id: "log-1", trans_dt: "2026-09-16 12:00:00", trans_memo: "会员 TXA1B2C3D4E5", type: "交易", merchant_order_no: "m-1" };

describe("Alipay account ledger contract", () => {
  it("converts incoming ledger entries to integer cents", () => {
    expect(paymentFlowFromAccountLog(payment)).toMatchObject({ amount: 1999, providerTradeNo: "202609160001", remark: payment.trans_memo, paidAt: payment.trans_dt });
  });
  it("ignores outgoing, unidentified income, zero amounts and explicit refund entries", () => {
    expect(paymentFlowFromAccountLog({ ...payment, direction: "支出", trans_amount: "-19.99" })).toBeNull();
    expect(paymentFlowFromAccountLog({ ...payment, direction: "收入", trans_amount: "-0.01" })).toBeNull();
    expect(paymentFlowFromAccountLog({ ...payment, trans_amount: "0.00" })).toBeNull();
    expect(paymentFlowFromAccountLog({ ...payment, alipay_order_no: "" })).toBeNull();
    expect(paymentFlowFromAccountLog({ ...payment, trans_memo: "退款到账" })).toBeNull();
    expect(paymentFlowFromAccountLog({ ...payment, type: "退款" })).toBeNull();
  });
  it("fails closed on malformed amounts, missing direction and missing time", () => {
    expect(() => paymentFlowFromAccountLog({ ...payment, trans_amount: "19.999" })).toThrow();
    expect(() => paymentFlowFromAccountLog({ ...payment, trans_amount: "" })).toThrow();
    expect(() => paymentFlowFromAccountLog({ ...payment, direction: "" })).toThrow();
    expect(() => paymentFlowFromAccountLog({ ...payment, trans_dt: "" })).toThrow();
  });
  it("uses explicit Shanghai time independent of container timezone", () => {
    expect(alipayTime(new Date("2026-09-16T04:00:00Z"))).toBe("2026-09-16 12:00:00");
  });
  it("caps catch-up windows and overlaps the persistent cursor", () => {
    const cursor = new Date("2026-09-16T00:00:00Z");
    const { start, end } = collectorWindow(cursor, new Date("2026-09-16T04:00:00Z"), 300, 15);
    expect(start.toISOString()).toBe("2026-09-15T23:55:00.000Z");
    expect(end.toISOString()).toBe("2026-09-16T00:30:00.000Z");
    expect(collectorWindow(cursor, new Date("2026-09-16T00:01:00Z"), 300, 15).end.toISOString()).toBe("2026-09-16T00:00:45.000Z");
  });
  it("requires total_size and consistent pagination instead of treating schema errors as empty bills", () => {
    expect(accountLogPage({ total_size: 101, detail_list: Array(100).fill(payment) }, 1, 100).complete).toBe(false);
    expect(accountLogPage({ total_size: "101", detail_list: [payment] }, 2, 100).complete).toBe(true);
    expect(accountLogPage({ total_size: 0, detail_list: [] }, 1, 100).complete).toBe(true);
    expect(accountLogPage({ total_size: "0" }, 1, 100).complete).toBe(true);
    expect(accountLogPage({ total_size: 0, account_log_list: [] }, 1, 100).complete).toBe(true);
    expect(() => accountLogPage({}, 1, 100)).toThrow();
    expect(() => accountLogPage({ total_size: 101 }, 1, 100)).toThrow();
    expect(() => accountLogPage({ total_size: 101, detail_list: [] }, 1, 100)).toThrow();
    expect(() => accountLogPage({ total_size: 101, detail_list: [payment] }, 1, 100)).toThrow();
  });
  it("verifies callbacks without sign_type, while requests retain sign_type", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const payload = { app_id: "test", trade_no: "trade", total_amount: "19.99" };
    const signer = createSign("RSA-SHA256"); signer.update(alipayCanonical(payload)); signer.end();
    const sign = signer.sign(privateKey, "base64");
    const key = publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(verifyAlipaySignature({ ...payload, sign_type: "RSA2", sign }, key)).toBe(true);
    expect(verifyAlipaySignature({ ...payload, total_amount: "20.00", sign_type: "RSA2", sign }, key)).toBe(false);
    expect(alipayCanonical({ sign_type: "RSA2" })).toContain("sign_type=RSA2");
  });
});
