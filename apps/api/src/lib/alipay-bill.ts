import { AppError } from "./errors.js";
import { yuanToCents } from "./money.js";

export type ParsedReceipt = {
  direction: "INCOME" | "REFUND";
  providerTradeNo: string | null;
  merchantOrderNo: string | null;
  providerRefundNo: string | null;
  merchantRefundNo: string | null;
  amount: number;
  occurredAt: Date;
  rawPayload: Record<string, string>;
};

export function parseAlipayBill(csv: string): { receipts: ParsedReceipt[]; skipped: number } {
  const rows = parseCsv(csv);
  const headerIndex = rows.findIndex(row => row.some(cell => normalizeHeader(cell) === "支付宝交易号") && row.some(cell => normalizeHeader(cell) === "商户订单号"));
  if (headerIndex < 0) throw new AppError("ALIPAY_BILL_HEADER_NOT_FOUND", "未找到支付宝账单表头，请上传支付宝交易明细 CSV", 422);
  const headers = rows[headerIndex]!.map(normalizeHeader);
  const receipts: ParsedReceipt[] = [];
  let skipped = 0;

  for (const row of rows.slice(headerIndex + 1)) {
    const raw = Object.fromEntries(headers.map((header, index) => [header || `column_${index + 1}`, cleanCell(row[index] ?? "")]));
    const providerTradeNo = field(raw, "支付宝交易号", "交易号");
    const merchantOrderNo = field(raw, "商户订单号", "商家订单号");
    if (!providerTradeNo && !merchantOrderNo) {
      if (row.some(cell => cleanCell(cell))) skipped += 1;
      continue;
    }
    const businessType = field(raw, "业务类型", "交易类型") ?? "";
    const refundValue = field(raw, "退款金额（元）", "退款金额(元)");
    const receivedValue = field(raw, "商家实收（元）", "商家实收(元)");
    const orderValue = field(raw, "订单金额（元）", "订单金额(元)");
    const direction = businessType.includes("退款") || isNegative(refundValue) || isNegative(receivedValue) ? "REFUND" : "INCOME";
    const amount = firstAmount(direction === "REFUND" ? [refundValue, receivedValue, orderValue] : [orderValue, receivedValue]);
    const occurredAt = parseAlipayTime(field(raw, "完成时间", "交易完成时间", "创建时间"));
    if (!amount || !occurredAt) {
      skipped += 1;
      continue;
    }
    receipts.push({
      direction,
      providerTradeNo,
      merchantOrderNo,
      providerRefundNo: field(raw, "支付宝退款单号", "退款交易号"),
      merchantRefundNo: field(raw, "退款批次号/请求号", "退款批次号", "退款请求号", "商户退款单号"),
      amount,
      occurredAt,
      rawPayload: raw,
    });
  }
  if (!receipts.length) throw new AppError("ALIPAY_BILL_EMPTY", "账单中没有可识别的收入或退款记录", 422, { skipped });
  return { receipts, skipped };
}

export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const text = input.replace(/^\uFEFF/, "");
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { cell += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(cell); cell = ""; }
    else if (char === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (char !== "\r") cell += char;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function normalizeHeader(value: string): string {
  return cleanCell(value).replace(/\s+/g, "");
}

function cleanCell(value: string): string {
  return value.replace(/^\s+|\s+$/g, "");
}

function field(row: Record<string, string>, ...names: string[]): string | null {
  for (const name of names) {
    const value = row[normalizeHeader(name)];
    if (value && value !== "-") return value;
  }
  return null;
}

function isNegative(value: string | null): boolean {
  return Boolean(value && /^\s*-/.test(value));
}

function firstAmount(values: Array<string | null>): number | null {
  for (const value of values) {
    if (!value) continue;
    const normalized = value.replaceAll(",", "").trim().replace(/^[+-]/, "");
    if (!normalized || Number(normalized) === 0) continue;
    try { return yuanToCents(normalized); }
    catch { continue; }
  }
  return null;
}

function parseAlipayTime(value: string | null): Date | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const parsed = new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}+08:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
