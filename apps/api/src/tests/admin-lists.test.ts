import { describe, expect, it } from "vitest";
import { buildOrderListQuery, buildRefundListQuery } from "../lib/admin-lists.js";

describe("admin list queries", () => {
  it("keeps archived orders excluded and returns deterministic default order", () => {
    const result = buildOrderListQuery({});
    expect(result.where).toEqual({ deletedAt: null });
    expect(result.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
  });

  it("filters matching orders in the database, before pagination", () => {
    const result = buildOrderListQuery({ q: "  商户A  ", status: "SUCCESS", sortBy: "application", sortDir: "asc" });
    expect(result.where.status).toBe("SUCCESS");
    expect(result.where.OR).toHaveLength(4);
    expect(result.where.OR).toContainEqual({ application: { name: { contains: "商户A" } } });
    expect(result.orderBy).toEqual([{ application: { name: "asc" } }, { id: "desc" }]);
  });

  it("can filter refunds by payment or order subject", () => {
    const result = buildRefundListQuery({ q: "PAY123", status: "UNKNOWN", sortBy: "paymentNo" });
    expect(result.where.status).toBe("UNKNOWN");
    expect(result.where.OR).toContainEqual({ payment: { paymentNo: { contains: "PAY123" } } });
    expect(result.orderBy).toEqual([{ payment: { paymentNo: "desc" } }, { id: "desc" }]);
  });

  it("keeps archived refund records searchable and uses stable ordering", () => {
    const query = buildRefundListQuery({});
    // Refund history must remain visible even when an application has been archived.
    expect(query.where).toEqual({});
    expect(query.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
  });

  it("rejects invalid sort direction rather than forwarding unchecked input to Prisma", () => {
    expect(() => buildOrderListQuery({ sortDir: "drop-table" })).toThrow();
    expect(() => buildRefundListQuery({ sortDir: "sideways" })).toThrow();
  });

  it("rejects unknown columns, invalid statuses, and oversized search input", () => {
    expect(() => buildOrderListQuery({ sortBy: "password" })).toThrow();
    expect(() => buildRefundListQuery({ status: "DELETED" })).toThrow();
    expect(() => buildOrderListQuery({ q: "x".repeat(161) })).toThrow();
  });
});
