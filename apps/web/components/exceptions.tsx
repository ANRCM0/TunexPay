"use client";

import Link from "next/link";
import { Button, Input, Table, Tag } from "@arco-design/web-react";
import type { ColumnProps } from "@arco-design/web-react/es/Table";
import { useMemo, useState } from "react";
import { api, useApi } from "../lib/api";
import { sortRows, type SortColumn } from "../lib/sort";
import { CopyValue, LoadingState, Modal, PageHead, Status, Toast, sortValueProps, money, time, RowAction } from "./common";
import { FilterCard, FilterItem, FilterSelect, ListCard, ListPage, Pager, ToolbarNote, sortHeader, useClientPager, useTableSort } from "./list";
import { eventSourceLabel, exceptionSeverityLabel, exceptionTypeLabel } from "../lib/labels";

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

type FinalAction = "RESOLVED" | "IGNORED";

// 状态列展示的是 statusLabels（OPEN=待处理 等），排序按原始枚举码；枚举码不表达业务紧急度，
// 所以「发现时间」和「金额」才是这张表真正有用的排序列。
const SORT_COLUMNS: SortColumn<PaymentException>[] = [
  { key: "exceptionNo", label: "异常 / 风险" },
  { key: "order", label: "订单与支付", accessor: (row) => row.order?.subject ?? "" },
  { key: "amount", label: "金额 / 渠道流水", type: "number", accessor: (row) => row.payment?.amount ?? null },
  { key: "status", label: "状态" },
  { key: "detectedAt", label: "发现时间", type: "date" },
];

// 异常状态筛选沿用服务端参数（会改变请求 URL），选项顺序与处置流程一致：
// 待处理 → 处理中 → 已解决/已忽略，管理员按队列往下走即可
const STATUS_OPTIONS = [
  { label: "全部状态", value: "" },
  { label: "待处理", value: "OPEN" },
  { label: "处理中", value: "PROCESSING" },
  { label: "已解决", value: "RESOLVED" },
  { label: "已忽略", value: "IGNORED" },
];

// 风险等级用 Arco Tag 呈现：它本质是标签而不是动作，Tag 自带配色比手写 CSS 更一致；
// 颜色只做分级提示，文案仍来自 labels，避免把等级判断散落在组件里。
const SEVERITY_TAG_COLOR: Record<string, string> = { MEDIUM: "orange", HIGH: "red", CRITICAL: "red" };

