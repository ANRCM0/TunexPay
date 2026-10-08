"use client";

import { Button, Table, Tag } from "@arco-design/web-react";
import type { ColumnProps } from "@arco-design/web-react/es/Table";
import { useEffect, useMemo, useState } from "react";
import { useApi } from "../lib/api";
import { transactionListPath } from "../lib/transaction-list";
import { type SortColumn } from "../lib/sort";
import { ChannelTag, CopyValue, Drawer, HoverDetail, LoadingState, PageHead, Status, sortValueProps, money, time } from "./common";
import { FilterCard, FilterInput, FilterItem, FilterSelect, ListCard, ListPage, Pager, ToolbarNote, useServerPager, useTableSort, sortHeader } from "./list";
import { OrderDetailBody } from "./order-detail";

type Payment = { paymentNo: string; status: string; channel: string };
type Order = { id: string; orderNo: string; externalOrderNo: string; subject: string; amount: number; status: string; createdAt: string; paidAt: string | null; expiresAt: string | null; expirationAttempts: number; expirationError: string | null; application: { name: string }; payments: Payment[] };

// 可排序列与表头一一对应；"最新支付"没有单一可比较的值，故不参与排序。
const SORT_COLUMNS: SortColumn<Order>[] = [
  { key: "subject", label: "订单" },
  { key: "application", label: "应用 / 业务单号", accessor: (row) => row.application.name },
  { key: "amount", label: "金额", type: "number" },
  { key: "status", label: "订单状态" },
  { key: "createdAt", label: "创建时间", type: "date" },
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
  const [draftQuery, setDraftQuery] = useState("");
  const [draftStatus, setDraftStatus] = useState("ALL");
  // 只有点查询才提交草稿，减少无意义的输入时请求。
  const [applied, setApplied] = useState({ query: "", status: "ALL" });
  const { sort, onSort } = useTableSort<Order>();
  const pager = useServerPager(20);
  const path = useMemo(() => {
    return transactionListPath("orders", { page: pager.page, pageSize: pager.pageSize, query: applied.query, status: applied.status, sort });
  }, [pager.page, pager.pageSize, applied, sort]);
  const { data, meta, loading, error, reload } = useApi<Order[]>(path, 8_000);
  useEffect(() => { if (meta) pager.clamp(meta.total); }, [meta?.total, pager.clamp]);
  const [openOrderNo, setOpenOrderNo] = useState<string | null>(initialOrderNo ?? null);
  const rows = data ?? [];
  const openOrder = data?.find(item => item.orderNo === openOrderNo);
  const applyFilters = (query: string, status: string) => {
    pager.setPage(1);
    setApplied({ query: query.trim(), status });
  };
  const sortAndResetPage = (key: string) => { pager.setPage(1); onSort(key); };

  const columns: ColumnProps<Order>[] = [
    {
      title: sortHeader(SORT_COLUMNS[0], sort, sortAndResetPage),
      dataIndex: "subject",
      render: (_: unknown, item: Order) => <span {...sortValueProps(item, SORT_COLUMNS[0])}>
        <button className="data-link row-open" onClick={() => setOpenOrderNo(item.orderNo)}><strong>{item.subject}</strong></button>
        <div className="id-line"><span className="mono muted">{item.orderNo}</span><CopyValue value={item.orderNo} label="复制订单号" /></div>
      </span>,
    },
    {
      title: sortHeader(SORT_COLUMNS[1], sort, sortAndResetPage),
      dataIndex: "application",
      render: (_: unknown, item: Order) => <span {...sortValueProps(item, SORT_COLUMNS[1])}>
        <span>{item.application.name}</span>
        <div className="id-line"><span className="mono muted">{item.externalOrderNo}</span><CopyValue value={item.externalOrderNo} label="复制业务单号" /></div>
      </span>,
    },
    {
      title: sortHeader(SORT_COLUMNS[2], sort, sortAndResetPage),
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
      title: sortHeader(SORT_COLUMNS[3], sort, sortAndResetPage),
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
      title: sortHeader(SORT_COLUMNS[4], sort, sortAndResetPage),
      dataIndex: "createdAt",
      width: 200,
      render: (_: unknown, item: Order) => <span {...sortValueProps(item, SORT_COLUMNS[4])}>
        {time(item.createdAt)}
        {item.paidAt && <div className="muted">支付 {time(item.paidAt)}</div>}
        <div className="muted">到期 {time(item.expiresAt)}</div>
      </span>,
    },
  ];

  return <>
    <PageHead eyebrow="Transactions" title="支付订单" copy="业务订单与支付尝试分开记录；一张订单可以安全地发起多次支付。" />
    <ListPage>
      <FilterCard
        onSearch={() => applyFilters(draftQuery, draftStatus)}
        onReset={() => { setDraftQuery(""); setDraftStatus("ALL"); applyFilters("", "ALL"); }}
      >
        <FilterItem label="关键字">
          <FilterInput value={draftQuery} onChange={setDraftQuery} maxLength={160} placeholder="订单号 / 业务单号 / 应用 / 商品" />
        </FilterItem>
        <FilterItem label="订单状态">
          <FilterSelect value={draftStatus} onChange={setDraftStatus} options={STATUS_OPTIONS} />
        </FilterItem>
      </FilterCard>
      <LoadingState loading={loading} error={error} stale={Boolean(data)} empty={!data?.length} emptyText="还没有订单">
        <ListCard
        toolbar={<><ToolbarNote>共 {meta?.total ?? 0} 笔订单</ToolbarNote><span className="toolbar-spacer" /><Button size="small" onClick={() => void reload()}>刷新</Button></>}
        pagination={<Pager total={meta?.total ?? 0} page={pager.page} pageSize={pager.pageSize} onChange={pager.setPage} onPageSizeChange={pager.setPageSize} />}
      >
        <Table<Order>
          className="list-table"
          columns={columns}
          data={rows}
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
