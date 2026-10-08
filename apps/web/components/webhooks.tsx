"use client";

import { Button, Table } from "@arco-design/web-react";
import type { ColumnProps } from "@arco-design/web-react/es/Table";
import { useMemo, useState } from "react";
import { api, useApi } from "../lib/api";
import { sortRows, type SortColumn } from "../lib/sort";
import { CopyValue, HoverDetail, LoadingState, PageHead, Status, Toast, sortValueProps, time } from "./common";
import { FilterCard, FilterItem, FilterSelect, ListCard, ListPage, Pager, ToolbarNote, useClientPager, useTableSort, sortHeader } from "./list";
import { protocolLabel, webhookEventLabel } from "../lib/labels";

type Delivery = { id: string; eventType: string; protocol: string; url: string; status: string; attempts: number; lastError: string | null; nextAttemptAt: string; application: { name: string }; order: { orderNo: string; externalOrderNo: string } };

const SORT_COLUMNS: SortColumn<Delivery>[] = [
  { key: "eventType", label: "事件 / 订单" },
  { key: "url", label: "目标地址" },
  { key: "protocol", label: "协议" },
  { key: "status", label: "状态" },
  { key: "attempts", label: "尝试", type: "number" },
  { key: "nextAttemptAt", label: "下次执行", type: "date" },
];

// 与 common.tsx 的 Status 徽章用的是同一套状态码；这里给的是筛选下拉里更贴合投递语境的中文。
const STATUS_OPTIONS = [
  { label: "全部状态", value: "ALL" },
  { label: "待投递", value: "PENDING" },
  { label: "投递中", value: "PROCESSING" },
  { label: "成功", value: "SUCCESS" },
  { label: "重试耗尽", value: "DEAD" },
];

export function Webhooks() {
  const { data, loading, error, reload } = useApi<Delivery[]>("/webhooks?pageSize=100", 8_000);
  const { sort, onSort } = useTableSort<Delivery>();
  const [draftStatus, setDraftStatus] = useState("ALL");
  // 状态筛选在本地做（接口一次取回 100 条），但同样只在点「查询」时生效：
  // 输入/切换过程中每改一次就重算整张表，长列表会明显卡顿。
  const [appliedStatus, setAppliedStatus] = useState("ALL");
  const [retrying, setRetrying] = useState("");
  const [notice, setNotice] = useState<{ type: "ok" | "error"; text: string } | null>(null);
  const filtered = useMemo(
    () => (data ?? []).filter(item => appliedStatus === "ALL" || item.status === appliedStatus),
    [data, appliedStatus],
  );
  // 先筛选再排序：用户关心的是筛选后的子集，排序只应该作用于这个子集
  const rows = useMemo(() => sortRows(filtered, SORT_COLUMNS, sort), [filtered, sort]);
  const pager = useClientPager(rows, 20);

  async function retry(id: string) {
    setRetrying(id);
    setNotice(null);
    try {
      await api(`/webhooks/${id}/retry`, { method: "POST" });
      setNotice({ type: "ok", text: "Webhook 已重新加入投递队列。" });
      await reload();
    } catch (cause) {
      setNotice({ type: "error", text: cause instanceof Error ? cause.message : "Webhook 重试失败" });
    } finally {
      setRetrying("");
    }
  }

  const columns: ColumnProps<Delivery>[] = [
    {
      title: sortHeader(SORT_COLUMNS[0], sort, onSort),
      dataIndex: "eventType",
      render: (_: unknown, item: Delivery) => <span {...sortValueProps(item, SORT_COLUMNS[0])}>
        <strong>{webhookEventLabel(item.eventType.split(":")[0])}</strong>
        <div className="mono muted">{item.eventType}</div>
        <div className="id-line"><span className="mono muted">{item.order.externalOrderNo}</span><CopyValue value={item.order.externalOrderNo} label="复制业务订单号" /></div>
      </span>,
    },
    {
      title: sortHeader(SORT_COLUMNS[1], sort, onSort),
      dataIndex: "url",
      render: (_: unknown, item: Delivery) => <span {...sortValueProps(item, SORT_COLUMNS[1])}>
        <div className="id-line"><span className="mono break-all">{item.url}</span><CopyValue value={item.url} label="复制 Webhook 地址" /></div>
      </span>,
    },
    {
      title: sortHeader(SORT_COLUMNS[2], sort, onSort),
      dataIndex: "protocol",
      width: 130,
      render: (_: unknown, item: Delivery) => <span {...sortValueProps(item, SORT_COLUMNS[2])}>{protocolLabel(item.protocol)}</span>,
    },
    {
      title: sortHeader(SORT_COLUMNS[3], sort, onSort),
      dataIndex: "status",
      width: 130,
      render: (_: unknown, item: Delivery) => <span {...sortValueProps(item, SORT_COLUMNS[3])}>
        <HoverDetail text={item.lastError} tone="danger"><Status value={item.status} /></HoverDetail>
      </span>,
    },
    {
      title: sortHeader(SORT_COLUMNS[4], sort, onSort),
      dataIndex: "attempts",
      width: 100,
      render: (_: unknown, item: Delivery) => <span {...sortValueProps(item, SORT_COLUMNS[4])}>{item.attempts}</span>,
    },
    {
      title: sortHeader(SORT_COLUMNS[5], sort, onSort),
      dataIndex: "nextAttemptAt",
      width: 200,
      render: (_: unknown, item: Delivery) => <span {...sortValueProps(item, SORT_COLUMNS[5])}>{time(item.nextAttemptAt)}</span>,
    },
    {
      title: "操作",
      dataIndex: "actions",
      width: 130,
      // 重试是这一页唯一的主操作，用 primary 按钮把它和工具栏里的次要按钮区分开
      render: (_: unknown, item: Delivery) => item.status === "DEAD"
        ? <Button type="primary" size="small" disabled={retrying !== ""} onClick={() => void retry(item.id)}>{retrying === item.id ? "重试中…" : "重新投递"}</Button>
        : null,
    },
  ];

  return <>
    <PageHead eyebrow="Delivery" title="Webhook 投递" copy="通知任务与支付结果同事务创建；失败后指数退避，达到上限进入 DEAD。" />
    {notice && <Toast type={notice.type} text={notice.text} onClose={() => setNotice(null)} />}
    <ListPage>
      <FilterCard
        onSearch={() => setAppliedStatus(draftStatus)}
        onReset={() => { setDraftStatus("ALL"); setAppliedStatus("ALL"); }}
      >
        <FilterItem label="投递状态">
          <FilterSelect value={draftStatus} onChange={setDraftStatus} options={STATUS_OPTIONS} />
        </FilterItem>
      </FilterCard>
      <LoadingState loading={loading} error={error} stale={Boolean(data)} empty={!data?.length}>
        <ListCard
          toolbar={<><ToolbarNote>共 {rows.length} 条投递记录</ToolbarNote><span className="toolbar-spacer" /><Button size="small" onClick={() => void reload()}>刷新</Button></>}
          pagination={<Pager total={pager.total} page={pager.page} pageSize={pager.pageSize} onChange={pager.setPage} onPageSizeChange={pager.setPageSize} />}
        >
          <Table<Delivery>
            className="list-table"
            columns={columns}
            data={pager.rows}
            rowKey="id"
            pagination={false}
            borderCell={false}
            loading={false}
            noDataElement={<div className="empty compact">没有符合筛选条件的投递记录</div>}
          />
        </ListCard>
      </LoadingState>
    </ListPage>
  </>;
}
