/**
 * 性能改动的只读验收脚本：确认 6 个新索引存在，并检查关键查询确实走索引。
 *
 * 用法（在 apps/api 目录下）：
 *   npx tsx src/scripts/verify-indexes.ts [--min-rows 500] [--help]
 *
 * 安全性：**本脚本只做 SELECT 与 EXPLAIN，不写任何数据**，因此可以在生产库上直接跑。
 *
 * 两级判定：
 *   1) 表行数 >= --min-rows：判断优化器是否真的选了期望索引（PLAN 判定）。
 *   2) 表行数较小：优化器会（正确地）选择全表扫描，此时判定无意义，于是退化为
 *      `FORCE INDEX` 探针 —— 只验证「该索引对这种查询形态可用、且不需要 filesort」。
 *      列序写错、索引与谓词不匹配这类错误在这一级就能暴露。
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
  console.error("未设置 DATABASE_URL。请在部署机上加载 .env（set -a; . ./.env; set +a），或容器内执行：docker compose exec app npx tsx apps/api/src/scripts/verify-indexes.ts");
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

type RawRow = Record<string, unknown>;
type IndexRow = { TABLE_NAME: string; INDEX_NAME: string; cols: string };
type Plan = { plain: Promise<RawRow[]>; forced?: Promise<RawRow[]> };

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

function report(status: "PASS" | "FAIL" | "SKIP", title: string, detail = ""): void {
  if (status === "FAIL") failures += 1;
  if (status === "SKIP") skipped += 1;
  console.log(`[${status}]  ${title}${detail ? `\n        ${detail}` : ""}`);
}

/**
 * EXPLAIN 结果的列名大小写不一定和小写文档一致（实测 MySQL 8.4 + Prisma 下
 * 直接取 `row.type` 得到的是 undefined），所以统一按不区分大小写读取。
 */
function hasColumn(row: RawRow, name: string): boolean {
  const wanted = name.toLowerCase();
  return Object.keys(row).some(key => key.toLowerCase() === wanted);
}

