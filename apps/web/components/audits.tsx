"use client";

import { useState } from "react";
import { useApi } from "../lib/api";
import { LoadingState, PageHead, Section, Status, time } from "./common";
import { auditActionLabel } from "../lib/labels";

type Audit = {
  id: string; actor: string; action: string; resourceType: string | null; resourceId: string | null;
  method: string; path: string; requestId: string | null; ipAddress: string | null; userAgent: string | null;
  success: boolean; statusCode: number; errorCode: string | null; createdAt: string;
};

export function Audits() {
  const [result, setResult] = useState("");
  const path = `/audits?pageSize=100${result ? `&success=${result}` : ""}`;
  const { data, loading, error } = useApi<Audit[]>(path, 10_000);
  const resultFilter = <select value={result} onChange={event => setResult(event.target.value)} aria-label="操作结果">
    <option value="">全部结果</option><option value="true">成功</option><option value="false">失败</option>
  </select>;
  return <>
    <PageHead eyebrow="Security Audit" title="管理操作审计" copy="记录管理端变更操作、结果、来源地址和 Request ID；不会保存请求正文或密钥。" />
    <Section title="最近操作" action={resultFilter}>
      <LoadingState loading={loading} error={error} empty={!data?.length}>
        <div className="table-wrap"><table>
          <thead><tr><th>操作 / 资源</th><th>结果</th><th>请求</th><th>来源</th><th>时间</th></tr></thead>
          <tbody>{data?.map(item => <tr key={item.id}>
            <td><strong>{auditActionLabel(item.action)}</strong><div className="mono muted">{item.resourceType ?? "—"} · {item.resourceId ?? "—"}</div></td>
            <td data-label="结果"><Status value={item.success ? "SUCCESS" : "FAILED"} /><div className="muted">HTTP {item.statusCode}{item.errorCode ? ` · ${item.errorCode}` : ""}</div></td>
            <td data-label="请求"><span className="mono">{item.method} {item.path}</span><div className="mono muted">{item.requestId ?? "—"}</div></td>
            <td data-label="来源">{item.ipAddress ?? "—"}<div className="audit-agent muted" title={item.userAgent ?? ""}>{item.userAgent ?? "—"}</div></td>
            <td data-label="时间">{time(item.createdAt)}</td>
          </tr>)}</tbody>
        </table></div>
      </LoadingState>
    </Section>
  </>;
}
