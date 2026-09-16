import { normalizeReceiptFlow } from "./receipt-flow.js";
import { yuanToCents } from "./money.js";

export function alipayTime(date: Date): string {
  return new Date(date.getTime() + 8 * 3_600_000).toISOString().slice(0, 19).replace("T", " ");
}

export function collectorWindow(cursor: Date, now: Date, overlapSeconds: number, lagSeconds: number) {
  const end = new Date(Math.min(now.getTime() - lagSeconds * 1000, cursor.getTime() + 1800_000));
  return { start: new Date(cursor.getTime() - overlapSeconds * 1000), end };
}

export function accountLogPage(response: Record<string, unknown>, pageNo: number, pageSize: number) {
  if (!Array.isArray(response.account_log_list)) throw new Error("ALIPAY_BILL_INVALID_PAGE: account_log_list missing");
  const total = Number(response.total_size);
  if (!Number.isSafeInteger(total) || total < 0 || response.account_log_list.length > pageSize) throw new Error("ALIPAY_BILL_INVALID_PAGE: invalid total_size or page length");
  const expected = Math.min(pageSize, Math.max(0, total - (pageNo - 1) * pageSize));
  if (response.account_log_list.length !== expected) throw new Error("ALIPAY_BILL_INVALID_PAGE: page length conflicts with total_size");
  return { records: response.account_log_list as unknown[], complete: pageNo * pageSize >= total };
}

// accountlog is a ledger, not a list of exclusively successful payment trades.
// Never convert withdrawals, fees, or unidentified credits into payment success.
export function paymentFlowFromAccountLog(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("ALIPAY_BILL_INVALID_RECORD");
  const record = value as Record<string, unknown>;
  const income = String(record.income ?? "");
  const outcome = String(record.outcome ?? "");
  const money = (text: string) => {
    if (!/^\d+(\.\d{1,2})?$/.test(text)) throw new Error("ALIPAY_BILL_INVALID_RECORD: income/outcome missing or malformed");
    return text === "0" || /^0\.0{1,2}$/.test(text) ? 0 : yuanToCents(text);
  };
  const incoming = money(income), outgoing = money(outcome);
  if (incoming === 0 || outgoing > 0) return null;
  const tradeNo = typeof record.alipay_order_no === "string" ? record.alipay_order_no.trim() : "";
  if (!tradeNo) return null;
  // Explicit refund/reversal ledger entries are not incoming customer payments.
  if (/退款|退回|撤销|冲正/.test(String(record.trans_memo ?? ""))) return null;
  const flow = {
    providerTradeNo: tradeNo,
    merchantOrderNo: record.merchant_order_no,
    amount: incoming,
    paidAt: record.trans_dt,
    remark: record.trans_memo,
    payType: "alipay",
    accountLogId: record.account_log_id,
  };
  normalizeReceiptFlow(flow); // fail closed; a malformed payment row must not move the cursor
  return flow;
}
