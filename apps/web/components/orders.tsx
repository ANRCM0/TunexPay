"use client";

import { useMemo, useState } from "react";
import { useApi } from "../lib/api";
import { nextSortState, sortRows, type SortColumn } from "../lib/sort";
import { ChannelTag, CopyValue, Drawer, HoverDetail, LoadingState, PageHead, SortableTh, Status, sortValueProps, money, time } from "./common";
import { OrderDetailBody } from "./order-detail";

type Payment = { paymentNo: string; status: string; channel: string };
type Order = { id: string; orderNo: string; externalOrderNo: string; subject: string; amount: number; status: string; createdAt: string; paidAt: string | null; expiresAt: string | null; expirationAttempts: number; expirationError: string | null; application: { name: string }; payments: Payment[] };

// 可排序列与表头一一对应；"最新支付"没有单一可比较的值，故不参与排序。
const SORT_COLUMNS: SortColumn<Order>[] = [
  { key: "subject", label: "订单" },
  { key: "application", label: "应用 / 业务单号", accessor: (row) => row.application.name },
  { key: "amount", label: "金额", type: "number" },
  { key: "status", label: "订单状态" },
  // 列表展示的是"支付时间优先、否则创建时间"，排序必须用同一个值，否则用户看到的顺序对不上
  { key: "time", label: "时间", type: "date", accessor: (row) => row.paidAt || row.createdAt },
];

// 订单状态列的过期处理进度与失败原因默认收起，悬浮或聚焦徽章才展开。
function expirationDetail(item: Order): string {
  return [
    item.expirationAttempts > 0 && item.status !== "CLOSED" ? `过期处理已尝试 ${item.expirationAttempts} 次` : null,
    item.expirationError ? `过期关闭失败：${item.expirationError}` : null,
  ].filter(Boolean).join("\n");
}

export function Orders({ initialOrderNo }: { initialOrderNo?: string }) {
  const { data, loading, error } = useApi<Order[]>("/orders?pageSize=100", 8_000);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("ALL");
  const [sort, setSort] = useState(() => null as ReturnType<typeof nextSortState>);
  const [openOrderNo, setOpenOrderNo] = useState<string | null>(initialOrderNo ?? null);
  const filtered = useMemo(() => data?.filter(item => {
    const matchesStatus = status === "ALL" || item.status === status;
    const needle = query.trim().toLowerCase();
    const matchesQuery = !needle || [item.subject, item.orderNo, item.externalOrderNo, item.application.name]
      .some(value => value.toLowerCase().includes(needle));
    return matchesStatus && matchesQuery;
  }) ?? [], [data, query, status]);
  // 先筛选再排序：筛选是用户当前关心的子集，排序只作用于这个子集
  const rows = useMemo(() => sortRows(filtered, SORT_COLUMNS, sort), [filtered, sort]);
  const openOrder = data?.find(item => item.orderNo === openOrderNo);
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
        {rows.length ? <div className="table-wrap"><table><thead><tr>
          <SortableTh label="订单" sortKey="subject" sort={sort} onSort={key => setSort(nextSortState(sort, key))} />
          <SortableTh label="应用 / 业务单号" sortKey="application" sort={sort} onSort={key => setSort(nextSortState(sort, key))} />
          <SortableTh label="金额" sortKey="amount" sort={sort} onSort={key => setSort(nextSortState(sort, key))} alignRight />
          <th scope="col">最新支付</th>
          <SortableTh label="订单状态" sortKey="status" sort={sort} onSort={key => setSort(nextSortState(sort, key))} />
          <SortableTh label="时间" sortKey="time" sort={sort} onSort={key => setSort(nextSortState(sort, key))} />
        </tr></thead>
        <tbody>{rows.map(item => { const payment = item.payments[0]; return <tr key={item.id}>
          <td {...sortValueProps(item, SORT_COLUMNS[0])}><button className="data-link row-open" onClick={() => setOpenOrderNo(item.orderNo)}><strong>{item.subject}</strong></button><div className="id-line"><span className="mono muted">{item.orderNo}</span><CopyValue value={item.orderNo} label="复制订单号" /></div></td>
          <td data-label="应用" {...sortValueProps(item, SORT_COLUMNS[1])}><span>{item.application.name}</span><div className="id-line"><span className="mono muted">{item.externalOrderNo}</span><CopyValue value={item.externalOrderNo} label="复制业务单号" /></div></td>
          <td data-label="金额" className="amount-cell" {...sortValueProps(item, SORT_COLUMNS[2])}><strong>{money(item.amount)}</strong></td>
          {/* 最新支付列没有单一可比较的值（可能多笔），不参与排序，因此不标注排序值 */}
          <td data-label="最新支付">{payment ? <><ChannelTag code={payment.channel} /><div className="id-line"><span className="mono muted">{payment.paymentNo}</span><CopyValue value={payment.paymentNo} label="复制支付单号" /></div></> : "—"}</td>
          <td data-label="订单状态" {...sortValueProps(item, SORT_COLUMNS[3])}><HoverDetail text={expirationDetail(item)} tone={item.expirationError ? "danger" : "muted"}><Status value={item.status} /></HoverDetail></td><td data-label="时间" {...sortValueProps(item, SORT_COLUMNS[4])}>{time(item.paidAt || item.createdAt)}<div className="muted">到期 {time(item.expiresAt)}</div></td>
        </tr>; })}</tbody>
      </table></div> : <div className="empty compact">没有符合筛选条件的订单</div>}</section>
    </LoadingState>
    {openOrderNo && <Drawer wide title={`订单详情 · ${openOrder?.subject ?? openOrderNo}`} onClose={() => setOpenOrderNo(null)}>
      <OrderDetailBody orderNo={openOrderNo} />
    </Drawer>}
  </>;
}
