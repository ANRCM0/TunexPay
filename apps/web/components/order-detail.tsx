"use client";

import { useState } from "react";
import { api, useApi } from "../lib/api";
import { ChannelTag, LoadingState, Section, Stat, Status, Tabs, money, time } from "./common";
import { eventLabel, eventSourceLabel, eventTone, exceptionSeverityLabel, exceptionTypeLabel, protocolLabel, receiptMatchModeLabel } from "../lib/labels";

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

const DETAIL_TABS = ["概览", "事件时间线", "退款与通知"] as const;

export function OrderDetailBody({ orderNo }: { orderNo: string }) {
  const { data, loading, error, reload } = useApi<Order>(`/orders/${encodeURIComponent(orderNo)}`, 8_000);
  const [tab, setTab] = useState<string>(DETAIL_TABS[0]);
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

  return <LoadingState loading={loading} error={error}>
    {data && <>
      {notice && <div className={`operation-notice ${notice.type}`}>{notice.text}</div>}
      {data.paymentExceptions.some(item => ["OPEN", "PROCESSING"].includes(item.status)) && <div className="operation-notice error">这张订单存在待处理的资金异常，请前往“支付异常”核实，勿直接修改订单状态。</div>}
      {data.expirationError && <div className="operation-notice error">订单过期关闭暂未完成：{data.expirationError}。系统将在 {time(data.expirationNextAttemptAt)} 重试。</div>}
      <Tabs items={DETAIL_TABS} active={tab} onChange={setTab} />

      {tab === "概览" && <>
        <div className="grid stats">
          <Stat detail tone="blue" label="订单金额" value={money(data.amount)} note={data.currency} />
          <Stat detail tone={data.status === "SUCCESS" ? "green" : "orange"} label="订单状态" value={<Status value={data.status} />} note={data.paidAt ? `支付于 ${time(data.paidAt)}` : "尚未完成支付"} />
          <Stat detail tone="blue" label="支付尝试" value={String(data.payments.length)} note={`${data.payments.filter(item => item.status === "SUCCESS").length} 笔成功`} />
          <Stat detail tone="blue" label="通知任务" value={String(data.webhookDeliveries.length)} note={`${data.webhookDeliveries.filter(item => item.status === "SUCCESS").length} 次送达`} />
        </div>

        <Section title="订单信息" action={<span className="mono muted">{data.orderNo}</span>}>
          <div className="detail-list">
            <Detail label="应用" value={`${data.application.name} (${data.application.appId})`} mono />
            <Detail label="业务订单号" value={data.externalOrderNo} mono />
            <Detail label="接入协议" value={protocolLabel(data.protocol)} />
            <Detail label="创建时间" value={time(data.createdAt)} />
            <Detail label="订单到期" value={time(data.expiresAt)} />
            <Detail label="过期处理" value={data.expirationAttempts ? `${data.expirationAttempts} 次` : "尚未触发"} />
            <Detail label="商品说明" value={data.description || "—"} />
            <Detail label="通知地址" value={data.notifyUrl || "—"} mono />
            <Detail label="返回地址" value={data.returnUrl || "—"} mono />
          </div>
        </Section>

        <Section title="支付尝试" action={<span className="muted">可信晚到成功会保留记录</span>} className="detail-section">
          {data.payments.length ? <div className="table-wrap"><table><thead><tr><th>尝试</th><th>渠道 / 支付单号</th><th>状态</th><th>金额</th><th>渠道交易号</th><th>创建 / 支付时间</th><th>操作</th></tr></thead>
            <tbody>{data.payments.map(payment => <tr key={payment.id}>
              <td>#{payment.attemptNo}</td>
              <td data-label="渠道"><ChannelTag code={payment.channel} /><div className="mono muted">{payment.method} · {payment.paymentNo}</div>{payment.errorMessage && <div className="row-error">{payment.errorCode}: {payment.errorMessage}</div>}</td>
              <td data-label="状态"><Status value={payment.status} /></td><td data-label="金额">{money(payment.channelAmount)}{payment.channelAmount !== payment.amount && <div className="muted">业务 {money(payment.amount)}</div>}{payment.receivedAmount !== null && <div className="muted">实收 {money(payment.receivedAmount)}</div>}{payment.receiptMatchReference && <div className="mono muted">{payment.receiptMatchMode}: {payment.receiptMatchReference}</div>}</td>
              <td data-label="渠道交易号" className="mono">{payment.channelTradeNo || payment.channelOrderNo || "—"}</td>
              <td data-label="时间">{time(payment.createdAt)}<div className="muted">{payment.paidAt ? time(payment.paidAt) : "未支付"}</div></td>
              <td data-label="操作"><div className="row-actions">
                {payment.status !== "SUCCESS" && <button className="button secondary" disabled={working !== ""} onClick={() => void operate(payment.paymentNo, "query")}>{working === `${payment.paymentNo}:query` ? "查询中…" : "主动查单"}</button>}
                {["CREATED", "PROCESSING", "UNKNOWN"].includes(payment.status) && <button className="button danger" disabled={working !== ""} onClick={() => void operate(payment.paymentNo, "close")}>{working === `${payment.paymentNo}:close` ? "关闭中…" : "关闭"}</button>}
              </div>{payment.queryAttempts > 0 && <div className="recovery-note">已自动查询 {payment.queryAttempts} 次<br />{payment.nextQueryAt ? `下次 ${time(payment.nextQueryAt)}` : "等待人工处理"}</div>}</td>
            </tr>)}</tbody>
          </table></div> : <div className="empty compact">尚未发起支付</div>}
        </Section>

        {data.paymentExceptions.length > 0 && <Section title="支付异常" action={<span className="muted">处置请前往“支付异常”队列</span>} className="detail-section">
          {data.paymentExceptions.map(item => <div className="record" key={item.id}><div><strong>{item.summary}</strong> <Status value={item.status} /></div><div className="mono muted">{item.exceptionNo} · {exceptionTypeLabel(item.type)} · {exceptionSeverityLabel(item.severity)}</div><div className="muted">{item.resolution || "尚未填写处置结果"} · {time(item.detectedAt)}</div></div>)}
        </Section>}
      </>}

      {tab === "事件时间线" && <Section title="事件时间线" action={<span className="muted">{data.events.length} 条</span>}>
        {data.events.length ? <div className="timeline">{data.events.map(event => <div className={`timeline-item tone-${eventTone(event.type)}`} key={event.id}>
          <div className="timeline-type">{eventLabel(event.type)}</div>
          <div className="timeline-meta"><span className="mono">{event.aggregateId}</span> · {eventSourceLabel(event.source)} · {time(event.createdAt)}</div>
          {hasPayload(event.payload) && <details className="event-payload"><summary>查看事件数据</summary><pre>{JSON.stringify(event.payload, null, 2)}</pre></details>}
        </div>)}</div> : <div className="empty compact">暂无事件</div>}
      </Section>}

      {tab === "退款与通知" && <Section title="退款与通知">
        <div className="detail-columns nested">
          <div><h3>退款记录</h3>{data.payments.flatMap(payment => payment.refunds.map(refund => ({ ...refund, paymentNo: payment.paymentNo }))).map(refund => <div className="record" key={refund.refundNo}>
            <div><strong>{money(refund.amount)}</strong> <Status value={refund.status} /></div><div className="mono muted">{refund.refundNo} · {refund.paymentNo}</div><div className="muted">{refund.reason || "未填写原因"} · {time(refund.createdAt)}</div>
          </div>)}{data.payments.every(payment => payment.refunds.length === 0) && <div className="empty compact">暂无退款</div>}</div>
          <div><h3>Webhook 投递</h3>{data.webhookDeliveries.map(delivery => <div className="record" key={delivery.id}>
            <div><strong>{eventLabel(delivery.eventType)}</strong> <Status value={delivery.status} /></div><div className="mono muted break-all">{delivery.url}</div><div className="muted">尝试 {delivery.attempts} 次 · {time(delivery.deliveredAt || delivery.createdAt)}</div>{delivery.lastError && <div className="row-error">{delivery.lastError}</div>}
          </div>)}{!data.webhookDeliveries.length && <div className="empty compact">暂无通知任务</div>}</div>
        </div>
      </Section>}
    </>}
  </LoadingState>;
}

function Detail({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div className="detail-row"><span>{label}</span><strong className={mono ? "mono break-all" : ""}>{value}</strong></div>;
}

function hasPayload(payload: unknown): boolean {
  return payload !== null && payload !== undefined && (typeof payload !== "object" || Object.keys(payload as object).length > 0);
}
