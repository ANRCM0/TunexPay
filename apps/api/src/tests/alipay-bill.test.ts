import { describe, expect, it } from "vitest";
import { parseAlipayBill, parseCsv } from "../lib/alipay-bill.js";

describe("Alipay bill parser", () => {
  it("parses quoted CSV cells and escaped quotes", () => {
    expect(parseCsv('a,"b,c","say ""hi"""\r\n1,2,3')).toEqual([
      ["a", "b,c", 'say "hi"'],
      ["1", "2", "3"],
    ]);
  });

  it("normalizes income and refund rows after the Alipay preface", () => {
    const csv = [
      "#支付宝账单明细",
      "支付宝交易号,商户订单号,业务类型,商品名称,创建时间,完成时间,订单金额（元）,商家实收（元）,退款批次号/请求号",
      'ali_100,pay_100,交易,"会员, 月卡",2026-09-15 09:00:00,2026-09-15 09:01:00,19.99,19.89,',
      "ali_100,pay_100,退款,会员月卡,2026-09-15 10:00:00,2026-09-15 10:01:00,19.99,-5.00,ref_100",
      "#合计,,,,,,,,",
    ].join("\r\n");
    const result = parseAlipayBill(csv);
    expect(result.receipts).toHaveLength(2);
    expect(result.receipts[0]).toMatchObject({ direction: "INCOME", providerTradeNo: "ali_100", merchantOrderNo: "pay_100", amount: 1999 });
    expect(result.receipts[1]).toMatchObject({ direction: "REFUND", merchantRefundNo: "ref_100", amount: 500 });
    expect(result.receipts[0]!.occurredAt.toISOString()).toBe("2026-09-15T01:01:00.000Z");
    expect(result.skipped).toBe(1);
  });

  it("rejects files without a recognizable header", () => {
    expect(() => parseAlipayBill("foo,bar\n1,2")).toThrow("未找到支付宝账单表头");
  });
});
