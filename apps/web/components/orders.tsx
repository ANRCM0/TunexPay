"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useApi } from "../lib/api";
import { LoadingState, PageHead, Status, money, time } from "./common";

type Payment = { paymentNo: string; status: string; channel: string };
type Order = { id: string; orderNo: string; externalOrderNo: string; subject: string; amount: number; status: string; createdAt: string; paidAt: string | null; expiresAt: string | null; expirationAttempts: number; expirationError: string | null; application: { name: string }; payments: Payment[] };

export function Orders() {
  const { data, loading, error } = useApi<Order[]>("/orders?pageSize=100", 8_000);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("ALL");
  const rows = useMemo(() => data?.filter(item => {
    const matchesStatus = status === "ALL" || item.status === status;
    const needle = query.trim().toLowerCase();
    const matchesQuery = !needle || [item.subject, item.orderNo, item.externalOrderNo, item.application.name]
      .some(value => value.toLowerCase().includes(needle));
    return matchesStatus && matchesQuery;
  }) ?? [], [data, query, status]);
  return <>
    <PageHead eyebrow="Transactions" title="支付订单" copy="业务订单与支付尝试分开记录；一张订单可以安全地发起多次支付。" />
    <LoadingState loading={loading} error={error} empty={!data?.length}>
      <section className="card section">
        <div className="list-tools">
          <input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索订单号、业务单号、应用或商品" aria-label="搜索订单" />
          <select value={status} onChange={event => setStatus(event.target.value)} aria-label="筛选订单状态">
            <option value="ALL">全部状态</option><option value="CREATED">已创建</option><option value="PENDING">待支付</option><option value="SUCCESS">成功</option><option value="PARTIALLY_REFUNDED">部分退款</option><option value="REFUNDED">已退款</option><option value="CLOSED">已关闭</option>
          </select>
          <span className="muted">{rows.length} 笔</span>
        </div>
        {rows.length ? <div className="table-wrap"><table><thead><tr><th>订单</th><th>应用 / 业务单号</th><th>金额</th><th>最新支付</th><th>订单状态</th><th>时间</th></tr></thead>
        <tbody>{rows.map(item => { const payment = item.payments[0]; return <tr key={item.id}>
          <td><Link className="data-link" href={`/orders/${item.orderNo}`}><strong>{item.subject}</strong></Link><div className="mono muted">{item.orderNo}</div>{item.expirationError && <div className="row-error">过期关闭：{item.expirationError}</div>}</td>
          <td>{item.application.name}<div className="mono muted">{item.externalOrderNo}</div></td>
          <td><strong>{money(item.amount)}</strong></td>
          <td>{payment ? <><span>{payment.channel}</span><div className="mono muted">{payment.paymentNo}</div></> : "—"}</td>
          <td><Status value={item.status} />{item.expirationAttempts > 0 && item.status !== "CLOSED" && <div className="recovery-note">过期处理 {item.expirationAttempts} 次</div>}</td><td>{time(item.paidAt || item.createdAt)}<div className="muted">到期 {time(item.expiresAt)}</div></td>
        </tr>; })}</tbody>
      </table></div> : <div className="empty compact">没有符合筛选条件的订单</div>}</section>
    </LoadingState>
  </>;
}
