"use client";

import Link from "next/link";
import { useState } from "react";
import { api, useApi } from "../lib/api";
import { LoadingState, PageHead, Status, money, time } from "./common";

type Refund = { refundNo: string; externalRefundNo: string; amount: number; status: string; reason: string | null; createdAt: string };
type Payment = {
  id: string; paymentNo: string; attemptNo: number; channel: string; method: string; status: string; amount: number; channelAmount: number; receivedAmount: number | null;
  receiptMatchMode: string | null; receiptMatchReference: string | null; receiptValidUntil: string | null;
  channelTradeNo: string | null; channelOrderNo: string | null; errorCode: string | null; errorMessage: string | null;
  queryAttempts: number; nextQueryAt: string | null; lastQueriedAt: string | null; paidAt: string | null; createdAt: string; refunds: Refund[];
};
type Event = { id: string; type: string; source: string; aggregateId: string; payload: unknown; createdAt: string };
type Delivery = { id: string; eventType: string; url: string; status: string; attempts: number; lastError: string | null; deliveredAt: string | null; createdAt: string };
type PaymentException = { id: string; exceptionNo: string; type: string; status: string; severity: string; summary: string; resolution: string | null; detectedAt: string };
type Order = {
  orderNo: string; externalOrderNo: string; subject: string; description: string | null; amount: number; currency: string;
  status: string; protocol: string; notifyUrl: string | null; returnUrl: string | null; createdAt: string; paidAt: string | null; expiresAt: string | null;
  expirationAttempts: number; expirationNextAttemptAt: string | null; expirationError: string | null;
  application: { name: string; appId: string }; payments: Payment[]; events: Event[]; webhookDeliveries: Delivery[]; paymentExceptions: PaymentException[];
};

