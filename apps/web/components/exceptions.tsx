"use client";

import Link from "next/link";
import { useState } from "react";
import { api, useApi } from "../lib/api";
import { LoadingState, PageHead, Section, Status, money, time } from "./common";

type PaymentException = {
  id: string;
  exceptionNo: string;
  type: string;
  status: string;
  severity: string;
  source: string;
  summary: string;
  resolution: string | null;
  resolutionRef: string | null;
  detectedAt: string;
  resolvedAt: string | null;
  order: { orderNo: string; subject: string } | null;
  payment: { paymentNo: string; amount: number; receivedAmount: number | null; channelTradeNo: string | null } | null;
};

export function Exceptions() {
  const [status, setStatus] = useState("");
  const { data, loading, error, reload } = useApi<PaymentException[]>(`/exceptions?pageSize=100${status ? `&status=${status}` : ""}`, 10_000);
  const [working, setWorking] = useState("");
  const [notice, setNotice] = useState<{ type: "ok" | "error"; text: string } | null>(null);

  async function change(item: PaymentException, next: "PROCESSING" | "RESOLVED" | "IGNORED") {
    let resolution = "已开始人工核查";
    let resolutionRef = "";
    if (next !== "PROCESSING") {
      const text = window.prompt(next === "RESOLVED" ? "请输入解决说明（如：已原路退款）" : "请输入忽略原因");
      if (!text?.trim()) return;
      resolution = text.trim();
      if (next === "RESOLVED") resolutionRef = window.prompt("可选：填写退款单号或外部凭证号")?.trim() ?? "";
    }
    setWorking(item.id); setNotice(null);
    try {
      await api(`/exceptions/${item.id}/status`, { method: "POST", body: JSON.stringify({ status: next, resolution, resolutionRef: resolutionRef || undefined }) });
      setNotice({ type: "ok", text: `异常单 ${item.exceptionNo} 已更新。` });
      await reload();
    } catch (cause) { setNotice({ type: "error", text: cause instanceof Error ? cause.message : "异常单更新失败" }); }
    finally { setWorking(""); }
  }

  const statusFilter = <select value={status} onChange={event => setStatus(event.target.value)} aria-label="异常状态">
    <option value="">全部状态</option><option value="OPEN">待处理</option><option value="PROCESSING">处理中</option><option value="RESOLVED">已解决</option><option value="IGNORED">已忽略</option>
  </select>;

  return <>
    <PageHead eyebrow="Payment Exceptions" title="支付异常" copy="晚到重复付款、流水多候选和状态冲突必须在这里形成明确处置记录。" />
    {notice && <div className={`operation-notice ${notice.type}`}>{notice.text}</div>}
    <Section title="异常处置队列" action={statusFilter}>
      <LoadingState loading={loading} error={error} empty={!data?.length}>
        <div className="table-wrap"><table>
          <thead><tr><th>异常 / 风险</th><th>订单与支付</th><th>金额 / 渠道流水</th><th>状态</th><th>发现时间</th><th>处置</th></tr></thead>
          <tbody>{data?.map(item => <tr key={item.id}>
            <td><strong>{typeText(item.type)}</strong><div className="row-error">{item.summary}</div><div className="mono muted">{item.exceptionNo} · {item.source}</div></td>
            <td>{item.order ? <><Link className="data-link" href={`/orders/${item.order.orderNo}`}><strong>{item.order.subject}</strong></Link><div className="mono muted">{item.order.orderNo}</div></> : "—"}{item.payment && <div className="mono muted">{item.payment.paymentNo}</div>}</td>
            <td>{item.payment ? <><strong>{money(item.payment.receivedAmount ?? item.payment.amount)}</strong>{item.payment.receivedAmount && item.payment.receivedAmount !== item.payment.amount && <div className="muted">业务金额 {money(item.payment.amount)}</div>}<div className="mono muted">{item.payment.channelTradeNo ?? "—"}</div></> : "—"}</td>
            <td><Status value={item.status} /><div className={`severity ${item.severity}`}>{severityText(item.severity)}</div>{item.resolution && <div className="muted">{item.resolution}{item.resolutionRef ? ` · ${item.resolutionRef}` : ""}</div>}</td>
            <td>{time(item.detectedAt)}{item.resolvedAt && <div className="muted">完成 {time(item.resolvedAt)}</div>}</td>
            <td><div className="row-actions">{item.status === "OPEN" && <button className="button secondary" disabled={working !== ""} onClick={() => void change(item, "PROCESSING")}>开始处理</button>}{["OPEN", "PROCESSING"].includes(item.status) && <><button className="button" disabled={working !== ""} onClick={() => void change(item, "RESOLVED")}>标记解决</button><button className="button danger" disabled={working !== ""} onClick={() => void change(item, "IGNORED")}>忽略</button></>}</div></td>
          </tr>)}</tbody>
        </table></div>
      </LoadingState>
    </Section>
  </>;
}

function typeText(value: string): string {
  return ({ LATE_DUPLICATE: "晚到 / 重复支付", RECEIPT_AMBIGUOUS: "流水匹配多候选", PAYMENT_STATE_CONFLICT: "支付状态冲突" } as Record<string, string>)[value] ?? value;
}

function severityText(value: string): string {
  return ({ MEDIUM: "中风险", HIGH: "高风险", CRITICAL: "严重" } as Record<string, string>)[value] ?? value;
}
