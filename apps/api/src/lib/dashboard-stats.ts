import { db } from "../db.js";
import { RECOVERY_MAX_ATTEMPTS } from "./recovery-policy.js";

/**
 * `/admin/v1/dashboard` 的 14 个计数原本由 14 条 Prisma `count/aggregate` 并发执行
 * （加 1 条 `recentEvents` 的 `findMany`，每次刷新共 15 条语句/连接）。这里把它们合并为
 * **一条** 条件聚合 SQL：8 张表各自一个子查询，数据库只解析一次、只走一趟连接。
 *
 * 语义必须与 Prisma 版本逐条等价，尤其是关联过滤：
 *  - `{ order: { deletedAt: null } }` 是 **INNER JOIN 语义**：必须存在一条 `deletedAt IS NULL`
 *    的 order。因此不能写成 `LEFT JOIN orders o ... WHERE o.deletedAt IS NULL`（那样会把
 *    `orderId` 为空的行也算进来），本文件统一写成
 *    `JOIN orders o ON o.id = <fk> AND o.deletedAt IS NULL`（内连接，语义与 EXISTS 相同）。
 *  - `OR: [{ payment: {...} }, { payment: null }]` 写成 `(<fk> IS NULL OR EXISTS (...))`。
 *
 * 表名/列名与 `prisma/schema.prisma` 的 `@@map` / 字段名一致（camelCase 列，如 `deletedAt`）。
 * 枚举取值直接内联为字面量（不能用模板参数占位，Prisma 会把它变成 `IN (?)`）；两点注意：
 *  - 「今天零点」按 UTC 约定格式化为字符串参数传入（见 `mysqlUtcDateTime`）；
 *  - `RECOVERY_MAX_ATTEMPTS` 是编译期常量、不是用户输入，同样内联为数字字面量。
 */
const MAX_ATTEMPTS = RECOVERY_MAX_ATTEMPTS;

/**
 * Prisma 的 `$queryRaw` 标签模板只接收原始标量（string/number/bigint/boolean/null）。
 * 传 Date 时它只是被原样放进参数数组，最终以什么形态到达 MySQL 由引擎/驱动决定，无法保证被
 * 当作 DATETIME 解析。这里显式给出 MySQL DATETIME 文本，并且**按 UTC 约定**：Prisma 对 MySQL 的
 * DATETIME 一律按 UTC 存取，所以边界值也必须是同一个约定下的字面量。
 *
 * 必须用 UTC 字段而不是本地字段：进程时区不一定是 UTC（compose 只给 mysql 设了
 * TZ=Asia/Shanghai，app 容器没设、是 UTC；裸机或 `dev` 运行时进程时区可能是 +08:00）。
 * 用本地字段会把「今天零点」按偏移量整体平移。
 */
function mysqlUtcDateTime(value: Date): string {
  return value.toISOString().replace("T", " ").replace("Z", "");
}

/** 单行结果，列顺序与 SQL 的 SELECT 顺序严格一致。 */
export type DashboardStatsRow = [
  applications: unknown,
  ordersToday: unknown,
  successfulToday: unknown,
  unknownPayments: unknown,
  pendingWebhooks: unknown,
  amountToday: unknown,
  recoveringPayments: unknown,
  recoveringRefunds: unknown,
  exhaustedRecoveries: unknown,
  unmatchedReceipts: unknown,
  mismatchedReceipts: unknown,
  openPaymentExceptions: unknown,
  expirationFailures: unknown,
  failedAdminActionsToday: unknown,
];

export type DashboardStats = {
  applications: number;
  ordersToday: number;
  successfulToday: number;
  unknownPayments: number;
  pendingWebhooks: number;
  amountToday: number;
  recoveringPayments: number;
  recoveringRefunds: number;
  exhaustedRecoveries: number;
  unmatchedReceipts: number;
  mismatchedReceipts: number;
  openPaymentExceptions: number;
  expirationFailures: number;
  failedAdminActionsToday: number;
};

/**
 * `$queryRaw` 在 MySQL 下 COUNT 返回 BigInt、SUM 返回 Decimal，两者都不能直接进
 * `JSON.stringify`（`Do not know how to serialize a BigInt` / Decimal 会被序列化成字符串）。
 * 这里统一收敛成 number：BigInt → Number，Decimal（有 `toNumber()`）→ number。
 */
function toNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "bigint") return Number(value);
  if (value && typeof value === "object" && typeof (value as { toNumber?: unknown }).toNumber === "function") {
    return (value as { toNumber(): number }).toNumber();
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/**
 * 一条 SQL 取回 14 个计数。
 *
 * 每个计数都是一个标量子查询（无 GROUP BY 的 COUNT 恒为 1 行；SUM 无匹配行时为 NULL），
 * 所以整条语句恒为一行 14 列，列顺序固定，JS 侧按位置还原。
 */
export async function loadDashboardStats(start: Date): Promise<DashboardStats> {
  // 归档订单（随应用删除的历史数据）不进入任何一个计数：管理台只看在用业务（live = deletedAt IS NULL）。
  const since = mysqlUtcDateTime(start);
  const rows = await db.$queryRaw<DashboardStatsRow[]>`
    SELECT
      (SELECT COUNT(*) FROM applications a
        WHERE a.status = 'ACTIVE' AND a.archivedAt IS NULL) AS applications,
      (SELECT COUNT(*) FROM orders o
        WHERE o.deletedAt IS NULL AND o.createdAt >= ${since}) AS ordersToday,
      (SELECT COUNT(*) FROM orders o
        WHERE o.deletedAt IS NULL AND o.paidAt >= ${since}) AS successfulToday,
      (SELECT COUNT(*) FROM payments p
        JOIN orders o ON o.id = p.orderId AND o.deletedAt IS NULL
        WHERE p.status = 'UNKNOWN') AS unknownPayments,
      (SELECT COUNT(*) FROM webhook_deliveries w
        JOIN orders o ON o.id = w.orderId AND o.deletedAt IS NULL
        WHERE w.status IN ('PENDING', 'PROCESSING', 'DEAD')) AS pendingWebhooks,
      (SELECT SUM(p.amount) FROM payments p
        JOIN orders o ON o.id = p.orderId AND o.deletedAt IS NULL
        WHERE p.status = 'SUCCESS' AND p.paidAt >= ${since}) AS amountToday,
      (SELECT COUNT(*) FROM payments p
        JOIN orders o ON o.id = p.orderId AND o.deletedAt IS NULL
        WHERE p.channel = 'ALIPAY' AND p.status IN ('PROCESSING', 'UNKNOWN')
          AND p.nextQueryAt IS NOT NULL) AS recoveringPayments,
      (SELECT COUNT(*) FROM refunds r
        JOIN payments p ON p.id = r.paymentId AND p.channel = 'ALIPAY'
        JOIN orders o ON o.id = p.orderId AND o.deletedAt IS NULL
        WHERE r.status IN ('PROCESSING', 'UNKNOWN') AND r.nextQueryAt IS NOT NULL) AS recoveringRefunds,
      (
        (SELECT COUNT(*) FROM payments p
          JOIN orders o ON o.id = p.orderId AND o.deletedAt IS NULL
          WHERE p.channel = 'ALIPAY' AND p.status IN ('PROCESSING', 'UNKNOWN')
            AND p.nextQueryAt IS NULL AND p.queryAttempts >= ${MAX_ATTEMPTS})
        +
        (SELECT COUNT(*) FROM refunds r
          JOIN payments p ON p.id = r.paymentId AND p.channel = 'ALIPAY'
          JOIN orders o ON o.id = p.orderId AND o.deletedAt IS NULL
          WHERE r.status IN ('PROCESSING', 'UNKNOWN')
            AND r.nextQueryAt IS NULL AND r.queryAttempts >= ${MAX_ATTEMPTS})
      ) AS exhaustedRecoveries,
      (SELECT COUNT(*) FROM receipts r
        WHERE r.matchStatus = 'UNMATCHED'
          AND (r.paymentId IS NULL OR EXISTS (
            SELECT 1 FROM payments p JOIN orders o ON o.id = p.orderId AND o.deletedAt IS NULL
            WHERE p.id = r.paymentId))) AS unmatchedReceipts,
      (SELECT COUNT(*) FROM receipts r
        WHERE r.matchStatus = 'MISMATCH'
          AND (r.paymentId IS NULL OR EXISTS (
            SELECT 1 FROM payments p JOIN orders o ON o.id = p.orderId AND o.deletedAt IS NULL
            WHERE p.id = r.paymentId))) AS mismatchedReceipts,
      (SELECT COUNT(*) FROM payment_exceptions e
        WHERE e.status IN ('OPEN', 'PROCESSING')
          AND (e.orderId IS NULL OR EXISTS (
            SELECT 1 FROM orders o WHERE o.id = e.orderId AND o.deletedAt IS NULL))) AS openPaymentExceptions,
      (SELECT COUNT(*) FROM orders o
        WHERE o.deletedAt IS NULL AND o.status IN ('CREATED', 'PENDING')
          AND o.expirationError IS NOT NULL) AS expirationFailures,
      (SELECT COUNT(*) FROM admin_audit_logs l
        WHERE l.success = false AND l.createdAt >= ${since}) AS failedAdminActionsToday
  `;

  const row = rows[0] ?? [];
  return {
    applications: toNumber(row[0]),
    ordersToday: toNumber(row[1]),
    successfulToday: toNumber(row[2]),
    unknownPayments: toNumber(row[3]),
    pendingWebhooks: toNumber(row[4]),
    amountToday: toNumber(row[5]),
    recoveringPayments: toNumber(row[6]),
    recoveringRefunds: toNumber(row[7]),
    exhaustedRecoveries: toNumber(row[8]),
    unmatchedReceipts: toNumber(row[9]),
    mismatchedReceipts: toNumber(row[10]),
    openPaymentExceptions: toNumber(row[11]),
    expirationFailures: toNumber(row[12]),
    failedAdminActionsToday: toNumber(row[13]),
  };
}
