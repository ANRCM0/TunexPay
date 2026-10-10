import { describe, expect, it } from "vitest";
import { transactionListPath } from "./transaction-list";

describe("transactionListPath", () => {
  it("requests the correct remote page without asking for all records", () => {
    expect(transactionListPath("orders", { page: 7, pageSize: 20, query: "", status: "ALL", sort: null }))
      .toBe("/orders?page=7&pageSize=20");
  });

  it("encodes submitted filters and cross-page sorting", () => {
    expect(transactionListPath("refunds", {
      page: 2, pageSize: 50, query: "  商户 A&B  ", status: "UNKNOWN",
      sort: { key: "amount", direction: "asc" },
    })).toBe("/refunds?page=2&pageSize=50&q=%E5%95%86%E6%88%B7+A%26B&status=UNKNOWN&sortBy=amount&sortDir=asc");
  });

  it("does not send a partial empty query", () => {
    expect(transactionListPath("orders", { page: 1, pageSize: 10, query: "   ", status: "ALL", sort: null }))
      .toBe("/orders?page=1&pageSize=10");
  });
});
