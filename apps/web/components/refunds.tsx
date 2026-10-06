"use client";

import { useMemo, useState } from "react";
import { api, useApi } from "../lib/api";
import { newRefundIdempotencyKey, parseYuanToCents } from "../lib/admin-refund";
import { nextSortState, sortRows, type SortColumn } from "../lib/sort";
import { CopyValue, HoverDetail, LoadingState, Modal, PageHead, SortableTh, Status, Toast, sortValueProps, money, time } from "./common";

type Refund = {
  id: string; refundNo: string; externalRefundNo: string; amount: number; status: string; reason: string | null; createdAt: string;
  queryAttempts: number; nextQueryAt: string | null; lastQueriedAt: string | null; errorMessage: string | null;
  application: { name: string; archivedAt: string | null }; payment: { paymentNo: string; order: { subject: string; deletedAt: string | null } };
};

const SORT_COLUMNS: SortColumn<Refund>[] = [
  { key: "refundNo", label: "退款单" },
  { key: "paymentNo", label: "支付单 / 应用", accessor: (row) => row.payment.paymentNo },
  { key: "amount", label: "金额", type: "number" },
  { key: "status", label: "状态 / 说明" },
  { key: "createdAt", label: "创建时间", type: "date" },
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
  const { data, loading, error, reload } = useApi<Refund[]>("/refunds?pageSize=100", 8_000);
  const [querying, setQuerying] = useState("");
  const [notice, setNotice] = useState<{ type: "ok" | "error"; text: string } | null>(null);
  const [sort, setSort] = useState(() => null as ReturnType<typeof nextSortState>);
  const [draft, setDraft] = useState<{ paymentNo: string; amount: string; reason: string; key: string } | null>(null);
  const [working, setWorking] = useState(false);
  const rows = useMemo(() => sortRows(data ?? [], SORT_COLUMNS, sort), [data, sort]);
  const cents = draft ? parseYuanToCents(draft.amount) : null;
  const canSubmit = Boolean(draft && draft.paymentNo.trim() && draft.reason.trim().length >= 2 && cents !== null);

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
  function updateDraft(field: "paymentNo" | "amount" | "reason", value: string) {
    setDraft(current => current ? { ...current, [field]: value, key: newRefundIdempotencyKey() } : current);
  }

  async function submitRefund() {
    if (!draft || cents === null || !canSubmit) return;
    setWorking(true);
    setNotice(null);
    try {
      await api("/refunds", { method: "POST", body: JSON.stringify({
        paymentNo: draft.paymentNo.trim(), amount: cents, reason: draft.reason.trim(), idempotencyKey: draft.key,
      }) });
      setNotice({ type: "ok", text: `退款已发起（${money(cents)}）。退款不会自动查单，请稍后用「主动查单」确认通道结果。` });
      setDraft(null);
      await reload();
    } catch (cause) {
      // 失败时保留弹窗与同一个幂等键：原样重试不会退成两笔。
      setNotice({ type: "error", text: cause instanceof Error ? cause.message : "退款发起失败" });
    } finally {
      setWorking(false);
    }
  }

  return <>
    <PageHead
      eyebrow="Reconciliation"
      title="退款记录"
      copy="退款有独立状态和幂等单号，UNKNOWN 会保留原状态而不会被误判失败；退款不再自动查单，需要时人工查单确认。"
      action={<button className="button" onClick={() => setDraft({ paymentNo: "", amount: "", reason: "", key: newRefundIdempotencyKey() })}>人工发起退款</button>}
    />
    {notice && <Toast type={notice.type} text={notice.text} onClose={() => setNotice(null)} />}
    <p className="muted">带「已归档」标记的退款来自已删除的应用：通道侧的钱已经动了，这些记录仍保留可查。系统不自动查单，未完成的退款请用「主动查单」人工确认。</p>
    <LoadingState loading={loading} error={error} empty={!data?.length}>
      <section className="card section"><div className="table-wrap"><table>
        <thead><tr>
          <SortableTh label="退款单" sortKey="refundNo" sort={sort} onSort={key => setSort(nextSortState(sort, key))} />
          <SortableTh label="支付单 / 应用" sortKey="paymentNo" sort={sort} onSort={key => setSort(nextSortState(sort, key))} />
          <SortableTh label="金额" sortKey="amount" sort={sort} onSort={key => setSort(nextSortState(sort, key))} alignRight />
          <SortableTh label="状态 / 说明" sortKey="status" sort={sort} onSort={key => setSort(nextSortState(sort, key))} />
          <SortableTh label="创建时间" sortKey="createdAt" sort={sort} onSort={key => setSort(nextSortState(sort, key))} />
          <th scope="col">操作</th>
        </tr></thead>
        <tbody>{rows.map(item => <tr key={item.id}>
          <td {...sortValueProps(item, SORT_COLUMNS[0])}>
            <strong>{item.payment.order.subject}</strong>
            <div className="id-line"><span className="mono muted">{item.refundNo}</span><CopyValue value={item.refundNo} label="复制退款单号" /></div>
            <div className="id-line"><span className="mono muted">{item.externalRefundNo}</span><CopyValue value={item.externalRefundNo} label="复制业务退款号" /></div>
            {item.reason && <div className="muted">{item.reason}</div>}
          </td>
          <td data-label="支付单" {...sortValueProps(item, SORT_COLUMNS[1])}>
            <div className="id-line"><span className="mono">{item.payment.paymentNo}</span><CopyValue value={item.payment.paymentNo} label="复制支付单号" /></div>
            <div className="muted">{item.application.name}{item.application.archivedAt && <span className="tag-archived">已归档</span>}</div>
          </td>
          <td data-label="金额" className="amount-cell" {...sortValueProps(item, SORT_COLUMNS[2])}><strong>{money(item.amount)}</strong></td>
          <td data-label="状态" {...sortValueProps(item, SORT_COLUMNS[3])}><HoverDetail text={refundRecovery(item)} tone={item.errorMessage ? "danger" : "muted"}><Status value={item.status} /></HoverDetail></td>
          <td data-label="创建时间" {...sortValueProps(item, SORT_COLUMNS[4])}>{time(item.createdAt)}{item.lastQueriedAt && <div className="muted">最近查询 {time(item.lastQueriedAt)}</div>}</td>
          <td data-label="操作">{item.status !== "SUCCESS" && <button className="button secondary" disabled={querying !== ""} onClick={() => void query(item.refundNo)}>{querying === item.refundNo ? "查询中…" : "主动查单"}</button>}</td>
        </tr>)}</tbody>
      </table></div></section>
    </LoadingState>

    {draft && <Modal title="人工发起退款" onClose={working ? () => undefined : () => setDraft(null)}>
      <div className="resolution-form">
        <div className="dialog-warning">
          退款会立即向支付通道真实打款，不可撤销。系统不自动执行退款，这张退款单也不会被自动查单：发起后请用「主动查单」确认通道结果。
        </div>

        <label>
          支付单号
          <input
            value={draft.paymentNo}
            onChange={event => updateDraft("paymentNo", event.target.value)}
            placeholder="pay_xxx（从订单详情复制）"
            autoFocus
            autoComplete="off"
            spellCheck={false}
          />
          <span className="muted">只接受状态为 SUCCESS 的支付单；归档应用的支付单会被拒绝。</span>
        </label>

        <label>
          退款金额（元）
          <input
            value={draft.amount}
            onChange={event => updateDraft("amount", event.target.value)}
            placeholder="例如 12.34"
            inputMode="decimal"
            autoComplete="off"
          />
          <span className="muted">
            {draft.amount.trim() === ""
              ? "必须显式填写，不会默认全额退款。"
              : cents === null ? "金额格式不对：最多两位小数的正数。" : `将退款 ${money(cents)}`}
          </span>
        </label>

        <label>
          退款原因
          <textarea
            rows={3}
            value={draft.reason}
            onChange={event => updateDraft("reason", event.target.value)}
            placeholder="例如：用户申请取消订单 / 重复扣款，已与本人确认"
          />
          <span className="muted">至少 2 个字，会写入退款单与事件时间线，作为审计依据。</span>
        </label>

        <div className="dialog-actions">
          <button className="button danger" disabled={!canSubmit || working} onClick={() => void submitRefund()}>
            {working ? "提交中…" : cents === null ? "确认退款" : `确认退款 ${money(cents)}`}
          </button>
          <button className="button secondary" disabled={working} onClick={() => setDraft(null)}>取消</button>
        </div>
      </div>
    </Modal>}
  </>;
}
