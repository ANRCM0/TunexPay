export function safeReturnUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function cashierAccess(payment: {
  status: string; channel?: string; receiptValidUntil: Date | null;
  order: { status: string; expiresAt: Date | null };
}, now = new Date()) {
  const deadlines = [payment.receiptValidUntil, payment.order.expiresAt].filter((value): value is Date => value !== null);
  const validUntil = deadlines.length ? new Date(Math.min(...deadlines.map(value => value.getTime()))) : null;
  const payable = ["CREATED", "PROCESSING"].includes(payment.status)
    && (payment.channel !== "ALIPAY_BILL" || Boolean(payment.receiptValidUntil))
    && ["CREATED", "PENDING"].includes(payment.order.status)
    && (!validUntil || now < validUntil);
  return { payable, validUntil };
}
