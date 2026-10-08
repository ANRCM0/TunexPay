"use client";

import { Button, Card, Input, Pagination, Select } from "@arco-design/web-react";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { nextSortState, type SortColumn } from "../lib/sort";
import { pageSlice } from "../lib/paging";

/**
 * 列表页的公共结构件。
 *
 * 对齐 MPAY 管理台的版式：筛选区是一张卡（标签在左、控件在右，32px 高，行距 8px），
 * 表格与分页在同一张卡里，分页右对齐并显示总数。
 */

/** 列表页整页容器：筛选 + 表格 + 分页同处一张卡，与 MPAY 一致。 */
export function ListPage({ children }: { children: React.ReactNode }) {
  return <Card className="list-page" bordered>{children}</Card>;
}

export function FilterCard({ children, onSearch, onReset, searchLabel = "查询" }: {
  children: React.ReactNode;
  onSearch: () => void;
  onReset: () => void;
  searchLabel?: string;
}) {
  return <div className="filter-card">
    <form onSubmit={(event) => { event.preventDefault(); onSearch(); }}>
      <div className="filter-grid">{children}</div>
      <div className="filter-footer">
        <Button type="primary" htmlType="submit">{searchLabel}</Button>
        <Button onClick={onReset}>重置</Button>
      </div>
    </form>
  </div>;
}

export function FilterItem({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="filter-item">
    <span className="filter-label">{label}</span>
    <span className="filter-control">{children}</span>
  </div>;
}

/** 带标签的输入框，宽度撑满筛选格 */
export function FilterInput({ value, onChange, placeholder, allowClear = true }: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  allowClear?: boolean;
}) {
  return <Input value={value} onChange={onChange} placeholder={placeholder} allowClear={allowClear} />;
}

export function FilterSelect({ value, onChange, options, placeholder }: {
  value: string;
  onChange: (value: string) => void;
  options: { label: string; value: string }[];
  placeholder?: string;
}) {
  return <Select value={value} onChange={onChange} options={options} placeholder={placeholder} />;
}

/** 表格 + 分页同卡：工具栏在表格上方，分页在表格下方，与 MPAY 一致。 */
export function ListCard({ toolbar, pagination, children }: {
  toolbar?: React.ReactNode;
  pagination?: React.ReactNode;
  children: React.ReactNode;
}) {
  return <div className="list-card">
    {toolbar && <div className="list-card-toolbar">{toolbar}</div>}
    {children}
    {pagination && <div className="list-card-pager">{pagination}</div>}
  </div>;
}

export function ToolbarNote({ children }: { children: React.ReactNode }) {
  return <span className="toolbar-note">{children}</span>;
}

export function ToolbarSpacer() {
  return <span className="toolbar-spacer" />;
}

/**
 * 客户端分页状态。
 *
 * 接口按 pageSize 一次取回（列表页规模在百条量级），分页在本地做：
 * 换页不重新请求，翻页是瞬时的；筛选或刷新导致行数变少时自动收敛页码。
 */
export function useClientPager<T>(rows: readonly T[], initialSize = 20) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(initialSize);
  const slice = useMemo(() => pageSlice(rows, page, pageSize), [rows, page, pageSize]);
  useEffect(() => { if (slice.page !== page) setPage(slice.page); }, [slice.page, page]);
  return {
    ...slice,
    setPage,
    pageSize,
    setPageSize: useCallback((size: number) => { setPageSize(size); setPage(1); }, []),
  };
}

/**
 * 服务端分页状态。仅当前页数据进浏览器，页码/条数变化由调用方构造 API URL。
 * 后端过滤条件可能使页数减少；收到真实 total 后收敛页码，避免长期停在空页。
 */
export function useServerPager(total: number | undefined, initialSize = 20) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(initialSize);
  useEffect(() => {
    if (total === undefined) return;
    const lastPage = Math.max(1, Math.ceil(total / pageSize));
    setPage(current => Math.min(current, lastPage));
  }, [total, pageSize]);

  return {
    page, pageSize, setPage,
    setPageSize: useCallback((size: number) => { setPageSize(size); setPage(1); }, []),
  };
}

/** 分页控件：总数 + 页码 + 每页条数，右对齐。 */
export function Pager({ total, page, pageSize, onChange, onPageSizeChange }: {
  total: number;
  page: number;
  pageSize: number;
  onChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
}) {
  return <Pagination
    className="list-pager"
    total={total}
    current={page}
    pageSize={pageSize}
    onChange={onChange}
    onPageSizeChange={onPageSizeChange}
    showTotal={(value: number) => `共 ${value} 条`}
    sizeCanChange
    sizeOptions={[10, 20, 50, 100]}
    size="small"
  />;
}

/** 排序状态：与 lib/sort 共用同一套规则，表格列头点击后调用。 */
export function useTableSort<T>() {
  const [sort, setSort] = useState(() => null as ReturnType<typeof nextSortState>);
  return {
    sort,
    onSort: useCallback((key: string) => setSort(current => nextSortState(current, key)), []),
  };
}

/**
 * Arco Table 列头用的排序按钮。
 *
 * 与旧版 SortableTh 共用同一套语义和提示文案，区别只是它渲染成一个按钮：
 * Arco 的列头单元格由 Table 自己渲染，调用方不能再往列头里塞表头元素，
 * 否则会产生非法的嵌套结构。
 */
export function sortHeader<T>(
  column: SortColumn<T>,
  sort: { key: string; direction: "asc" | "desc" } | null,
  onSort: (key: string) => void,
) {
  const active = sort?.key === column.key;
  const direction = active ? sort!.direction : null;
  const nextHint = direction === "asc" ? "切换为降序" : direction === "desc" ? "取消排序" : "按此列升序排序";
  return <button
    type="button"
    className={active ? "th-sort-button active" : "th-sort-button"}
    onClick={() => onSort(column.key)}
    aria-label={`${column.label}，${nextHint}`}
  >
    <span>{column.label}</span>
    <span className="th-sort-icon" aria-hidden="true">{direction === "asc" ? <ArrowUp size={12} /> : direction === "desc" ? <ArrowDown size={12} /> : <ArrowUpDown size={12} />}</span>
  </button>;
}
