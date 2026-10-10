/**
 * 管理台「人工发起退款」表单的输入边界。
 *
 * 这是资金入口前的最后一道纯函数校验：金额一旦在这里算错，后面就是真金白银。
 * 所以放在 lib 里单独测试，而不是埋进组件里。
 */

/**
 * 元 → 整数分。只接受最多两位小数的正数，其余一律返回 null。
 *
 * 刻意不「智能修正」输入：`1.005`、`1e3`、`12.`、`¥12.34` 全部拒绝，而不是四舍五入成
 * 一笔金额和界面显示不一致的退款。`12.34 * 100` 在 IEEE754 下是 1233.9999…，
 * 用 Math.round 收口。
 */
export function parseYuanToCents(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const cents = Math.round(Number(trimmed) * 100);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

/**
 * 每次表单内容变化都换一个幂等键：
 * - 网络失败后原样重提 → 命中同一张退款单，不会退成两笔；
 * - 改了金额再提交 → 服务端按新的退款意图处理，而不是报 IDEMPOTENCY_CONFLICT。
 *
 * 服务端会拼成 `admin_<key>` 作为 externalRefundNo，因此只允许 [A-Za-z0-9_-]。
 */
export function newRefundIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}
