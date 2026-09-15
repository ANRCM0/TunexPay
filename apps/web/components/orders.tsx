"use client";

import { useApi } from "../lib/api";
import { LoadingState, PageHead, Status, money, time } from "./common";

type Payment = { paymentNo: string; status: string; channel: string };
type Order = { id: string; orderNo: string; externalOrderNo: string; subject: string; amount: number; status: string; createdAt: string; paidAt: string | null; application: { name: string }; payments: Payment[] };

export function Orders() {
  const { data, loading, error } = useApi<Order[]>("/orders?pageSize=100", 8_000);
  return <>
    <PageHead eyebrow="Transactions" title="支付订单" copy="业务订单与支付尝试分开记录；一张订单可以安全地发起多次支付。" />
    <LoadingState loading={loading} error={error} empty={!data?.length}>
      <section className="card section"><div className="table-wrap"><table><thead><tr><th>订单</th><th>应用 / 业务单号</th><th>金额</th><th>最新支付</th><th>订单状态</th><th>时间</th></tr></thead>
        <tbody>{data?.map(item => { const payment = item.payments[0]; return <tr key={item.id}>
          <td><strong>{item.subject}</strong><div className="mono muted">{item.orderNo}</div></td>
          <td>{item.application.name}<div className="mono muted">{item.externalOrderNo}</div></td>
          <td><strong>{money(item.amount)}</strong></td>
          <td>{payment ? <><span>{payment.channel}</span><div className="mono muted">{payment.paymentNo}</div></> : "—"}</td>
          <td><Status value={item.status} /></td><td>{time(item.paidAt || item.createdAt)}</td>
        </tr>; })}</tbody>
      </table></div></section>
    </LoadingState>
  </>;
}
