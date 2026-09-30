/**
 * 性能改动的只读验收脚本：确认 6 个新索引存在，并检查关键查询确实走索引。
 *
 * 用法（在 apps/api 目录下）：
 *   npx tsx src/scripts/verify-indexes.ts [--min-rows 500] [--help]
 *
 * 安全性：**本脚本只做 SELECT 与 EXPLAIN，不写任何数据**，因此可以在生产库上直接跑。
 *
 * 为什么需要 --min-rows：表很小时 MySQL 会直接全表扫描（哪怕索引完全正确），
 * EXPLAIN 会给出 type=ALL 的假阴性。行数低于阈值时脚本给 SKIP 而不是 FAIL，
 * 提示先用真实数据（或压测数据）再跑。
 */
import { db } from "../db.js";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("Usage: npx tsx src/scripts/verify-indexes.ts [--min-rows 500]");
  console.log("只读检查：新索引是否存在 + 关键查询是否走索引。默认 min-rows=500。");
  process.exit(0);
}
const requestedMinRows = Number(args[args.indexOf("--min-rows") + 1]);
const minRows = Number.isFinite(requestedMinRows) && requestedMinRows > 0 ? requestedMinRows : 500;
if (!process.env.DATABASE_URL) {
  console.error("未设置 DATABASE_URL。请在部署机上加载 .env（set -a; . ./.env; set +a），或容器内执行：docker compose exec app npx tsx src/scripts/verify-indexes.ts");
  process.exit(1);
}

/** 期望存在的索引：表 → 索引名 → 列顺序（与 prisma/schema.prisma 一致）。 */
const EXPECTED_INDEXES: Record<string, Record<string, string>> = {
  orders: {
    orders_deletedAt_createdAt_idx: "deletedAt,createdAt",
    orders_deletedAt_paidAt_idx: "deletedAt,paidAt",
  },
  payments: { payments_status_paidAt_idx: "status,paidAt" },
  refunds: { refunds_createdAt_id_idx: "createdAt,id" },
  webhook_deliveries: { webhook_deliveries_createdAt_id_idx: "createdAt,id" },
  receipts: { receipts_occurredAt_id_idx: "occurredAt,id" },
};

type ExplainRow = { table: string | null; type: string; key: string | null; rows: unknown; Extra: string };
type IndexRow = { TABLE_NAME: string; INDEX_NAME: string; cols: string };

let failures = 0;
let skipped = 0;

function normalize(value: string): string {
  return value.replaceAll(" ", "").toLowerCase();
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return Number(value ?? 0) || 0;
}

function report(status: "PASS" | "FAIL" | "SKIP", title: string, detail: string): void {
  if (status === "FAIL") failures += 1;
  if (status === "SKIP") skipped += 1;
  console.log(`[${status}] ${title}\n        ${detail}`);
}

/** 表名是本文件内的常量，不接受外部输入，因此不需要动态拼 SQL。 */
const countQuery: Record<string, () => Promise<Array<{ n: unknown }>>> = {
  orders: () => db.$queryRaw<Array<{ n: unknown }>>`SELECT COUNT(*) AS n FROM orders`,
  payments: () => db.$queryRaw<Array<{ n: unknown }>>`SELECT COUNT(*) AS n FROM payments`,
  refunds: () => db.$queryRaw<Array<{ n: unknown }>>`SELECT COUNT(*) AS n FROM refunds`,
  webhook_deliveries: () => db.$queryRaw<Array<{ n: unknown }>>`SELECT COUNT(*) AS n FROM webhook_deliveries`,
  receipts: () => db.$queryRaw<Array<{ n: unknown }>>`SELECT COUNT(*) AS n FROM receipts`,
};

async function countRows(table: string): Promise<number> {
  const query = countQuery[table];
  if (!query) throw new Error(`未登记的检查表名：${table}`);
  const rows = await query();
  return toNumber(rows[0]?.n);
}

async function checkIndexes(): Promise<void> {
  const rows = await db.$queryRaw<IndexRow[]>`
    SELECT TABLE_NAME, INDEX_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
    GROUP BY TABLE_NAME, INDEX_NAME
  `;
  const found = new Map(rows.map(row => [`${row.TABLE_NAME}.${row.INDEX_NAME}`, row.cols]));
  for (const [table, indexes] of Object.entries(EXPECTED_INDEXES)) {
    for (const [name, columns] of Object.entries(indexes)) {
      const actual = found.get(`${table}.${name}`);
      if (actual === undefined) {
        report("FAIL", `索引缺失 ${name}`, `表 ${table} 上找不到该索引；迁移 202609180001_query_indexes 可能没有应用`);
      } else if (normalize(actual) !== normalize(columns)) {
        report("FAIL", `索引列序不符 ${name}`, `期望 (${columns})，实际 (${actual})`);
      } else {
        report("PASS", `索引存在 ${name}`, `(${actual})`);
      }
    }
  }
}

