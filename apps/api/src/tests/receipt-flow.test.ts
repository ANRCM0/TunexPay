import { describe, expect, it } from "vitest";
import {
  extractReceiptReference,
  isWithinReceiptWindow,
  normalizeReceiptFlow,
  receiptFlowRecords,
  shanghaiStatementDate,
} from "../lib/receipt-flow.js";

describe("receipt watcher flow normalization", () => {
  it("accepts the normalized MPAY watcher record shape", () => {
    const [record] = receiptFlowRecords({ record: {
      order_no: "ali_20260916001",
      price: "19.99",
      paid_at: 1_789_522_860,
      remark: "会员续费 TXA1B2C3D4E5",
      pay_type: "alipay",
    } });
    const flow = normalizeReceiptFlow(record!);
    expect(flow).toMatchObject({
      providerTradeNo: "ali_20260916001",
      amount: 1999,
      remark: "会员续费 TXA1B2C3D4E5",
      payType: "alipay",
    });
    expect(flow.paidAt.toISOString()).toBe("2026-09-16T01:41:00.000Z");
  });

  it("treats amount as integer cents and supports batches", () => {
    const records = receiptFlowRecords({ records: [
      { tradeNo: "ali_1", amount: 1001, paidAt: "2026-09-16 12:00:00" },
      { trade_no: "ali_2", amount_cents: "2500", paid_at: 1_789_526_400_000 },
    ] });
    expect(records.map(normalizeReceiptFlow).map(item => item.amount)).toEqual([1001, 2500]);
    expect(normalizeReceiptFlow(records[0]!).paidAt.toISOString()).toBe("2026-09-16T04:00:00.000Z");
  });

  it("extracts only a complete TUOXIN remark reference", () => {
    expect(extractReceiptReference("请备注 TXA1B2C3D4E5 谢谢")).toBe("TXA1B2C3D4E5");
    expect(extractReceiptReference("TX123")).toBeNull();
  });

  it("uses an inclusive payment window", () => {
    const from = new Date("2026-09-16T04:00:00.000Z");
    const until = new Date("2026-09-16T04:05:00.000Z");
    expect(isWithinReceiptWindow(from, from, until)).toBe(true);
    expect(isWithinReceiptWindow(until, from, until)).toBe(true);
    expect(isWithinReceiptWindow(new Date("2026-09-16T04:05:00.001Z"), from, until)).toBe(false);
  });

  it("archives by the Asia/Shanghai statement date", () => {
    expect(shanghaiStatementDate(new Date("2026-09-15T17:00:00.000Z")).toISOString()).toBe("2026-09-16T00:00:00.000Z");
  });
});
