"use client";

import { FileUp, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { api, useApi } from "../lib/api";
import { LoadingState, PageHead, Status, money, time } from "./common";

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

export function Reconciliation() {
  const { data: runs, loading: runsLoading, error: runsError, reload: reloadRuns } = useApi<Run[]>("/reconciliation/runs?pageSize=20", 12_000);
  const [status, setStatus] = useState("");
  const receiptPath = useMemo(() => `/reconciliation/receipts?pageSize=100${status ? `&status=${status}` : ""}`, [status]);
  const { data: receipts, loading: receiptsLoading, error: receiptsError, reload: reloadReceipts } = useApi<Receipt[]>(receiptPath, 12_000);
  const [statementDate, setStatementDate] = useState(() => chinaDate(-1));
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [matching, setMatching] = useState("");
  const [notice, setNotice] = useState<{ type: "ok" | "error"; text: string } | null>(null);

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

  return <>
    <PageHead eyebrow="Alipay Reconciliation" title="支付宝账单对账" copy="上传支付宝交易明细 CSV；系统会幂等导入，逐笔核对单号、渠道流水和金额。" />
    {notice && <div className={`operation-notice ${notice.type}`}>{notice.text}</div>}
    <section className="card reconciliation-upload">
      <div className="upload-copy"><div className="upload-icon"><FileUp size={21} /></div><div><h2>导入日账单</h2><p>支持 UTF-8、GBK/GB18030 编码。重复上传不会重复入账。</p></div></div>
      <div className="upload-form">
        <label>账单日期<input type="date" value={statementDate} onChange={event => setStatementDate(event.target.value)} /></label>
        <label>支付宝 CSV<input type="file" accept=".csv,text/csv" onChange={event => setFile(event.target.files?.[0] ?? null)} /></label>
        <button className="button" disabled={!file || !statementDate || uploading} onClick={() => void upload()}>{uploading ? "导入中…" : "导入并对账"}</button>
      </div>
      <div className="channel-safety">账单日期用于归档。收入与退款只会通过支付核心的统一成功入口更新，不会直接改订单。</div>
    </section>

    <section className="card section detail-section">
      <div className="section-title"><h2>导入批次</h2><span className="muted">按账单日期幂等覆盖统计</span></div>
      <LoadingState loading={runsLoading} error={runsError} empty={!runs?.length}>
        <div className="table-wrap"><table><thead><tr><th>账单日期 / 文件</th><th>状态</th><th>导入</th><th>匹配结果</th><th>完成时间</th></tr></thead><tbody>
          {runs?.map(run => <tr key={run.id}><td><strong>{shortDate(run.statementDate)}</strong><div className="muted">{run.fileName ?? "—"}</div></td><td><Status value={run.status} />{run.errorMessage && <div className="row-error">{run.errorMessage}</div>}</td><td>新增 {run.importedCount}<div className="muted">重复 {run.duplicateCount} / 跳过 {run.skippedCount}</div></td><td><span className="match-count ok">{run.matchedCount} 已匹配</span><div className="muted"><span className="match-count bad">{run.mismatchedCount} 差错</span> / {run.unmatchedCount} 未匹配</div></td><td>{time(run.completedAt)}</td></tr>)}
        </tbody></table></div>
      </LoadingState>
    </section>

    <section className="card section detail-section">
      <div className="section-title"><h2>标准化流水</h2><select value={status} onChange={event => setStatus(event.target.value)} aria-label="匹配状态"><option value="">全部状态</option><option value="MISMATCH">存在差错</option><option value="UNMATCHED">未匹配</option><option value="PROCESSING">处理中</option><option value="MATCHED">已匹配</option></select></div>
      <LoadingState loading={receiptsLoading} error={receiptsError} empty={!receipts?.length}>
        <div className="table-wrap"><table><thead><tr><th>业务 / 时间</th><th>账单标识</th><th>金额</th><th>系统记录</th><th>匹配状态</th><th>操作</th></tr></thead><tbody>
          {receipts?.map(item => <tr key={item.id}><td><strong>{item.direction === "INCOME" ? "收入" : "退款"}</strong><div className="muted">{time(item.occurredAt)}</div></td><td><div className="mono">{item.providerTradeNo ?? item.providerRefundNo ?? "—"}</div><div className="mono muted">{item.merchantRefundNo ?? item.merchantOrderNo ?? "—"}</div></td><td><strong>{money(item.amount)}</strong></td><td>{item.payment ? <><strong>{item.payment.order.subject}</strong><div className="mono muted">{item.refund?.refundNo ?? item.payment.paymentNo}</div></> : "—"}</td><td><Status value={item.matchStatus} />{item.mismatchReason && <div className="row-error">{item.mismatchReason}</div>}</td><td>{item.matchStatus !== "MATCHED" && <button className="button secondary" disabled={matching !== ""} onClick={() => void rematch(item.id)}><RefreshCw size={13} />{matching === item.id ? "匹配中…" : "重新匹配"}</button>}</td></tr>)}
        </tbody></table></div>
      </LoadingState>
    </section>
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