export function OrderDetail({ orderNo }: { orderNo: string }) {
  const { data, loading, error, reload } = useApi<Order>(`/orders/${encodeURIComponent(orderNo)}`, 8_000);
  const [working, setWorking] = useState("");
  const [notice, setNotice] = useState<{ type: "ok" | "error"; text: string } | null>(null);

  async function operate(paymentNo: string, action: "query" | "close") {
    if (action === "close" && !window.confirm("确认关闭这笔支付尝试？关闭后用户将无法继续使用当前付款码。")) return;
    setWorking(`${paymentNo}:${action}`);
    setNotice(null);
    try {
      await api(`/payments/${paymentNo}/${action}`, { method: "POST" });
      setNotice({ type: "ok", text: action === "query" ? "主动查单完成，状态已刷新。" : "支付已关闭。" });
      await reload();
    } catch (cause) {
      setNotice({ type: "error", text: cause instanceof Error ? cause.message : "操作失败" });
    } finally {
      setWorking("");
    }
  }

  return <>
    <PageHead eyebrow="Order Detail" title={data?.subject ?? "订单详情"} copy={data ? `${data.application.name} · ${data.externalOrderNo}` : "查看支付尝试、退款、通知与完整业务事件。"} action={<Link className="button secondary" href="/orders">返回订单</Link>} />
    <LoadingState loading={loading} error={error}>
      {data && <>
        {notice && <div className={`operation-notice ${notice.type}`}>{notice.text}</div>}
        {data.paymentExceptions.some(item => ["OPEN", "PROCESSING"].includes(item.status)) && <div className="operation-notice error">这张订单存在待处理的资金异常，请前往“支付异常”核实，勿直接修改订单状态。</div>}
        {data.expirationError && <div className="operation-notice error">订单过期关闭暂未完成：{data.expirationError}。系统将在 {time(data.expirationNextAttemptAt)} 重试。</div>}
        <div className="grid stats detail-stats">
          <Summary label="订单金额" value={money(data.amount)} note={data.currency} />
          <Summary label="订单状态" value={<Status value={data.status} />} note={data.paidAt ? `支付于 ${time(data.paidAt)}` : "尚未完成支付"} />
          <Summary label="支付尝试" value={String(data.payments.length)} note={`${data.payments.filter(item => item.status === "SUCCESS").length} 笔成功`} />
          <Summary label="通知任务" value={String(data.webhookDeliveries.length)} note={`${data.webhookDeliveries.filter(item => item.status === "SUCCESS").length} 次送达`} />
        </div>

        <div className="detail-columns">
          <section className="card section">
            <div className="section-title"><h2>订单信息</h2><span className="mono muted">{data.orderNo}</span></div>
            <div className="detail-list">
              <Detail label="应用" value={`${data.application.name} (${data.application.appId})`} mono />
              <Detail label="业务订单号" value={data.externalOrderNo} mono />
              <Detail label="接入协议" value={data.protocol} />
              <Detail label="创建时间" value={time(data.createdAt)} />
              <Detail label="订单到期" value={time(data.expiresAt)} />
              <Detail label="过期处理" value={data.expirationAttempts ? `${data.expirationAttempts} 次` : "尚未触发"} />
              <Detail label="商品说明" value={data.description || "—"} />
              <Detail label="通知地址" value={data.notifyUrl || "—"} mono />
              <Detail label="返回地址" value={data.returnUrl || "—"} mono />
            </div>
          </section>

          <section className="card section">
            <div className="section-title"><h2>事件时间线</h2><span className="muted">{data.events.length} 条</span></div>
            {data.events.length ? <div className="timeline">{data.events.map(event => <div className="timeline-item" key={event.id}>
              <div className="timeline-type">{event.type}</div>
              <div className="timeline-meta"><span className="mono">{event.aggregateId}</span> · {event.source} · {time(event.createdAt)}</div>
              {hasPayload(event.payload) && <details className="event-payload"><summary>查看事件数据</summary><pre>{JSON.stringify(event.payload, null, 2)}</pre></details>}
            </div>)}</div> : <div className="empty compact">暂无事件</div>}
          </section>
        </div>

        <section className="card section detail-section">
          <div className="section-title"><h2>支付尝试</h2><span className="muted">可信晚到成功会保留记录</span></div>
          {data.payments.length ? <div className="table-wrap"><table><thead><tr><th>尝试</th><th>渠道 / 支付单号</th><th>状态</th><th>金额</th><th>渠道交易号</th><th>创建 / 支付时间</th><th>操作</th></tr></thead>
            <tbody>{data.payments.map(payment => <tr key={payment.id}>
              <td>#{payment.attemptNo}</td>
              <td><strong>{payment.channel} · {payment.method}</strong><div className="mono muted">{payment.paymentNo}</div>{payment.errorMessage && <div className="row-error">{payment.errorCode}: {payment.errorMessage}</div>}</td>
              <td><Status value={payment.status} /></td><td>{money(payment.channelAmount)}{payment.channelAmount !== payment.amount && <div className="muted">业务 {money(payment.amount)}</div>}{payment.receivedAmount !== null && <div className="muted">实收 {money(payment.receivedAmount)}</div>}{payment.receiptMatchReference && <div className="mono muted">{payment.receiptMatchMode}: {payment.receiptMatchReference}</div>}</td>
              <td className="mono">{payment.channelTradeNo || payment.channelOrderNo || "—"}</td>
              <td>{time(payment.createdAt)}<div className="muted">{payment.paidAt ? time(payment.paidAt) : "未支付"}</div></td>
              <td><div className="row-actions">
                {payment.status !== "SUCCESS" && <button className="button secondary" disabled={working !== ""} onClick={() => void operate(payment.paymentNo, "query")}>{working === `${payment.paymentNo}:query` ? "查询中…" : "主动查单"}</button>}
                {["CREATED", "PROCESSING", "UNKNOWN"].includes(payment.status) && <button className="button danger" disabled={working !== ""} onClick={() => void operate(payment.paymentNo, "close")}>{working === `${payment.paymentNo}:close` ? "关闭中…" : "关闭"}</button>}
              </div>{payment.queryAttempts > 0 && <div className="recovery-note">已自动查询 {payment.queryAttempts} 次<br />{payment.nextQueryAt ? `下次 ${time(payment.nextQueryAt)}` : "等待人工处理"}</div>}</td>
            </tr>)}</tbody>
          </table></div> : <div className="empty compact">尚未发起支付</div>}
        </section>

        {data.paymentExceptions.length > 0 && <section className="card section detail-section">
          <div className="section-title"><h2>支付异常</h2><Link className="data-link" href="/exceptions">进入处置队列</Link></div>
          {data.paymentExceptions.map(item => <div className="record" key={item.id}><div><strong>{item.summary}</strong> <Status value={item.status} /></div><div className="mono muted">{item.exceptionNo} · {item.type} · {item.severity}</div><div className="muted">{item.resolution || "尚未填写处置结果"} · {time(item.detectedAt)}</div></div>)}
        </section>}

        <section className="card section detail-section">
          <div className="section-title"><h2>退款与通知</h2></div>
          <div className="detail-columns nested">
            <div><h3>退款记录</h3>{data.payments.flatMap(payment => payment.refunds.map(refund => ({ ...refund, paymentNo: payment.paymentNo }))).map(refund => <div className="record" key={refund.refundNo}>
              <div><strong>{money(refund.amount)}</strong> <Status value={refund.status} /></div><div className="mono muted">{refund.refundNo} · {refund.paymentNo}</div><div className="muted">{refund.reason || "未填写原因"} · {time(refund.createdAt)}</div>
            </div>)}{data.payments.every(payment => payment.refunds.length === 0) && <div className="empty compact">暂无退款</div>}</div>
            <div><h3>Webhook 投递</h3>{data.webhookDeliveries.map(delivery => <div className="record" key={delivery.id}>
              <div><strong>{delivery.eventType}</strong> <Status value={delivery.status} /></div><div className="mono muted break-all">{delivery.url}</div><div className="muted">尝试 {delivery.attempts} 次 · {time(delivery.deliveredAt || delivery.createdAt)}</div>{delivery.lastError && <div className="row-error">{delivery.lastError}</div>}
            </div>)}{!data.webhookDeliveries.length && <div className="empty compact">暂无通知任务</div>}</div>
          </div>
        </section>
      </>}
    </LoadingState>
  </>;
}

function Summary({ label, value, note }: { label: string; value: React.ReactNode; note: string }) {
  return <div className="card stat"><div className="stat-label">{label}</div><div className="stat-value detail-value">{value}</div><div className="stat-note">{note}</div></div>;
}

function Detail({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div className="detail-row"><span>{label}</span><strong className={mono ? "mono break-all" : ""}>{value}</strong></div>;
}

function hasPayload(payload: unknown): boolean {
  return payload !== null && payload !== undefined && (typeof payload !== "object" || Object.keys(payload as object).length > 0);
}
