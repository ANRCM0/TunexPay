"use client";

import { Button, Input, Table, Tag } from "@arco-design/web-react";
import type { ColumnProps } from "@arco-design/web-react/es/Table";
import { useEffect, useMemo, useState } from "react";
import { api, useApi } from "../lib/api";
import { transactionListPath } from "../lib/transaction-list";
import { newRefundIdempotencyKey, parseYuanToCents } from "../lib/admin-refund";
import { type SortColumn } from "../lib/sort";
import { CopyValue, HoverDetail, LoadingState, Modal, PageHead, Status, Toast, sortValueProps, money, time, RowAction } from "./common";
import { FilterCard, FilterInput, FilterItem, FilterSelect, ListCard, ListPage, Pager, ToolbarNote, sortHeader, useServerPager, useTableSort } from "./list";

type Refund = {
  id: string; refundNo: string; externalRefundNo: string; amount: number; status: string; reason: string | null; createdAt: string;
  queryAttempts: number; nextQueryAt: string | null; lastQueriedAt: string | null; errorMessage: string | null;
  application: { name: string; archivedAt: string | null }; payment: { paymentNo: string; order: { subject: string; deletedAt: string | null } };
};

// 可排序列与表头一一对应。状态列展示的是状态徽章，排序仍按原始枚举码：
// 枚举码是 API 的既有契约，改文案不该顺带改排序结果。
const SORT_COLUMNS: SortColumn<Refund>[] = [
  { key: "refundNo", label: "退款单" },
  { key: "paymentNo", label: "支付单 / 应用", accessor: (row) => row.payment.paymentNo },
  { key: "amount", label: "金额", type: "number" },
  { key: "status", label: "状态 / 说明" },
  { key: "createdAt", label: "创建时间", type: "date" },
];

// 与 common.tsx 的 statusText 保持同一套中文标签，避免筛选下拉与徽章各说各话
const STATUS_OPTIONS = [
  { label: "全部状态", value: "ALL" },
  { label: "已创建", value: "CREATED" },
  { label: "处理中", value: "PROCESSING" },
  { label: "成功", value: "SUCCESS" },
  { label: "失败", value: "FAILED" },
  { label: "结果未知", value: "UNKNOWN" },
];

// 状态列的说明默认收起，悬浮或聚焦徽章才展开。退款查单是人工动作（系统不自动查单），
// 所以这里只呈现历史查单次数与错误原因，并明确告诉管理员下一步要人工查单。
function refundRecovery(item: Refund): string {
  return [
    item.queryAttempts > 0 ? `历史自动查询 ${item.queryAttempts} 次` : null,
    "退款状态不再自动查询，需要时请点「主动查单」。",
    item.errorMessage,
  ].filter(Boolean).join("\n");
}