/**
 * 跑一次 EXPLAIN 并判断是否走了期望索引。
 * 表行数不足 minRows 时给 SKIP，避免小表全表扫描造成的假阴性。
 */
async function explain(title: string, table: string, expectedIndex: string, plan: Promise<ExplainRow[]>, expectOrdered = false): Promise<void> {
  const total = await countRows(table);
  const rows = await plan;
  const row = rows.find(item => item.table === table) ?? rows[0];
  if (!row) return report("FAIL", title, "EXPLAIN 没有返回该表的执行计划");
  const summary = `type=${row.type} key=${row.key ?? "NULL"} rows≈${toNumber(row.rows)} Extra=${row.Extra || "-"}`;
  if (total < minRows) return report("SKIP", title, `表 ${table} 只有 ${total} 行（< ${minRows}），EXPLAIN 结论不可信。${summary}`);
  if (row.type === "ALL") return report("FAIL", title, `退化为全表扫描。${summary}`);
  if (expectOrdered && /Using filesort/i.test(row.Extra)) return report("FAIL", title, `仍需要 filesort。${summary}`);
  if (normalize(row.key ?? "") !== normalize(expectedIndex)) return report("FAIL", title, `没有使用期望索引 ${expectedIndex}。${summary}`);
  report("PASS", title, summary);
}

try {
  const connection = new URL(process.env.DATABASE_URL ?? "mysql://unknown");
  console.log(`目标数据库：${connection.host}${connection.pathname}（只读检查，不会写入任何数据）\n`);

  console.log("== 1/2 索引存在性与列序 ==");
  await checkIndexes();

  console.log("\n== 2/2 关键查询的执行计划 ==");
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  // 与 lib/dashboard-stats.ts 一致：Prisma 对 MySQL 的 DATETIME 按 UTC 存取。
  const sinceText = since.toISOString().replace("T", " ").replace("Z", "");

  await explain("总览·今日实收（orders.paidAt）", "orders", "orders_deletedAt_paidAt_idx",
    db.$queryRaw<ExplainRow[]>`EXPLAIN SELECT COUNT(*) FROM orders WHERE deletedAt IS NULL AND paidAt >= ${sinceText}`);
  await explain("总览·今日订单（orders.createdAt）", "orders", "orders_deletedAt_createdAt_idx",
    db.$queryRaw<ExplainRow[]>`EXPLAIN SELECT COUNT(*) FROM orders WHERE deletedAt IS NULL AND createdAt >= ${sinceText}`);
  await explain("总览·今日成功金额（payments.status + paidAt）", "payments", "payments_status_paidAt_idx",
    db.$queryRaw<ExplainRow[]>`EXPLAIN SELECT SUM(amount) FROM payments WHERE status = 'SUCCESS' AND paidAt >= ${sinceText}`);
  await explain("订单列表（deletedAt + createdAt 倒序）", "orders", "orders_deletedAt_createdAt_idx",
    db.$queryRaw<ExplainRow[]>`EXPLAIN SELECT id FROM orders WHERE deletedAt IS NULL ORDER BY createdAt DESC, id DESC LIMIT 25`, true);
  await explain("退款列表（createdAt 倒序）", "refunds", "refunds_createdAt_id_idx",
    db.$queryRaw<ExplainRow[]>`EXPLAIN SELECT id FROM refunds ORDER BY createdAt DESC, id DESC LIMIT 25`, true);
  await explain("通知列表（createdAt 倒序）", "webhook_deliveries", "webhook_deliveries_createdAt_id_idx",
    db.$queryRaw<ExplainRow[]>`EXPLAIN SELECT id FROM webhook_deliveries ORDER BY createdAt DESC, id DESC LIMIT 25`, true);
  await explain("对账流水（occurredAt 倒序，不筛状态）", "receipts", "receipts_occurredAt_id_idx",
    db.$queryRaw<ExplainRow[]>`EXPLAIN SELECT id FROM receipts ORDER BY occurredAt DESC, id DESC LIMIT 25`, true);

  console.log(`\n结果：失败 ${failures} 项，跳过 ${skipped} 项。`);
  if (skipped) console.log("跳过的项是因为表行数不足；请在有真实数据的库上重跑。");
  if (failures) process.exitCode = 1;
} catch (error) {
  console.error("检查无法完成：", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
