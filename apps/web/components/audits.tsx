"use client";

import { useState } from "react";
import { useApi } from "../lib/api";
import { LoadingState, PageHead, Status, time } from "./common";

type Audit = {
  id: string; actor: string; action: string; resourceType: string | null; resourceId: string | null;
  method: string; path: string; requestId: string | null; ipAddress: string | null; userAgent: string | null;
  success: boolean; statusCode: number; errorCode: string | null; createdAt: string;
};

export function Audits() {
  const [result, setResult] = useState("");
  const path = `/audits?pageSize=100${result ? `&success=${result}` : ""}`;
  const { data, loading, error } = useApi<Audit[]>(path, 10_000);
  return <>
    <PageHead eyebrow="Security Audit" title="管理操作审计" copy="记录管理端变更操作、结果、来源地址和 Request ID；不会保存请求正文或密钥。" />
    <section className="card section">
      <div className="section-title"><h2>最近操作</h2><select value={result} onChange={event => setResult(event.target.value)} aria-label="操作结果"><option value="">全部结果</option><option value="true">成功</option><option value="false">失败</option></select></div>
      <LoadingState loading={loading} error={error} empty={!data?.length}>
        <div className="table-wrap"><table><thead><tr><th>操作 / 资源</th><th>结果</th><th>请求</th><th>来源</th><th>时间</th></tr></thead><tbody>
          {data?.map(item => <tr key={item.id}><td><strong>{actionText(item.action)}</strong><div className="mono muted">{item.resourceType ?? "—"} · {item.resourceId ?? "—"}</div></td><td><Status value={item.success ? "SUCCESS" : "FAILED"} /><div className="muted">HTTP {item.statusCode}{item.errorCode ? ` · ${item.errorCode}` : ""}</div></td><td><span className="mono">{item.method} {item.path}</span><div className="mono muted">{item.requestId ?? "—"}</div></td><td>{item.ipAddress ?? "—"}<div className="audit-agent muted" title={item.userAgent ?? ""}>{item.userAgent ?? "—"}</div></td><td>{time(item.createdAt)}</td></tr>)}
        </tbody></table></div>
      </LoadingState>
    </section>
  </>;
}

const actions: Record<string, string> = {
  APPLICATION_CREATE: "创建应用",
  APPLICATION_API_KEY_ROTATE: "轮换 API Key",
  APPLICATION_CHANNEL_CHANGE: "切换默认渠道",
  ALIPAY_CONNECTION_CHECK: "检查支付宝连接",
  PAYMENT_QUERY: "支付主动查单",
  PAYMENT_CLOSE: "关闭支付单",
  REFUND_QUERY: "退款主动查单",
  WEBHOOK_RETRY: "重试 Webhook",
  ALIPAY_BILL_IMPORT: "导入支付宝账单",
  RECEIPT_REMATCH: "重新匹配账单",
  PAYMENT_EXCEPTION_UPDATE: "更新支付异常",
};

function actionText(action: string): string { return actions[action] ?? action; }
