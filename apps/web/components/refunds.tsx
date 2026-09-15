"use client";

import { useApi } from "../lib/api";
import { LoadingState, PageHead, Status, money, time } from "./common";

type Refund = { id: string; refundNo: string; externalRefundNo: string; amount: number; status: string; reason: string | null; createdAt: string; application: { name: string }; payment: { paymentNo: string; order: { subject: string } } };

export function Refunds() {
  const { data, loading, error } = useApi<Refund[]>("/refunds?pageSize=100", 8_000);
  return <>
    <PageHead eyebrow="Reconciliation" title="退款记录" copy="退款有独立状态和幂等单号，UNKNOWN 会保留待查而不会被误判失败。" />
    <LoadingState loading={loading} error={error} empty={!data?.length}>
      <section className="card section"><div className="table-wrap"><table><thead><tr><th>退款单</th><th>支付单 / 应用</th><th>金额</th><th>原因</th><th>状态</th><th>创建时间</th></tr></thead>
        <tbody>{data?.map(item => <tr key={item.id}><td><strong>{item.payment.order.subject}</strong><div className="mono muted">{item.refundNo}<br />{item.externalRefundNo}</div></td><td><span className="mono">{item.payment.paymentNo}</span><div className="muted">{item.application.name}</div></td><td><strong>{money(item.amount)}</strong></td><td>{item.reason || "—"}</td><td><Status value={item.status} /></td><td>{time(item.createdAt)}</td></tr>)}</tbody>
      </table></div></section>
    </LoadingState>
  </>;
}
