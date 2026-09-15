import { AppError } from "./errors.js";

export function yuanToCents(value: string | number): number {
  const text = String(value).trim();
  const match = /^(0|[1-9]\d{0,8})(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) throw new AppError("INVALID_AMOUNT", "金额必须是最多两位小数的正数");
  const cents = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents <= 0) throw new AppError("INVALID_AMOUNT", "金额必须大于 0");
  return cents;
}

export function centsToYuan(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error("Invalid integer amount");
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}
