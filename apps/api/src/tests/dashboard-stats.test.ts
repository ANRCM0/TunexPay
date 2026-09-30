import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  paymentEventFindMany: vi.fn(),
}));

vi.mock("../db.js", () => {
  const count = async () => 0;
  return {
    db: {
      $queryRaw: mocks.queryRaw,
      paymentEvent: { findMany: mocks.paymentEventFindMany },
      // 下面这些是 admin 路由里其它 handler 用到的委托：这里只是让 mock 完整，
      // /dashboard 不会碰它们（本用例会断言其中任何一个都没有被调用）。
      application: { count, findMany: async () => [] },
      order: { count, findMany: async () => [] },
      payment: { count, findMany: async () => [] },
      refund: { count, findMany: async () => [] },
      webhookDelivery: { count, findMany: async () => [] },
      receipt: { count },
      paymentException: { count },
      adminAuditLog: { count, create: async () => ({}) },
    },
  };
});

import { app } from "../app.js";

/** Prisma 的 `db.$queryRaw` 是标签模板：第一个参数是字面量片段数组，其余是参数。 */
const AUTH = { Authorization: "Bearer development-admin-token-change-me" };

/** 一条 SELECT，14 个标量子查询，列顺序固定（与 lib/dashboard-stats.ts 一致）。 */
const ROW = [
  7n, // applications
  { toNumber: () => 31 }, // ordersToday —— Decimal 形态
  12, // successfulToday
  2n, // unknownPayments
  { toNumber: () => 5 }, // pendingWebhooks
  { toNumber: () => 12345 }, // amountToday —— SUM 在 MySQL 下是 Decimal
  3n, // recoveringPayments
  1n, // recoveringRefunds
  4n, // exhaustedRecoveries（payment 侧 2 + refund 侧 2，SQL 里已相加）
  6n, // unmatchedReceipts
  8n, // mismatchedReceipts
  9n, // openPaymentExceptions
  10n, // expirationFailures
  { toNumber: () => 2 }, // failedAdminActionsToday
];

function dashboard() {
  return app.request("/admin/v1/dashboard", { headers: AUTH });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.queryRaw.mockResolvedValue([ROW]);
  mocks.paymentEventFindMany.mockResolvedValue(
    Array.from({ length: 12 }, (_, index) => ({ id: BigInt(100 - index), type: "PAYMENT_SUCCEEDED" })),
  );
});

