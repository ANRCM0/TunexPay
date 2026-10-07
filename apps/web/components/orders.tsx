"use client";

import { Button, Table, Tag } from "@arco-design/web-react";
import type { ColumnProps } from "@arco-design/web-react/es/Table";
import { useMemo, useState } from "react";
import { useApi } from "../lib/api";
import { sortRows, type SortColumn } from "../lib/sort";
import { ChannelTag, CopyValue, Drawer, HoverDetail, LoadingState, PageHead, Status, sortValueProps, money, time } from "./common";
import { FilterCard, FilterInput, FilterItem, FilterSelect, ListCard, ListPage, Pager, ToolbarNote, useClientPager, useTableSort, sortHeader } from "./list";
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

const STATUS_OPTIONS = [
  { label: "全部状态", value: "ALL" },
  { label: "已创建", value: "CREATED" },
  { label: "待支付", value: "PENDING" },
  { label: "成功", value: "SUCCESS" },
  { label: "部分退款", value: "PARTIALLY_REFUNDED" },
  { label: "已退款", value: "REFUNDED" },
  { label: "已关闭", value: "CLOSED" },
];

// 订单状态列的过期处理进度与失败原因默认收起，悬浮或聚焦徽章才展开。
function expirationDetail(item: Order): string {
  return [
    item.expirationAttempts > 0 && item.status !== "CLOSED" ? `过期处理已尝试 ${item.expirationAttempts} 次` : null,
    item.expirationError ? `过期关闭失败：${item.expirationError}` : null,
  ].filter(Boolean).join("\n");
}

