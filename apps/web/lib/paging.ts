/**
 * 分页切片。
 *
 * 抽出来是为了能测边界：页码越界、页大小变化、空列表这三种情况出错时
 * 界面只会显示空白表格，很难从现象上看出是分页算错了。
 */
export type PageSlice<T> = {
  rows: T[];
  total: number;
  page: number;
  pageCount: number;
};

export function pageSlice<T>(rows: readonly T[], page: number, pageSize: number): PageSlice<T> {
  const total = rows.length;
  const safeSize = Math.max(1, Math.floor(pageSize) || 1);
  const pageCount = Math.max(1, Math.ceil(total / safeSize));
  // 数据变少（筛选、刷新）时当前页可能越界，收敛到最后一页而不是显示空表
  const safePage = Math.min(Math.max(1, Math.floor(page) || 1), pageCount);
  const start = (safePage - 1) * safeSize;
  return { rows: rows.slice(start, start + safeSize), total, page: safePage, pageCount };
}