describe("GET /admin/v1/dashboard", () => {
  it("requires the admin token", async () => {
    const response = await app.request("/admin/v1/dashboard");
    expect(response.status).toBe(401);
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });

  it("maps the single aggregate row onto the 14 counters with plain numbers", async () => {
    const response = await dashboard();
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.data).toEqual({
      applications: 7,
      ordersToday: 31,
      successfulToday: 12,
      unknownPayments: 2,
      pendingWebhooks: 5,
      amountToday: 12345,
      recoveringPayments: 3,
      recoveringRefunds: 1,
      exhaustedRecoveries: 4,
      unmatchedReceipts: 6,
      mismatchedReceipts: 8,
      openPaymentExceptions: 9,
      expirationFailures: 10,
      failedAdminActionsToday: 2,
      recentEvents: expect.any(Array),
    });

    // 字段名、数量都不能变（响应契约）。
    expect(Object.keys(body.data)).toHaveLength(15);
    for (const field of [
      "applications", "ordersToday", "successfulToday", "unknownPayments", "pendingWebhooks", "amountToday",
      "recoveringPayments", "recoveringRefunds", "exhaustedRecoveries", "unmatchedReceipts", "mismatchedReceipts",
      "openPaymentExceptions", "expirationFailures", "failedAdminActionsToday",
    ]) {
      expect(typeof body.data[field], field).toBe("number");
    }
  });

  it("serializes BigInt/Decimal results instead of throwing (no bigint left in the body)", async () => {
    mocks.queryRaw.mockResolvedValue([ROW]);
    const response = await dashboard();
    // 若 BigInt 逃到 JSON.stringify，这里会是 500（Do not know how to serialize a BigInt）。
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain("Do not know how to serialize");
    expect(JSON.parse(text).data.applications).toBe(7);
  });

  it("issues exactly one raw aggregate query for the whole dashboard", async () => {
    await dashboard();
    expect(mocks.queryRaw).toHaveBeenCalledTimes(1);

    const [template, ...params] = mocks.queryRaw.mock.calls[0] as [string[], ...unknown[]];
    const sql = template.join("?");
    expect(template.length).toBeGreaterThan(1);
    // 8 张表都在同一条语句里。
    for (const table of ["applications", "orders", "payments", "refunds", "webhook_deliveries", "receipts", "payment_exceptions", "admin_audit_logs"]) {
      expect(sql, table).toContain(`FROM ${table}`);
    }
    // 标签模板：实参 = [字面量片段(7), 插值(6)]；插值顺序 = 4× 今天零点 + 2× RECOVERY_MAX_ATTEMPTS。
    // 枚举取值都是内联字面量，不能走占位符（会被 Prisma 变成 `IN (?)`）。
    expect(template).toHaveLength(7);
    expect(params).toHaveLength(6);
    expect(params).toEqual([
      expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/),
      expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/),
      expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/),
      20,
      20,
      expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/),
    ]);
    // Date 绝不能进标签模板（会被字符串化成 "Mon Sep 30 2026 ..."，MySQL 解析不了）。
    expect(params.filter(parameter => parameter instanceof Date)).toHaveLength(0);
    // 关系过滤必须是内连接语义，不能退化成 LEFT JOIN + WHERE。
    expect(sql).toContain("JOIN orders o ON o.id = p.orderId AND o.deletedAt IS NULL");
    expect(sql).not.toContain("LEFT JOIN");
    expect(sql).not.toContain("$queryRawUnsafe");
  });

  it("passes the server-local midnight as a UTC datetime literal", async () => {
    await dashboard();
    const expected = new Date();
    expected.setHours(0, 0, 0, 0);
    // Prisma 对 MySQL 的 DATETIME 按 UTC 存取，所以边界必须换算成 UTC 字面量。
    const expectedText = expected.toISOString().replace("T", " ").replace("Z", "");
    const [, ...params] = mocks.queryRaw.mock.calls[0] as [string[], ...unknown[]];
    const stamps = params.filter((parameter): parameter is string => typeof parameter === "string");
    expect(stamps).toHaveLength(4);
    for (const stamp of stamps) expect(stamp).toBe(expectedText);
  });

  it("keeps recentEvents on its own Prisma query, still taking 12 rows", async () => {
    const response = await dashboard();
    const body = await response.json();
    expect(body.data.recentEvents).toHaveLength(12);
    expect(mocks.paymentEventFindMany).toHaveBeenCalledTimes(1);
    expect(mocks.paymentEventFindMany).toHaveBeenCalledWith({
      where: { OR: [{ order: { deletedAt: null } }, { order: null }] },
      orderBy: { id: "desc" },
      take: 12,
    });
  });

  it("falls back to zero for every counter when the aggregate returns no row or NULLs", async () => {
    mocks.queryRaw.mockResolvedValue([]);
    const empty = await (await dashboard()).json();
    expect(empty.data.applications).toBe(0);
    expect(empty.data.amountToday).toBe(0);
    expect(empty.data.failedAdminActionsToday).toBe(0);

    // MySQL 的 SUM 无匹配行时返回 NULL。
    mocks.queryRaw.mockResolvedValue([ROW.map((value, index) => (index === 5 ? null : value))]);
    const nullSum = await (await dashboard()).json();
    expect(nullSum.data.amountToday).toBe(0);
    expect(nullSum.data.applications).toBe(7);
  });

  it("uses BigInt-safe conversion even for very large counts", async () => {
    const large = ROW.map(() => 9007199254740993n);
    mocks.queryRaw.mockResolvedValue([large]);
    const body = await (await dashboard()).json();
    expect(body.data.applications).toBe(9007199254740992);
    expect(typeof body.data.applications).toBe("number");
  });
});
