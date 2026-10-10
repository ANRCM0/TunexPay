import { z } from "zod";
import { yuanToCents } from "./money.js";

const recordSchema = z.record(z.string(), z.unknown());

export type NormalizedReceiptFlow = {
  providerTradeNo: string;
  merchantOrderNo: string | null;
  amount: number;
  paidAt: Date;
  remark: string | null;
  payType: string | null;
  raw: Record<string, unknown>;
};

export function receiptFlowRecords(input: unknown): Record<string, unknown>[] {
  const payload = recordSchema.parse(input);
  if (Array.isArray(payload.records)) return payload.records.map(item => recordSchema.parse(item));
  if (payload.record && typeof payload.record === "object" && !Array.isArray(payload.record)) {
    return [recordSchema.parse(payload.record)];
  }
  return [payload];
}

export function normalizeReceiptFlow(record: Record<string, unknown>): NormalizedReceiptFlow {
  const providerTradeNo = firstText(record, ["providerTradeNo", "provider_trade_no", "tradeNo", "trade_no", "alipay_order_no", "order_no"]);
  if (!providerTradeNo) throw new z.ZodError([{ code: "custom", path: ["providerTradeNo"], message: "流水缺少支付宝交易号" }]);
  const merchantOrderNo = firstText(record, ["merchantOrderNo", "merchant_order_no", "out_trade_no"])?.slice(0, 80) ?? null;
  const amount = parseFlowAmount(record);
  const paidAt = parsePaidAt(first(record, ["paidAt", "paid_at", "gmt_payment", "trans_time"]));
  const remark = firstText(record, ["remark", "memo", "transfer_remark", "description"])?.slice(0, 300) ?? null;
  const payType = firstText(record, ["payType", "pay_type"])?.slice(0, 32) ?? null;
  return { providerTradeNo: providerTradeNo.slice(0, 100), merchantOrderNo, amount, paidAt, remark, payType, raw: record };
}

export function extractReceiptReference(remark: string | null): string | null {
  const references = [...(remark ?? "").matchAll(/(?:^|[^A-Z0-9])(TX[A-Z0-9]{10})(?=$|[^A-Z0-9])/gi)].map(match => match[1]!.toUpperCase());
  return references.length === 1 ? references[0]! : null;
}

export function isWithinReceiptWindow(paidAt: Date, from: Date | null, until: Date | null): boolean {
  return Boolean(from && until && paidAt >= from && paidAt <= until);
}

export function shanghaiStatementDate(date: Date): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return new Date(`${value.year}-${value.month}-${value.day}T00:00:00.000Z`);
}

function parseFlowAmount(record: Record<string, unknown>): number {
  const cents = first(record, ["amountCents", "amount_cents", "amount"]);
  if (cents !== undefined && cents !== null && cents !== "") {
    const parsed = typeof cents === "number" ? cents : Number(String(cents));
    if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 999_999_999) {
      throw new z.ZodError([{ code: "custom", path: ["amount"], message: "amount 必须是正整数分" }]);
    }
    return parsed;
  }
  const price = firstText(record, ["price", "total_amount"]);
  if (!price) throw new z.ZodError([{ code: "custom", path: ["amount"], message: "流水缺少金额" }]);
  try {
    return yuanToCents(price);
  } catch {
    throw new z.ZodError([{ code: "custom", path: ["price"], message: "price 必须是最多两位小数的人民币金额" }]);
  }
}

function parsePaidAt(value: unknown): Date {
  let date: Date;
  if (typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value.trim()))) {
    const numeric = Number(value);
    date = new Date(numeric > 10_000_000_000 ? numeric : numeric * 1_000);
  } else if (typeof value === "string" && value.trim()) {
    const text = value.trim();
    const zoned = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(text)
      ? `${text.replace(" ", "T")}+08:00`
      : text;
    date = new Date(zoned);
  } else {
    throw new z.ZodError([{ code: "custom", path: ["paidAt"], message: "流水缺少支付时间" }]);
  }
  if (Number.isNaN(date.getTime())) throw new z.ZodError([{ code: "custom", path: ["paidAt"], message: "支付时间格式不合法" }]);
  return date;
}

function first(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) if (record[key] !== undefined) return record[key];
  return undefined;
}

function firstText(record: Record<string, unknown>, keys: string[]): string | null {
  const value = first(record, keys);
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text || null;
}