function field(row: RawRow, name: string): unknown {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(row)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

/** 表名是本文件内的常量，不接受外部输入，因此不需要动态拼 SQL。 */
const countQuery: Record<string, () => Promise<RawRow[]>> = {
  orders: () => db.$queryRaw<RawRow[]>`SELECT COUNT(*) AS n FROM orders`,
  payments: () => db.$queryRaw<RawRow[]>`SELECT COUNT(*) AS n FROM payments`,
  refunds: () => db.$queryRaw<RawRow[]>`SELECT COUNT(*) AS n FROM refunds`,
  webhook_deliveries: () => db.$queryRaw<RawRow[]>`SELECT COUNT(*) AS n FROM webhook_deliveries`,
  receipts: () => db.$queryRaw<RawRow[]>`SELECT COUNT(*) AS n FROM receipts`,
};

async function countRows(table: string): Promise<number> {
  const query = countQuery[table];
  if (!query) throw new Error(`未登记的检查表名：${table}`);
  const rows = await query();
  const row = rows[0] ?? {};
  return toNumber(hasColumn(row, "n") ? field(row, "n") : Object.values(row)[0]);
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

function readPlan(rows: RawRow[], table: string): RawRow | undefined {
  return rows.find(item => field(item, "table") === table) ?? rows[0];
}

function summarize(row: RawRow): string {
  const type = String(field(row, "type") ?? "");
  const key = field(row, "key");
  const extra = String(field(row, "Extra") ?? "");
  return `type=${type || "NULL"} key=${key == null ? "NULL" : String(key)} rows≈${toNumber(field(row, "rows"))} Extra=${extra || "-"}`;
}

/**
 * 表行数足够时：判断优化器是否真的选了期望索引。
 * 表行数不足时：退化为 FORCE INDEX 可用性探针（只证明索引对这种查询形态可用）。
 */
async function explain(title: string, table: string, expectedIndex: string, plan: Plan, expectOrdered = false): Promise<void> {
  const total = await countRows(table);
  const row = readPlan(await plan.plain, table);
  if (!row) return report("FAIL", title, "EXPLAIN 没有返回执行计划");
  // 解析失败必须说清楚：以前把 undefined 直接拼进字符串，看起来像「计划里没用索引」，
  // 实际是结果列名没对上。
  if (!hasColumn(row, "key") || !hasColumn(row, "type")) {
    return report("FAIL", title, `无法解析 EXPLAIN 结果列，实际列名：${Object.keys(row).join(", ")}`);
  }
  if (total < minRows) return probeForcedIndex(title, table, expectedIndex, plan, expectOrdered, total, row);
  const type = String(field(row, "type") ?? "");
  const key = field(row, "key");
  const extra = String(field(row, "Extra") ?? "");
  const summary = summarize(row);
  if (type === "ALL") return report("FAIL", title, `退化为全表扫描。${summary}`);
  if (expectOrdered && /Using filesort/i.test(extra)) return report("FAIL", title, `仍需要 filesort。${summary}`);
  if (normalize(String(key ?? "")) !== normalize(expectedIndex)) return report("FAIL", title, `没有使用期望索引 ${expectedIndex}。${summary}`);
  report("PASS", title, summary);
}

/** 小表退化路径：优化器不选索引是正常的，所以只证明索引可用。 */
async function probeForcedIndex(title: string, table: string, expectedIndex: string, plan: Plan, expectOrdered: boolean, total: number, plainRow: RawRow): Promise<void> {
  const hint = `表 ${table} 只有 ${total} 行（< ${minRows}），优化器选全表扫描是正常的：${summarize(plainRow)}`;
  if (!plan.forced) return report("SKIP", title, `${hint}（本项没有 FORCE INDEX 探针）`);
  const row = readPlan(await plan.forced, table);
  if (!row) return report("FAIL", title, "FORCE INDEX 的 EXPLAIN 没有返回执行计划");
  const key = field(row, "key");
  const extra = String(field(row, "Extra") ?? "");
  const summary = summarize(row);
  if (normalize(String(key ?? "")) !== normalize(expectedIndex)) {
    return report("FAIL", title, `FORCE INDEX ${expectedIndex} 未被采用，索引与查询形态不匹配。${summary}`);
  }
  if (expectOrdered && /Using filesort/i.test(extra)) {
    return report("FAIL", title, `FORCE INDEX ${expectedIndex} 后仍需要 filesort，列序可能不对。${summary}`);
  }
  report("PASS", title, `索引对该查询形态可用（FORCE INDEX 探针）。${summary}`);
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

  await explain("总览·今日实收（orders.paidAt）", "orders", "orders_deletedAt_paidAt_idx", {
    plain: db.$queryRaw<RawRow[]>`EXPLAIN SELECT COUNT(*) FROM orders WHERE deletedAt IS NULL AND paidAt >= ${sinceText}`,
    forced: db.$queryRaw<RawRow[]>`EXPLAIN SELECT COUNT(*) FROM orders FORCE INDEX (orders_deletedAt_paidAt_idx) WHERE deletedAt IS NULL AND paidAt >= ${sinceText}`,
  });
  await explain("总览·今日订单（orders.createdAt）", "orders", "orders_deletedAt_createdAt_idx", {
    plain: db.$queryRaw<RawRow[]>`EXPLAIN SELECT COUNT(*) FROM orders WHERE deletedAt IS NULL AND createdAt >= ${sinceText}`,
    forced: db.$queryRaw<RawRow[]>`EXPLAIN SELECT COUNT(*) FROM orders FORCE INDEX (orders_deletedAt_createdAt_idx) WHERE deletedAt IS NULL AND createdAt >= ${sinceText}`,
  });
  await explain("总览·今日成功金额（payments.status + paidAt）", "payments", "payments_status_paidAt_idx", {
    plain: db.$queryRaw<RawRow[]>`EXPLAIN SELECT SUM(amount) FROM payments WHERE status = 'SUCCESS' AND paidAt >= ${sinceText}`,
    forced: db.$queryRaw<RawRow[]>`EXPLAIN SELECT SUM(amount) FROM payments FORCE INDEX (payments_status_paidAt_idx) WHERE status = 'SUCCESS' AND paidAt >= ${sinceText}`,
  });
  await explain("订单列表（deletedAt + createdAt 倒序）", "orders", "orders_deletedAt_createdAt_idx", {
    plain: db.$queryRaw<RawRow[]>`EXPLAIN SELECT id FROM orders WHERE deletedAt IS NULL ORDER BY createdAt DESC, id DESC LIMIT 25`,
    forced: db.$queryRaw<RawRow[]>`EXPLAIN SELECT id FROM orders FORCE INDEX (orders_deletedAt_createdAt_idx) WHERE deletedAt IS NULL ORDER BY createdAt DESC, id DESC LIMIT 25`,
  }, true);
  await explain("退款列表（createdAt 倒序）", "refunds", "refunds_createdAt_id_idx", {
    plain: db.$queryRaw<RawRow[]>`EXPLAIN SELECT id FROM refunds ORDER BY createdAt DESC, id DESC LIMIT 25`,
    forced: db.$queryRaw<RawRow[]>`EXPLAIN SELECT id FROM refunds FORCE INDEX (refunds_createdAt_id_idx) ORDER BY createdAt DESC, id DESC LIMIT 25`,
  }, true);
  await explain("通知列表（createdAt 倒序）", "webhook_deliveries", "webhook_deliveries_createdAt_id_idx", {
    plain: db.$queryRaw<RawRow[]>`EXPLAIN SELECT id FROM webhook_deliveries ORDER BY createdAt DESC, id DESC LIMIT 25`,
    forced: db.$queryRaw<RawRow[]>`EXPLAIN SELECT id FROM webhook_deliveries FORCE INDEX (webhook_deliveries_createdAt_id_idx) ORDER BY createdAt DESC, id DESC LIMIT 25`,
  }, true);
  await explain("对账流水（occurredAt 倒序，不筛状态）", "receipts", "receipts_occurredAt_id_idx", {
    plain: db.$queryRaw<RawRow[]>`EXPLAIN SELECT id FROM receipts ORDER BY occurredAt DESC, id DESC LIMIT 25`,
    forced: db.$queryRaw<RawRow[]>`EXPLAIN SELECT id FROM receipts FORCE INDEX (receipts_occurredAt_id_idx) ORDER BY occurredAt DESC, id DESC LIMIT 25`,
  }, true);

  console.log(`\n结果：失败 ${failures} 项，跳过 ${skipped} 项。`);
  if (skipped) console.log("跳过的项表示连 FORCE INDEX 探针也拿不到结论，请在表变大后重跑。");
  if (failures) process.exitCode = 1;
} catch (error) {
  console.error("检查无法完成：", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