export function Orders({ initialOrderNo }: { initialOrderNo?: string }) {
  const { data, loading, error, reload } = useApi<Order[]>("/orders?pageSize=100", 8_000);
  const [draftQuery, setDraftQuery] = useState("");
  const [draftStatus, setDraftStatus] = useState("ALL");
  // 查询条件在点「查询」时才生效：输入过程中每敲一个字都重算整张表，长列表会明显卡顿
  const [applied, setApplied] = useState({ query: "", status: "ALL" });
  const { sort, onSort } = useTableSort<Order>();
  const [openOrderNo, setOpenOrderNo] = useState<string | null>(initialOrderNo ?? null);
  const filtered = useMemo(() => (data ?? []).filter(item => {
    const matchesStatus = applied.status === "ALL" || item.status === applied.status;
    const needle = applied.query.trim().toLowerCase();
    const matchesQuery = !needle || [item.subject, item.orderNo, item.externalOrderNo, item.application.name]
      .some(value => value.toLowerCase().includes(needle));
    return matchesStatus && matchesQuery;
  }), [data, applied]);
  // 先筛选再排序：筛选是用户当前关心的子集，排序只作用于这个子集
  const rows = useMemo(() => sortRows(filtered, SORT_COLUMNS, sort), [filtered, sort]);
  const pager = useClientPager(rows, 20);
  const openOrder = data?.find(item => item.orderNo === openOrderNo);

  const columns: ColumnProps<Order>[] = [
    {
      title: sortHeader(SORT_COLUMNS[0], sort, onSort),
      dataIndex: "subject",
      render: (_: unknown, item: Order) => <span {...sortValueProps(item, SORT_COLUMNS[0])}>
        <button className="data-link row-open" onClick={() => setOpenOrderNo(item.orderNo)}><strong>{item.subject}</strong></button>
        <div className="id-line"><span className="mono muted">{item.orderNo}</span><CopyValue value={item.orderNo} label="复制订单号" /></div>
      </span>,
    },
    {
      title: sortHeader(SORT_COLUMNS[1], sort, onSort),
      dataIndex: "application",
      render: (_: unknown, item: Order) => <span {...sortValueProps(item, SORT_COLUMNS[1])}>
        <span>{item.application.name}</span>
        <div className="id-line"><span className="mono muted">{item.externalOrderNo}</span><CopyValue value={item.externalOrderNo} label="复制业务单号" /></div>
      </span>,
    },
    {
      title: sortHeader(SORT_COLUMNS[2], sort, onSort),
      dataIndex: "amount",
      align: "right",
      width: 120,
      render: (_: unknown, item: Order) => <strong {...sortValueProps(item, SORT_COLUMNS[2])}>{money(item.amount)}</strong>,
    },
    {
      // 最新支付列没有单一可比较的值（可能多笔），不参与排序，因此不标注排序值
      title: "最新支付",
      dataIndex: "payments",
      width: 240,
      render: (_: unknown, item: Order) => {
        const payment = item.payments[0];
        return payment ? <><ChannelTag code={payment.channel} /><div className="id-line"><span className="mono muted">{payment.paymentNo}</span><CopyValue value={payment.paymentNo} label="复制支付单号" /></div></> : <span className="muted">—</span>;
      },
    },
    {
      title: sortHeader(SORT_COLUMNS[3], sort, onSort),
      dataIndex: "status",
      width: 130,
      render: (_: unknown, item: Order) => <span {...sortValueProps(item, SORT_COLUMNS[3])}>
        <HoverDetail text={expirationDetail(item)} tone={item.expirationError ? "danger" : "muted"}><Status value={item.status} /></HoverDetail>
      </span>,
    },
    {
      title: "操作",
      dataIndex: "actions",
      width: 100,
      render: (_: unknown, item: Order) => <button type="button" className="link-button" onClick={() => setOpenOrderNo(item.orderNo)}>查看</button>,
    },
    {
      title: sortHeader(SORT_COLUMNS[4], sort, onSort),
      dataIndex: "createdAt",
      width: 200,
      render: (_: unknown, item: Order) => <span {...sortValueProps(item, SORT_COLUMNS[4])}>
        {time(item.paidAt || item.createdAt)}
        <div className="muted">到期 {time(item.expiresAt)}</div>
      </span>,
    },
  ];

  return <>
    <PageHead eyebrow="Transactions" title="支付订单" copy="业务订单与支付尝试分开记录；一张订单可以安全地发起多次支付。" />
    <ListPage>
      <FilterCard
        onSearch={() => setApplied({ query: draftQuery, status: draftStatus })}
        onReset={() => { setDraftQuery(""); setDraftStatus("ALL"); setApplied({ query: "", status: "ALL" }); }}
      >
        <FilterItem label="关键字">
          <FilterInput value={draftQuery} onChange={setDraftQuery} placeholder="订单号 / 业务单号 / 应用 / 商品" />
        </FilterItem>
        <FilterItem label="订单状态">
          <FilterSelect value={draftStatus} onChange={setDraftStatus} options={STATUS_OPTIONS} />
        </FilterItem>
      </FilterCard>
      <LoadingState loading={loading} error={error} empty={!data?.length} emptyText="还没有订单">
        <ListCard
        toolbar={<><ToolbarNote>共 {rows.length} 笔订单</ToolbarNote><span className="toolbar-spacer" /><Button size="small" onClick={() => void reload()}>刷新</Button></>}
        pagination={<Pager total={pager.total} page={pager.page} pageSize={pager.pageSize} onChange={pager.setPage} onPageSizeChange={pager.setPageSize} />}
      >
        <Table<Order>
          className="list-table"
          columns={columns}
          data={pager.rows}
          rowKey="id"
          pagination={false}
          borderCell={false}
          loading={false}
          noDataElement={<div className="empty compact">没有符合筛选条件的订单</div>}
          />
        </ListCard>
      </LoadingState>
    </ListPage>
    {openOrderNo && <Drawer wide title={`订单详情 · ${openOrder?.subject ?? openOrderNo}`} onClose={() => setOpenOrderNo(null)}>
      <OrderDetailBody orderNo={openOrderNo} />
    </Drawer>}
  </>;
}