export function Exceptions() {
  const [draftStatus, setDraftStatus] = useState("");
  // 筛选在点「查询」时才生效：切换状态会改变请求 URL 并整表重新加载，
  // 让下拉每变一次就发一次请求，会让管理员在选择过程中看到反复闪烁的空表
  const [appliedStatus, setAppliedStatus] = useState("");
  const { data, loading, error, reload } = useApi<PaymentException[]>(`/exceptions?pageSize=100${appliedStatus ? `&status=${appliedStatus}` : ""}`, 10_000);
  const { sort, onSort } = useTableSort<PaymentException>();
  const [working, setWorking] = useState("");
  const [notice, setNotice] = useState<{ type: "ok" | "error"; text: string } | null>(null);
  const [pending, setPending] = useState<{ item: PaymentException; next: FinalAction } | null>(null);
  const [resolution, setResolution] = useState("");
  const [resolutionRef, setResolutionRef] = useState("");
  // 状态筛选由服务端完成（会改变请求 URL），所以这里只负责排序与分页
  const rows = useMemo(() => sortRows(data ?? [], SORT_COLUMNS, sort), [data, sort]);
  const pager = useClientPager(rows, 20);

  async function update(item: PaymentException, next: "PROCESSING" | FinalAction, body?: { resolution: string; resolutionRef?: string }) {
    setWorking(item.id);
    setNotice(null);
    try {
      const payload = next === "PROCESSING"
        ? { status: next, resolution: "已开始人工核查" }
        : { status: next, resolution: body?.resolution, resolutionRef: body?.resolutionRef || undefined };
      await api(`/exceptions/${item.id}/status`, { method: "POST", body: JSON.stringify(payload) });
      setNotice({ type: "ok", text: `异常单 ${item.exceptionNo} 已更新。` });
      await reload();
      return true;
    } catch (cause) {
      setNotice({ type: "error", text: cause instanceof Error ? cause.message : "异常单更新失败" });
      return false;
    } finally {
      setWorking("");
    }
  }

  function openFinal(item: PaymentException, next: FinalAction) {
    setPending({ item, next });
    setResolution("");
    setResolutionRef("");
  }

  async function submitFinal() {
    if (!pending || !resolution.trim()) return;
    const ok = await update(pending.item, pending.next, {
      resolution: resolution.trim(),
      resolutionRef: pending.next === "RESOLVED" ? resolutionRef.trim() || undefined : undefined,
    });
    // 只有落库成功才关弹窗：失败时保留已填的说明，管理员不必重打一遍
    if (ok) setPending(null);
  }

  const columns: ColumnProps<PaymentException>[] = [
    {
      title: sortHeader(SORT_COLUMNS[0], sort, onSort),
      dataIndex: "exceptionNo",
      render: (_: unknown, item: PaymentException) => <span {...sortValueProps(item, SORT_COLUMNS[0])}>
        <strong>{exceptionTypeLabel(item.type)}</strong>
        <div className="row-error">{item.summary}</div>
        <div className="id-line"><span className="mono muted">{item.exceptionNo}</span><CopyValue value={item.exceptionNo} label="复制异常单号" /></div>
        <div className="muted">{eventSourceLabel(item.source)}</div>
      </span>,
    },
    {
      title: sortHeader(SORT_COLUMNS[1], sort, onSort),
      dataIndex: "order",
      width: 240,
      render: (_: unknown, item: PaymentException) => <span {...sortValueProps(item, SORT_COLUMNS[1])}>
        {item.order ? <>
          <Link className="data-link" href={`/orders/${item.order.orderNo}`}><strong>{item.order.subject}</strong></Link>
          <div className="id-line"><span className="mono muted">{item.order.orderNo}</span><CopyValue value={item.order.orderNo} label="复制订单号" /></div>
        </> : "—"}
        {item.payment && <div className="id-line"><span className="mono muted">{item.payment.paymentNo}</span><CopyValue value={item.payment.paymentNo} label="复制支付单号" /></div>}
      </span>,
    },
    {
      title: sortHeader(SORT_COLUMNS[2], sort, onSort),
      dataIndex: "amount",
      align: "right",
      width: 180,
      render: (_: unknown, item: PaymentException) => <span {...sortValueProps(item, SORT_COLUMNS[2])}>
        {item.payment ? <>
          <strong>{money(item.payment.receivedAmount ?? item.payment.amount)}</strong>
          {item.payment.receivedAmount && item.payment.receivedAmount !== item.payment.amount && <div className="muted">业务金额 {money(item.payment.amount)}</div>}
          {item.payment.channelTradeNo
            ? <div className="id-line"><span className="mono muted">{item.payment.channelTradeNo}</span><CopyValue value={item.payment.channelTradeNo} label="复制渠道流水" /></div>
            : <div className="muted">无渠道流水</div>}
        </> : "—"}
      </span>,
    },
    {
      title: sortHeader(SORT_COLUMNS[3], sort, onSort),
      dataIndex: "status",
      width: 160,
      render: (_: unknown, item: PaymentException) => <span {...sortValueProps(item, SORT_COLUMNS[3])}>
        <Status value={item.status} />
        {/* 外层沿用既有的 .severity 提供行距，颜色交给 Tag —— 等级配色不该只存在于 CSS 里 */}
        <div className="severity"><Tag size="small" color={SEVERITY_TAG_COLOR[item.severity] ?? "gray"}>{exceptionSeverityLabel(item.severity)}</Tag></div>
        {item.resolution && <div className="muted">{item.resolution}</div>}
        {item.resolutionRef && <div className="id-line"><span className="mono muted">{item.resolutionRef}</span><CopyValue value={item.resolutionRef} label="复制处置凭证" /></div>}
      </span>,
    },
    {
      title: sortHeader(SORT_COLUMNS[4], sort, onSort),
      dataIndex: "detectedAt",
      width: 200,
      render: (_: unknown, item: PaymentException) => <span {...sortValueProps(item, SORT_COLUMNS[4])}>
        {time(item.detectedAt)}
        {item.resolvedAt && <div className="muted">完成 {time(item.resolvedAt)}</div>}
      </span>,
    },
    {
      title: "处置",
      dataIndex: "actions",
      width: 170,
      // 行内动作用链接式按钮：一张表里会同时出现三个动作，实心按钮会把「可读的数据行」压成按钮墙
      render: (_: unknown, item: PaymentException) => <div className="row-actions">
        {item.status === "OPEN" && <RowAction disabled={working !== ""} busy={working === item.id} onClick={() => void update(item, "PROCESSING")}>{working === item.id ? "处理中…" : "开始处理"}</RowAction>}
        {["OPEN", "PROCESSING"].includes(item.status) && <>
          <RowAction disabled={working !== ""} onClick={() => openFinal(item, "RESOLVED")}>标记解决</RowAction>
          <RowAction danger disabled={working !== ""} onClick={() => openFinal(item, "IGNORED")}>忽略</RowAction>
        </>}
      </div>,
    },
  ];

  return <>
    <PageHead eyebrow="Payment Exceptions" title="支付异常" copy="晚到重复付款、流水多候选和状态冲突必须在这里形成明确处置记录。" />
    {notice && <Toast type={notice.type} text={notice.text} onClose={() => setNotice(null)} />}

    <ListPage>
      <FilterCard
        onSearch={() => setAppliedStatus(draftStatus)}
        onReset={() => { setDraftStatus(""); setAppliedStatus(""); }}
      >
        <FilterItem label="异常状态">
          <FilterSelect value={draftStatus} onChange={setDraftStatus} options={STATUS_OPTIONS} placeholder="全部状态" />
        </FilterItem>
      </FilterCard>
      <LoadingState loading={loading} error={error} stale={Boolean(data)} empty={!data?.length}>
        <ListCard
          toolbar={<><ToolbarNote>共 {rows.length} 条异常</ToolbarNote><span className="toolbar-spacer" /><Button size="small" onClick={() => void reload()}>刷新</Button></>}
          pagination={<Pager total={pager.total} page={pager.page} pageSize={pager.pageSize} onChange={pager.setPage} onPageSizeChange={pager.setPageSize} />}
        >
          <Table<PaymentException>
            className="list-table"
            columns={columns}
            data={pager.rows}
            rowKey="id"
            pagination={false}
            borderCell={false}
            loading={false}
            noDataElement={<div className="empty compact">没有符合筛选条件的异常</div>}
          />
        </ListCard>
      </LoadingState>
    </ListPage>

    {pending && <Modal
      title={pending.next === "RESOLVED" ? "记录异常解决结果" : "确认忽略异常"}
      onClose={working ? () => undefined : () => setPending(null)}
    >
      <div className="resolution-form">
        <p className="dialog-copy">
          {pending.next === "RESOLVED"
            ? "请留下可审计的解决说明。若涉及退款、补单或外部处理，建议同时填写对应凭证号。"
            : "忽略不会删除异常记录。请填写明确原因，便于后续审计和复盘。"}
        </p>

        <label>
          {pending.next === "RESOLVED" ? "解决说明" : "忽略原因"}
          <Input.TextArea
            rows={4}
            value={resolution}
            onChange={setResolution}
            placeholder={pending.next === "RESOLVED" ? "例如：已核对渠道流水并完成原路退款" : "例如：确认是测试交易，无需继续处置"}
            autoFocus
          />
        </label>

        {pending.next === "RESOLVED" && <label>
          处置凭证（可选）
          <Input value={resolutionRef} onChange={setResolutionRef} placeholder="退款单号 / 外部凭证号" />
        </label>}

        {pending.next === "IGNORED" && <div className="dialog-warning">忽略后该异常将退出待处理队列，但处置记录仍会永久保留。</div>}

        <div className="dialog-actions">
          {/* 忽略是「不再处理」，主按钮改成 danger 主题，让确认动作与后果一致 */}
          <Button type="primary" status={pending.next === "IGNORED" ? "danger" : undefined} disabled={!resolution.trim() || working !== ""} onClick={() => void submitFinal()}>
            {working ? "提交中…" : pending.next === "RESOLVED" ? "确认解决" : "确认忽略"}
          </Button>
          <Button disabled={working !== ""} onClick={() => setPending(null)}>取消</Button>
        </div>
      </div>
    </Modal>}
  </>;
}
