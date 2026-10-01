"use client";

import { useMemo, useState } from "react";
import { useApi } from "../lib/api";
import { nextSortState, sortRows, type SortColumn } from "../lib/sort";
import { LoadingState, PageHead, Section, SortableTh, Status, sortValueProps, time } from "./common";
import { auditActionLabel } from "../lib/labels";

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

export function Audits() {
  const [sort, setSort] = useState(() => null as ReturnType<typeof nextSortState>);
  const [result, setResult] = useState("");
  const path = `/audits?pageSize=100${result ? `&success=${result}` : ""}`;
  const { data, loading, error } = useApi<Audit[]>(path, 10_000);
  // 结果筛选走服务端（改变请求 URL），排序在返回的数据上做
  const rows = useMemo(() => sortRows(data ?? [], SORT_COLUMNS, sort), [data, sort]);
  const resultFilter = <select value={result} onChange={event => setResult(event.target.value)} aria-label="操作结果">
    <option value="">全部结果</option><option value="true">成功</option><option value="false">失败</option>
  </select>;
  return <>
    <PageHead eyebrow="Security Audit" title="管理操作审计" copy="记录管理端变更操作、结果、来源地址和 Request ID；不会保存请求正文或密钥。" />
    <Section title="最近操作" action={resultFilter}>
      <LoadingState loading={loading} error={error} empty={!data?.length}>
        <div className="table-wrap"><table>
          <thead><tr>
            <SortableTh label="操作 / 资源" sortKey="action" sort={sort} onSort={key => setSort(nextSortState(sort, key))} />
            <SortableTh label="结果" sortKey="success" sort={sort} onSort={key => setSort(nextSortState(sort, key))} />
            <SortableTh label="请求" sortKey="path" sort={sort} onSort={key => setSort(nextSortState(sort, key))} />
            <SortableTh label="来源" sortKey="ipAddress" sort={sort} onSort={key => setSort(nextSortState(sort, key))} />
            <SortableTh label="时间" sortKey="createdAt" sort={sort} onSort={key => setSort(nextSortState(sort, key))} />
          </tr></thead>
          <tbody>{rows.map(item => <tr key={item.id}>
            <td {...sortValueProps(item, SORT_COLUMNS[0])}><strong>{auditActionLabel(item.action)}</strong><div className="mono muted">{item.resourceType ?? "—"} · {item.resourceId ?? "—"}</div></td>
            <td data-label="结果" {...sortValueProps(item, SORT_COLUMNS[1])}><Status value={item.success ? "SUCCESS" : "FAILED"} /><div className="muted">HTTP {item.statusCode}{item.errorCode ? ` · ${item.errorCode}` : ""}</div></td>
            <td data-label="请求" {...sortValueProps(item, SORT_COLUMNS[2])}><span className="mono">{item.method} {item.path}</span><div className="mono muted">{item.requestId ?? "—"}</div></td>
            <td data-label="来源" {...sortValueProps(item, SORT_COLUMNS[3])}>{item.ipAddress ?? "—"}<div className="audit-agent muted" title={item.userAgent ?? ""}>{item.userAgent ?? "—"}</div></td>
            <td data-label="时间" {...sortValueProps(item, SORT_COLUMNS[4])}>{time(item.createdAt)}</td>
          </tr>)}</tbody>
        </table></div>
      </LoadingState>
    </Section>
  </>;
}
