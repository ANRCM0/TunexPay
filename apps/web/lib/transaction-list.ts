import type { SortState } from "./sort";

export type TransactionListOptions = {
  page: number;
  pageSize: number;
  query: string;
  status: string;
  sort: SortState;
};

/** 参数白名单与后端 admin-lists.ts 保持一致；筛选草稿不会直接驱动网络请求。 */
export function transactionListPath(resource: "orders" | "refunds", options: TransactionListOptions): string {
  const params = new URLSearchParams({
    page: String(options.page),
    pageSize: String(options.pageSize),
  });
  const q = options.query.trim();
  if (q) params.set("q", q);
  if (options.status !== "ALL") params.set("status", options.status);
  if (options.sort) {
    params.set("sortBy", options.sort.key);
    params.set("sortDir", options.sort.direction);
  }
  return `/${resource}?${params.toString()}`;
}