export function Refunds() {
  const [draftQuery, setDraftQuery] = useState("");
  const [draftStatus, setDraftStatus] = useState("ALL");
  const [applied, setApplied] = useState({ query: "", status: "ALL" });
  const { sort, onSort } = useTableSort<Refund>();
  const pager = useServerPager(20);
  const path = useMemo(() => {
    return transactionListPath("refunds", { page: pager.page, pageSize: pager.pageSize, query: applied.query, status: applied.status, sort });
  }, [pager.page, pager.pageSize, applied, sort]);
  const { data, meta, loading, error, reload } = useApi<Refund[]>(path, 8_000);
  useEffect(() => { if (meta) pager.clamp(meta.total); }, [meta?.total, pager.clamp]);
  const applyFilters = (query: string, status: string) => {
    pager.setPage(1);
    setApplied({ query: query.trim(), status });
  };
  const sortAndResetPage = (key: string) => { pager.setPage(1); onSort(key); };
  const [querying, setQuerying] = useState("");
  const [notice, setNotice] = useState<{ type: "ok" | "error"; text: string } | null>(null);
  // 命名上刻意避开 draft：筛选的草稿态叫 draftQuery/draftStatus，这里是与后端交互的表单
  const [refundForm, setRefundForm] = useState<{ paymentNo: string; amount: string; reason: string; key: string } | null>(null);
  const [working, setWorking] = useState(false);
  // 后端在全量匹配结果中完成筛选和排序，这里仅渲染当前页。
  const rows = data ?? [];
  const cents = refundForm ? parseYuanToCents(refundForm.amount) : null;
  const canSubmit = Boolean(refundForm && refundForm.paymentNo.trim() && refundForm.reason.trim().length >= 2 && cents !== null);

  async function query(refundNo: string) {
    setQuerying(refundNo);
    setNotice(null);
    try {
      await api(`/refunds/${refundNo}/query`, { method: "POST" });
      setNotice({ type: "ok", text: "退款查单完成，状态已刷新。" });
      await reload();
    } catch (cause) {
      setNotice({ type: "error", text: cause instanceof Error ? cause.message : "退款查单失败" });
    } finally {
      setQuerying("");
    }
  }

  // 任何字段改动都换一个新的幂等键（见 lib/admin-refund.ts 的说明）。
  function updateRefundForm(field: "paymentNo" | "amount" | "reason", value: string) {
    setRefundForm(current => current ? { ...current, [field]: value, key: newRefundIdempotencyKey() } : current);
  }

  async function submitRefund() {
    if (!refundForm || cents === null || !canSubmit) return;
    setWorking(true);
    setNotice(null);
    try {
      await api("/refunds", { method: "POST", body: JSON.stringify({
        paymentNo: refundForm.paymentNo.trim(), amount: cents, reason: refundForm.reason.trim(), idempotencyKey: refundForm.key,
      }) });
      setNotice({ type: "ok", text: `退款已发起（${money(cents)}）。退款不会自动查单，请稍后用「主动查单」确认通道结果。` });
      setRefundForm(null);
      if (pager.page === 1) await reload();
      else pager.setPage(1);
    } catch (cause) {
      // 失败时保留弹窗与同一个幂等键：原样重试不会退成两笔。
      setNotice({ type: "error", text: cause instanceof Error ? cause.message : "退款发起失败" });
    } finally {
      setWorking(false);
    }
  }

  const columns: ColumnProps<Refund>[] = [
    {
      title: sortHeader(SORT_COLUMNS[0], sort, sortAndResetPage),
      dataIndex: "refundNo",
      render: (_: unknown, item: Refund) => <span {...sortValueProps(item, SORT_COLUMNS[0])}>
        <strong>{item.payment.order.subject}</strong>
        <div className="id-line"><span className="mono muted">{item.refundNo}</span><CopyValue value={item.refundNo} label="复制退款单号" /></div>
        <div className="id-line"><span className="mono muted">{item.externalRefundNo}</span><CopyValue value={item.externalRefundNo} label="复制业务退款号" /></div>
        {item.reason && <div className="muted">{item.reason}</div>}
      </span>,
    },
    {
      title: sortHeader(SORT_COLUMNS[1], sort, sortAndResetPage),
      dataIndex: "paymentNo",
      width: 240,
      render: (_: unknown, item: Refund) => <span {...sortValueProps(item, SORT_COLUMNS[1])}>
        <div className="id-line"><span className="mono">{item.payment.paymentNo}</span><CopyValue value={item.payment.paymentNo} label="复制支付单号" /></div>
        {/* 归档标记改用 Arco Tag：它是「标签」性质的信息，不该为它手写一套徽章样式；
            左侧留白只能内联给出，因为 admin.css 已冻结、不能再改类名 */}
        <div className="muted">{item.application.name}{item.application.archivedAt && <Tag size="small" color="gray" style={{ marginLeft: 6 }}>已归档</Tag>}</div>
      </span>,
    },
    {
      title: sortHeader(SORT_COLUMNS[2], sort, sortAndResetPage),
      dataIndex: "amount",
      align: "right",
      width: 120,
      render: (_: unknown, item: Refund) => <strong {...sortValueProps(item, SORT_COLUMNS[2])}>{money(item.amount)}</strong>,
    },
    {
      title: sortHeader(SORT_COLUMNS[3], sort, sortAndResetPage),
      dataIndex: "status",
      width: 150,
      render: (_: unknown, item: Refund) => <span {...sortValueProps(item, SORT_COLUMNS[3])}>
        <HoverDetail text={refundRecovery(item)} tone={item.errorMessage ? "danger" : "muted"}><Status value={item.status} /></HoverDetail>
      </span>,
    },
    {
      title: sortHeader(SORT_COLUMNS[4], sort, sortAndResetPage),
      dataIndex: "createdAt",
      width: 200,
      render: (_: unknown, item: Refund) => <span {...sortValueProps(item, SORT_COLUMNS[4])}>
        {time(item.createdAt)}
        {item.lastQueriedAt && <div className="muted">最近查询 {time(item.lastQueriedAt)}</div>}
      </span>,
    },
    {
      title: "操作",
      dataIndex: "actions",
      width: 110,
      // 已成功的退款无需查单，这一格保持为空而不是塞占位符，避免把「没事可做」渲染成待办
      render: (_: unknown, item: Refund) => item.status !== "SUCCESS" &&
        <RowAction disabled={querying !== ""} busy={querying === item.refundNo} onClick={() => void query(item.refundNo)}>{querying === item.refundNo ? "查询中…" : "主动查单"}</RowAction>,
    },
  ];

  return <>
    <PageHead
      eyebrow="Reconciliation"
      title="退款记录"
      copy="退款有独立状态和幂等单号，UNKNOWN 会保留原状态而不会被误判失败；退款不再自动查单，需要时人工查单确认。"
      action={<Button type="primary" onClick={() => setRefundForm({ paymentNo: "", amount: "", reason: "", key: newRefundIdempotencyKey() })}>人工发起退款</Button>}
    />
    {notice && <Toast type={notice.type} text={notice.text} onClose={() => setNotice(null)} />}
    <p className="muted">带「已归档」标记的退款来自已删除的应用：通道侧的钱已经动了，这些记录仍保留可查。系统不自动查单，未完成的退款请用「主动查单」人工确认。</p>
    <ListPage>
      <FilterCard
        onSearch={() => applyFilters(draftQuery, draftStatus)}
        onReset={() => { setDraftQuery(""); setDraftStatus("ALL"); applyFilters("", "ALL"); }}
      >
        <FilterItem label="关键字">
          <FilterInput value={draftQuery} onChange={setDraftQuery} maxLength={160} placeholder="退款单号 / 业务退款号 / 支付单号 / 订单" />
        </FilterItem>
        <FilterItem label="退款状态">
          <FilterSelect value={draftStatus} onChange={setDraftStatus} options={STATUS_OPTIONS} />
        </FilterItem>
      </FilterCard>
      <LoadingState loading={loading} error={error} stale={Boolean(data)} empty={!data?.length}>
        <ListCard
          toolbar={<><ToolbarNote>共 {meta?.total ?? 0} 笔退款</ToolbarNote><span className="toolbar-spacer" /><Button size="small" onClick={() => void reload()}>刷新</Button></>}
          pagination={<Pager total={meta?.total ?? 0} page={pager.page} pageSize={pager.pageSize} onChange={pager.setPage} onPageSizeChange={pager.setPageSize} />}
        >
          <Table<Refund>
            className="list-table"
            columns={columns}
            data={rows}
            rowKey="id"
            pagination={false}
            borderCell={false}
            loading={false}
            noDataElement={<div className="empty compact">没有符合筛选条件的退款</div>}
          />
        </ListCard>
      </LoadingState>
    </ListPage>

    {refundForm && <Modal title="人工发起退款" onClose={working ? () => undefined : () => setRefundForm(null)}>
      <div className="resolution-form">
        <div className="dialog-warning">
          退款会立即向支付通道真实打款，不可撤销。系统不自动执行退款，这张退款单也不会被自动查单：发起后请用「主动查单」确认通道结果。
        </div>

        <label>
          支付单号
          <Input
            value={refundForm.paymentNo}
            onChange={value => updateRefundForm("paymentNo", value)}
            placeholder="pay_xxx（从订单详情复制）"
            autoFocus
            autoComplete="off"
            spellCheck={false}
          />
          <span className="muted">只接受状态为 SUCCESS 的支付单；归档应用的支付单会被拒绝。</span>
        </label>

        <label>
          退款金额（元）
          <Input
            value={refundForm.amount}
            onChange={value => updateRefundForm("amount", value)}
            placeholder="例如 12.34"
            inputMode="decimal"
            autoComplete="off"
          />
          <span className="muted">
            {refundForm.amount.trim() === ""
              ? "必须显式填写，不会默认全额退款。"
              : cents === null ? "金额格式不对：最多两位小数的正数。" : `将退款 ${money(cents)}`}
          </span>
        </label>

        <label>
          退款原因
          <Input.TextArea
            rows={3}
            value={refundForm.reason}
            onChange={value => updateRefundForm("reason", value)}
            placeholder="例如：用户申请取消订单 / 重复扣款，已与本人确认"
          />
          <span className="muted">至少 2 个字，会写入退款单与事件时间线，作为审计依据。</span>
        </label>

        <div className="dialog-actions">
          {/* 退款是不可逆的资金动作：主按钮用 danger 主题，颜色本身就在提示后果 */}
          <Button type="primary" status="danger" loading={working} disabled={!canSubmit || working} onClick={() => void submitRefund()}>
            {working ? "提交中…" : cents === null ? "确认退款" : `确认退款 ${money(cents)}`}
          </Button>
          <Button disabled={working} onClick={() => setRefundForm(null)}>取消</Button>
        </div>
      </div>
    </Modal>}
  </>;
}
