"use client";

import { useState } from "react";
import { api, useApi } from "../lib/api";
import { CopyValue, LoadingState, PageHead, Status, Toast, money, time } from "./common";

type Refund = {
  id: string; refundNo: string; externalRefundNo: string; amount: number; status: string; reason: string | null; createdAt: string;
  queryAttempts: number; nextQueryAt: string | null; lastQueriedAt: string | null; errorMessage: string | null;
  application: { name: string; archivedAt: string | null }; payment: { paymentNo: string; order: { subject: string; deletedAt: string | null } };
};

export function Refunds() {
  const { data, loading, error, reload } = useApi<Refund[]>("/refunds?pageSize=100", 8_000);
  const [querying, setQuerying] = useState("");
  const [notice, setNotice] = useState<{ type: "ok" | "error"; text: string } | null>(null);

  async function query(refundNo: string) {
    setQuerying(refundNo);
    setNotice(null);
    try {
      await api(`/refunds/${refundNo}/query`, { method: "POST" });
      setNotice({ type: "ok", text: "退款查单完成，状态已刷新。" });
      await reload();
    } catch (cause) {
      setNotice({ type: "error", text: cause instanceof Error ? cause.message : "退款查单失败" });
    } finally {
      setQuerying("");
    }
  }

  return <>
    <PageHead eyebrow="Reconciliation" title="退款记录" copy="退款有独立状态和幂等单号，UNKNOWN 会保留待查而不会被误判失败。" />
    {notice && <Toast type={notice.type} text={notice.text} onClose={() => setNotice(null)} />}
    <p className="muted">带「已归档」标记的退款来自已删除的应用：通道侧的钱已经动了，这些记录仍保留可查，未完成的会继续自动查单。</p>
    <LoadingState loading={loading} error={error} empty={!data?.length}>
      <section className="card section"><div className="table-wrap"><table>
        <thead><tr><th>退款单</th><th>支付单 / 应用</th><th>金额</th><th>状态 / 恢复</th><th>创建时间</th><th>操作</th></tr></thead>
        <tbody>{data?.map(item => <tr key={item.id}>
          <td>
            <strong>{item.payment.order.subject}</strong>
            <div className="id-line"><span className="mono muted">{item.refundNo}</span><CopyValue value={item.refundNo} label="复制退款单号" /></div>
            <div className="id-line"><span className="mono muted">{item.externalRefundNo}</span><CopyValue value={item.externalRefundNo} label="复制业务退款号" /></div>
            {item.reason && <div className="muted">{item.reason}</div>}
          </td>
          <td data-label="支付单">
            <div className="id-line"><span className="mono">{item.payment.paymentNo}</span><CopyValue value={item.payment.paymentNo} label="复制支付单号" /></div>
            <div className="muted">{item.application.name}{item.application.archivedAt && <span className="tag-archived">已归档</span>}</div>
          </td>
          <td data-label="金额" className="amount-cell"><strong>{money(item.amount)}</strong></td>
          <td data-label="状态"><Status value={item.status} />{item.queryAttempts > 0 && <div className="recovery-note">已查询 {item.queryAttempts} 次<br />{item.nextQueryAt ? `下次 ${time(item.nextQueryAt)}` : "等待人工处理"}</div>}{item.errorMessage && <div className="row-error">{item.errorMessage}</div>}</td>
          <td data-label="创建时间">{time(item.createdAt)}{item.lastQueriedAt && <div className="muted">最近查询 {time(item.lastQueriedAt)}</div>}</td>
          <td data-label="操作">{item.status !== "SUCCESS" && <button className="button secondary" disabled={querying !== ""} onClick={() => void query(item.refundNo)}>{querying === item.refundNo ? "查询中…" : "主动查单"}</button>}</td>
        </tr>)}</tbody>
      </table></div></section>
    </LoadingState>
  </>;
}
