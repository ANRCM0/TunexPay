/** Scope changes must never grant tools the user did not explicitly select. */
export function retainAllowedTools(selected: readonly string[], available: readonly string[]): string[] {
  const eligible = new Set(available);
  return selected.filter(key => eligible.has(key));
}

/** Only browser-safe cashier links may be opened from a payment-testing response. */
export function cashierLink(raw: string, origin: string): string {
  if (!raw.trim()) throw new Error("验收订单创建成功，但服务器没有返回收银台链接");
  const url = new URL(raw, origin);
  if (!["https:", "http:"].includes(url.protocol)) throw new Error("收银台链接无效");
  return url.toString();
}
