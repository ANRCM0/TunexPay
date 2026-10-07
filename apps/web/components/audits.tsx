"use client";

import { Button, Table } from "@arco-design/web-react";
import type { ColumnProps } from "@arco-design/web-react/es/Table";
import { useMemo, useState } from "react";
import { useApi } from "../lib/api";
import { sortRows, type SortColumn } from "../lib/sort";
import { auditActionLabel } from "../lib/labels";
import { LoadingState, PageHead, Status, sortValueProps, time } from "./common";
import { FilterCard, FilterItem, FilterSelect, ListCard, ListPage, Pager, ToolbarNote, useClientPager, useTableSort, sortHeader } from "./list";

type Audit = {
  id: string; actor: string; action: string; resourceType: string | null; resourceId: string | null;
  method: string; path: string; requestId: string | null; ipAddress: string | null; userAgent: string | null;
  success: boolean; statusCode: number; errorCode: string | null; createdAt: string;
};

const SORT_COLUMNS: SortColumn<Audit>[] = [
  { key: "action", label: "操作 / 资源" },
  // 结果列展示"成功/失败"徽章，排序必须用同一个布尔值，而不是 HTTP 状态码，
  // 否则"按结果排序"会把 409 排到 500 后面，与界面语义不符
  { key: "success", label: "结果", accessor: (row) => (row.success ? 1 : 0), type: "number" },
  { key: "path", label: "请求" },
  { key: "ipAddress", label: "来源" },
  { key: "createdAt", label: "时间", type: "date" },
];

// 用 "ALL" 哨兵而不是空串：Arco Select 把空串当成"没有选中"，标签会退化成占位符，
// 用哨兵才能让"全部结果"稳定显示成一个选项。
const RESULT_OPTIONS = [
  { label: "全部结果", value: "ALL" },
  { label: "成功", value: "true" },
  { label: "失败", value: "false" },
];

export function Audits() {
  const { sort, onSort } = useTableSort<Audit>();
  const [draftResult, setDraftResult] = useState("ALL");
  // 结果筛选仍然走服务端（接口支持 success 参数），但只在点「查询」时才换 URL：
  // 用户在下拉里逐项试选时不该连续触发三次请求。
  const [appliedResult, setAppliedResult] = useState("ALL");
  const path = `/audits?pageSize=100${appliedResult === "ALL" ? "" : `&success=${appliedResult}`}`;
  const { data, loading, error, reload } = useApi<Audit[]>(path, 10_000);
  // 服务端已经按结果筛过一轮，这里只需要在拿到的数据上排序、分页
  const rows = useMemo(() => sortRows(data ?? [], SORT_COLUMNS, sort), [data, sort]);
  const pager = useClientPager(rows, 20);

  const columns: ColumnProps<Audit>[] = [
    {
      title: sortHeader(SORT_COLUMNS[0], sort, onSort),
      dataIndex: "action",
      render: (_: unknown, item: Audit) => <span {...sortValueProps(item, SORT_COLUMNS[0])}>
        <strong>{auditActionLabel(item.action)}</strong>
        <div className="mono muted">{item.resourceType ?? "—"} · {item.resourceId ?? "—"}</div>
      </span>,
    },
    {
      title: sortHeader(SORT_COLUMNS[1], sort, onSort),
      dataIndex: "success",
      width: 170,
      render: (_: unknown, item: Audit) => <span {...sortValueProps(item, SORT_COLUMNS[1])}>
        <Status value={item.success ? "SUCCESS" : "FAILED"} />
        <div className="muted">HTTP {item.statusCode}{item.errorCode ? ` · ${item.errorCode}` : ""}</div>
      </span>,
    },
    {
      title: sortHeader(SORT_COLUMNS[2], sort, onSort),
      dataIndex: "path",
      render: (_: unknown, item: Audit) => <span {...sortValueProps(item, SORT_COLUMNS[2])}>
        <span className="mono">{item.method} {item.path}</span>
        <div className="mono muted">{item.requestId ?? "—"}</div>
      </span>,
    },
    {
      title: sortHeader(SORT_COLUMNS[3], sort, onSort),
      dataIndex: "ipAddress",
      width: 240,
      render: (_: unknown, item: Audit) => <span {...sortValueProps(item, SORT_COLUMNS[3])}>
        {item.ipAddress ?? "—"}
        <div className="audit-agent muted" title={item.userAgent ?? ""}>{item.userAgent ?? "—"}</div>
      </span>,
    },
    {
      title: sortHeader(SORT_COLUMNS[4], sort, onSort),
      dataIndex: "createdAt",
      width: 200,
      render: (_: unknown, item: Audit) => <span {...sortValueProps(item, SORT_COLUMNS[4])}>{time(item.createdAt)}</span>,
    },
  ];

  return <>
    <PageHead eyebrow="Security Audit" title="管理操作审计" copy="记录管理端变更操作、结果、来源地址和 Request ID；不会保存请求正文或密钥。" />
    <ListPage>
      <FilterCard
        onSearch={() => setAppliedResult(draftResult)}
        onReset={() => { setDraftResult("ALL"); setAppliedResult("ALL"); }}
      >
        <FilterItem label="操作结果">
          <FilterSelect value={draftResult} onChange={setDraftResult} options={RESULT_OPTIONS} />
        </FilterItem>
      </FilterCard>
      <LoadingState loading={loading} error={error} empty={!data?.length}>
        <ListCard
          toolbar={<><ToolbarNote>共 {rows.length} 条操作记录</ToolbarNote><span className="toolbar-spacer" /><Button size="small" onClick={() => void reload()}>刷新</Button></>}
          pagination={<Pager total={pager.total} page={pager.page} pageSize={pager.pageSize} onChange={pager.setPage} onPageSizeChange={pager.setPageSize} />}
        >
          <Table<Audit>
            className="list-table"
            columns={columns}
            data={pager.rows}
            rowKey="id"
            pagination={false}
            borderCell={false}
            loading={false}
            noDataElement={<div className="empty compact">没有符合筛选条件的审计记录</div>}
          />
        </ListCard>
      </LoadingState>
    </ListPage>
  </>;
}
