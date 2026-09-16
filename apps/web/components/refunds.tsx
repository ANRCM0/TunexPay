"use client";

import { useState } from "react";
import { api, useApi } from "../lib/api";
import { LoadingState, PageHead, Status, money, time } from "./common";

type Refund = {
  id: string; refundNo: string; externalRefundNo: string; amount: number; status: string; reason: string | null; createdAt: string;
  queryAttempts: number; nextQueryAt: string | null; lastQueriedAt: string | null; errorMessage: string | null;
  application: { name: string }; payment: { paymentNo: string; order: { subject: string } };
};

export function Refunds() {
  const { data, loading, error, reload } = useApi<Refund[]>("/refunds?pageSize=100", 8_000);
  const [querying, setQuerying] = useState("");
  const [notice, setNotice] = useState<{ type: "ok" | "error"; text: string } | null>(null);
  async function query(refundNo: string) {
    setQuerying(refundNo); setNotice(null);
    try {
      await api(`/refunds/${refundNo}/query`, { method: "POST" });
      setNotice({ type: "ok", text: "退款查单完成，状态已刷新。" });
      await reload();
    } catch (cause) { setNotice({ type: "error", text: cause instanceof Error ? cause.message : "退款查单失败" }); }
    finally { setQuerying(""); }
  }
  return <>
    <PageHead eyebrow="Reconciliation" title="退款记录" copy="退款有独立状态和幂等单号，UNKNOWN 会保留待查而不会被误判失败。" />
    {notice && <div className={`operation-notice ${notice.type}`}>{notice.text}</div>}
    <LoadingState loading={loading} error={error} empty={!data?.length}>
      <section className="card section"><div className="table-wrap"><table><thead><tr><th>退款单</th><th>支付单 / 应用</th><th>金额</th><th>状态 / 恢复</th><th>创建时间</th><th>操作</th></tr></thead>
        <tbody>{data?.map(item => <tr key={item.id}><td><strong>{item.payment.order.subject}</strong><div className="mono muted">{item.refundNo}<br />{item.externalRefundNo}</div>{item.reason && <div className="muted">{item.reason}</div>}</td><td><span className="mono">{item.payment.paymentNo}</span><div className="muted">{item.application.name}</div></td><td><strong>{money(item.amount)}</strong></td><td><Status value={item.status} />{item.queryAttempts > 0 && <div className="recovery-note">已查询 {item.queryAttempts} 次<br />{item.nextQueryAt ? `下次 ${time(item.nextQueryAt)}` : "等待人工处理"}</div>}{item.errorMessage && <div className="row-error">{item.errorMessage}</div>}</td><td>{time(item.createdAt)}{item.lastQueriedAt && <div className="muted">最近查询 {time(item.lastQueriedAt)}</div>}</td><td>{item.status !== "SUCCESS" && <button className="button secondary" disabled={querying !== ""} onClick={() => void query(item.refundNo)}>{querying === item.refundNo ? "查询中…" : "主动查单"}</button>}</td></tr>)}</tbody>
      </table></div></section>
    </LoadingState>
  </>;
}
