"use client";

import { FileUp, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { api, useApi } from "../lib/api";
import { nextSortState, sortRows, type SortColumn } from "../lib/sort";
import { CopyValue, HoverDetail, LoadingState, PageHead, Section, SortableTh, Status, Toast, sortValueProps, money, time } from "./common";

type Run = {
  id: string; statementDate: string; status: string; fileName: string | null; importedCount: number; duplicateCount: number;
  matchedCount: number; mismatchedCount: number; unmatchedCount: number; skippedCount: number; errorMessage: string | null; completedAt: string | null;
};
type Receipt = {
  id: string; direction: "INCOME" | "REFUND"; providerTradeNo: string | null; merchantOrderNo: string | null;
  providerRefundNo: string | null; merchantRefundNo: string | null; amount: number; occurredAt: string; matchStatus: string;
  mismatchReason: string | null; payment: { paymentNo: string; order: { orderNo: string; subject: string } } | null;
  refund: { refundNo: string; externalRefundNo: string } | null;
};

// 批次表：列里显示的是"账单日期"和"完成时间"两个时间，分别给排序键。
const RUN_COLUMNS: SortColumn<Run>[] = [
  { key: "statementDate", label: "账单日期 / 文件", type: "date" },
  { key: "status", label: "状态" },
  // 「导入」单元格同时显示新增/重复/跳过，排序取新增数量（用户最关心的一项）
  { key: "importedCount", label: "导入", type: "number" },
  { key: "matchedCount", label: "匹配结果", type: "number" },
  { key: "completedAt", label: "完成时间", type: "date" },
];

// 流水表：业务列同时显示方向和时间，排序用时间（方向只有两种，作为排序键没有意义）。
const RECEIPT_COLUMNS: SortColumn<Receipt>[] = [
  { key: "occurredAt", label: "业务 / 时间", type: "date" },
  { key: "providerTradeNo", label: "账单标识", accessor: (row) => row.providerTradeNo ?? row.providerRefundNo ?? "" },
  { key: "amount", label: "金额", type: "number" },
  { key: "systemRecord", label: "系统记录", accessor: (row) => row.payment?.order.subject ?? "" },
  { key: "matchStatus", label: "匹配状态" },
];

export function Reconciliation() {
  const { data: runs, loading: runsLoading, error: runsError, reload: reloadRuns } = useApi<Run[]>("/reconciliation/runs?pageSize=20", 12_000);
  const [status, setStatus] = useState("");
  const receiptPath = useMemo(() => `/reconciliation/receipts?pageSize=100${status ? `&status=${status}` : ""}`, [status]);
  const { data: receipts, loading: receiptsLoading, error: receiptsError, reload: reloadReceipts } = useApi<Receipt[]>(receiptPath, 12_000);
  const [runSort, setRunSort] = useState(() => null as ReturnType<typeof nextSortState>);
  const [receiptSort, setReceiptSort] = useState(() => null as ReturnType<typeof nextSortState>);
  const [statementDate, setStatementDate] = useState(() => chinaDate(-1));
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [matching, setMatching] = useState("");
  const [notice, setNotice] = useState<{ type: "ok" | "error"; text: string } | null>(null);
  const runRows = useMemo(() => sortRows(runs ?? [], RUN_COLUMNS, runSort), [runs, runSort]);
  const receiptRows = useMemo(() => sortRows(receipts ?? [], RECEIPT_COLUMNS, receiptSort), [receipts, receiptSort]);

  async function upload() {
    if (!file || !statementDate) return;
    setUploading(true); setNotice(null);
    try {
      const csvText = decodeBill(await file.arrayBuffer());
      const result = await api<{ data: Run }>("/reconciliation/alipay/import", {
        method: "POST", body: JSON.stringify({ statementDate, fileName: file.name, csvText }),
      });
      const run = result.data;
      setNotice({ type: "ok", text: `导入完成：新增 ${run.importedCount} 条，匹配 ${run.matchedCount} 条，差错 ${run.mismatchedCount} 条，未匹配 ${run.unmatchedCount} 条。` });
      setFile(null);
      await Promise.all([reloadRuns(), reloadReceipts()]);
    } catch (cause) { setNotice({ type: "error", text: cause instanceof Error ? cause.message : "账单导入失败" }); }
    finally { setUploading(false); }
  }

  async function rematch(id: string) {
    setMatching(id); setNotice(null);
    try {
      await api(`/reconciliation/receipts/${id}/match`, { method: "POST" });
      setNotice({ type: "ok", text: "重新匹配完成。" });
      await Promise.all([reloadRuns(), reloadReceipts()]);
    } catch (cause) { setNotice({ type: "error", text: cause instanceof Error ? cause.message : "重新匹配失败" }); }
    finally { setMatching(""); }
  }

  const statusFilter = <select value={status} onChange={event => setStatus(event.target.value)} aria-label="匹配状态">
    <option value="">全部状态</option><option value="MISMATCH">存在差错</option><option value="UNMATCHED">未匹配</option><option value="PROCESSING">处理中</option><option value="MATCHED">已匹配</option>
  </select>;

  return <>
    <PageHead eyebrow="Alipay Reconciliation" title="支付宝账单对账" copy="上传支付宝交易明细 CSV；系统会幂等导入，逐笔核对单号、渠道流水和金额。" />
    {notice && <Toast type={notice.type} text={notice.text} onClose={() => setNotice(null)} />}
    <section className="card reconciliation-upload">
      <div className="upload-copy"><div className="upload-icon"><FileUp size={21} /></div><div><h2>导入日账单</h2><p>支持 UTF-8、GBK/GB18030 编码。重复上传不会重复入账。</p></div></div>
      <div className="upload-form">
        <label>账单日期<input type="date" value={statementDate} onChange={event => setStatementDate(event.target.value)} /></label>
        <label>支付宝 CSV<input type="file" accept=".csv,text/csv" onChange={event => setFile(event.target.files?.[0] ?? null)} /></label>
        <button className="button" disabled={!file || !statementDate || uploading} onClick={() => void upload()}>{uploading ? "导入中…" : "导入并对账"}</button>
      </div>
      <div className="channel-safety">账单日期用于归档。收入与退款只会通过支付核心的统一成功入口更新，不会直接改订单。</div>
    </section>

    <Section title="导入批次" action={<span className="muted">按账单日期幂等覆盖统计</span>} className="detail-section">
      <LoadingState loading={runsLoading} error={runsError} empty={!runs?.length} emptyText="还没有导入过支付宝账单">
        <div className="table-wrap"><table>
          <thead><tr>
            <SortableTh label="账单日期 / 文件" sortKey="statementDate" sort={runSort} onSort={key => setRunSort(nextSortState(runSort, key))} />
            <SortableTh label="状态" sortKey="status" sort={runSort} onSort={key => setRunSort(nextSortState(runSort, key))} />
            <SortableTh label="导入" sortKey="importedCount" sort={runSort} onSort={key => setRunSort(nextSortState(runSort, key))} />
            <SortableTh label="匹配结果" sortKey="matchedCount" sort={runSort} onSort={key => setRunSort(nextSortState(runSort, key))} />
            <SortableTh label="完成时间" sortKey="completedAt" sort={runSort} onSort={key => setRunSort(nextSortState(runSort, key))} />
          </tr></thead>
          <tbody>{runRows.map(run => <tr key={run.id}>
            <td {...sortValueProps(run, RUN_COLUMNS[0])}><strong>{shortDate(run.statementDate)}</strong><div className="muted">{run.fileName ?? "—"}</div></td>
            <td data-label="状态" {...sortValueProps(run, RUN_COLUMNS[1])}><HoverDetail text={run.errorMessage} tone="danger"><Status value={run.status} /></HoverDetail></td>
            <td data-label="导入" {...sortValueProps(run, RUN_COLUMNS[2])}>新增 {run.importedCount}<div className="muted">重复 {run.duplicateCount} / 跳过 {run.skippedCount}</div></td>
            <td data-label="匹配结果" {...sortValueProps(run, RUN_COLUMNS[3])}><span className="match-count ok">{run.matchedCount} 已匹配</span><div className="muted"><span className="match-count bad">{run.mismatchedCount} 差错</span> / {run.unmatchedCount} 未匹配</div></td>
            <td data-label="完成时间" {...sortValueProps(run, RUN_COLUMNS[4])}>{time(run.completedAt)}</td>
          </tr>)}</tbody>
        </table></div>
      </LoadingState>
    </Section>

    <Section title="标准化流水" action={statusFilter} className="detail-section">
      <LoadingState loading={receiptsLoading} error={receiptsError} empty={!receipts?.length} emptyText={status ? "当前筛选条件下没有对账流水" : "还没有标准化对账流水"}>
        <div className="table-wrap"><table>
          <thead><tr>
            <SortableTh label="业务 / 时间" sortKey="occurredAt" sort={receiptSort} onSort={key => setReceiptSort(nextSortState(receiptSort, key))} />
            <SortableTh label="账单标识" sortKey="providerTradeNo" sort={receiptSort} onSort={key => setReceiptSort(nextSortState(receiptSort, key))} />
            <SortableTh label="金额" sortKey="amount" sort={receiptSort} onSort={key => setReceiptSort(nextSortState(receiptSort, key))} alignRight />
            <SortableTh label="系统记录" sortKey="systemRecord" sort={receiptSort} onSort={key => setReceiptSort(nextSortState(receiptSort, key))} />
            <SortableTh label="匹配状态" sortKey="matchStatus" sort={receiptSort} onSort={key => setReceiptSort(nextSortState(receiptSort, key))} />
            <th scope="col">操作</th>
          </tr></thead>
          <tbody>{receiptRows.map(item => <tr key={item.id}>
            <td {...sortValueProps(item, RECEIPT_COLUMNS[0])}><strong>{item.direction === "INCOME" ? "收入" : "退款"}</strong><div className="muted">{time(item.occurredAt)}</div></td>
            <td data-label="账单标识" {...sortValueProps(item, RECEIPT_COLUMNS[1])}>
  {item.providerTradeNo ?? item.providerRefundNo ? <div className="id-line"><span className="mono">{item.providerTradeNo ?? item.providerRefundNo}</span><CopyValue value={item.providerTradeNo ?? item.providerRefundNo ?? ""} label="复制渠道流水号" /></div> : "—"}
  {item.merchantRefundNo ?? item.merchantOrderNo ? <div className="id-line"><span className="mono muted">{item.merchantRefundNo ?? item.merchantOrderNo}</span><CopyValue value={item.merchantRefundNo ?? item.merchantOrderNo ?? ""} label="复制商户单号" /></div> : null}
</td>
            <td data-label="金额" className="amount-cell" {...sortValueProps(item, RECEIPT_COLUMNS[2])}><strong>{money(item.amount)}</strong></td>
            <td data-label="系统记录" {...sortValueProps(item, RECEIPT_COLUMNS[3])}>{item.payment ? <><strong>{item.payment.order.subject}</strong><div className="id-line"><span className="mono muted">{item.refund?.refundNo ?? item.payment.paymentNo}</span><CopyValue value={item.refund?.refundNo ?? item.payment.paymentNo} label="复制系统单号" /></div></> : "—"}</td>
            <td data-label="匹配状态" {...sortValueProps(item, RECEIPT_COLUMNS[4])}><HoverDetail text={item.mismatchReason} tone="danger"><Status value={item.matchStatus} /></HoverDetail></td>
            <td data-label="操作">{item.matchStatus !== "MATCHED" && <button className="button secondary" disabled={matching !== ""} onClick={() => void rematch(item.id)}><RefreshCw size={13} />{matching === item.id ? "匹配中…" : "重新匹配"}</button>}</td>
          </tr>)}</tbody>
        </table></div>
      </LoadingState>
    </Section>
  </>;
}

function decodeBill(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(buffer);
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
  catch { return new TextDecoder("gb18030").decode(buffer); }
}

function chinaDate(offsetDays: number): string {
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000 + offsetDays * 86_400_000);
  return now.toISOString().slice(0, 10);
}

function shortDate(value: string): string { return value.slice(0, 10); }
