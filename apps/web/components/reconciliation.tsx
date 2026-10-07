"use client";

import { Button, DatePicker, Table, Upload } from "@arco-design/web-react";
import type { ColumnProps } from "@arco-design/web-react/es/Table";
import type { UploadItem } from "@arco-design/web-react/es/Upload";
import { FileUp } from "lucide-react";
import { useMemo, useState } from "react";
import { api, useApi } from "../lib/api";
import { sortRows, type SortColumn } from "../lib/sort";
import { CopyValue, HoverDetail, LoadingState, PageHead, Status, Toast, sortValueProps, money, time } from "./common";
import { FilterCard, FilterItem, FilterSelect, ListCard, ListPage, Pager, ToolbarNote, sortHeader, useClientPager, useTableSort } from "./list";

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

const STATUS_OPTIONS = [
  { label: "全部状态", value: "" },
  { label: "存在差错", value: "MISMATCH" },
  { label: "未匹配", value: "UNMATCHED" },
  { label: "处理中", value: "PROCESSING" },
  { label: "已匹配", value: "MATCHED" },
];

export function Reconciliation() {
  const { data: runs, loading: runsLoading, error: runsError, reload: reloadRuns } = useApi<Run[]>("/reconciliation/runs?pageSize=20", 12_000);
  // 状态筛选分「草稿」和「已生效」两份：下拉里换选项时不打接口，点「查询」才把条件写进请求路径，
  // 与订单列表保持一致（避免每换一次选项就整表重新拉取、整块骨架闪烁）。
  const [draftStatus, setDraftStatus] = useState("");
  const [status, setStatus] = useState("");
  const receiptPath = useMemo(() => `/reconciliation/receipts?pageSize=100${status ? `&status=${status}` : ""}`, [status]);
  const { data: receipts, loading: receiptsLoading, error: receiptsError, reload: reloadReceipts } = useApi<Receipt[]>(receiptPath, 12_000);
  const { sort: runSort, onSort: onRunSort } = useTableSort<Run>();
  const { sort: receiptSort, onSort: onReceiptSort } = useTableSort<Receipt>();
  const [statementDate, setStatementDate] = useState(() => chinaDate(-1));
  // 选中的文件交给 Arco Upload 的受控 fileList，真正上传时只取 originFile：
  // 账单要先在前端解码成文本（UTF-8/GBK 兜底），Upload 的内置上传用不上。
  const [fileList, setFileList] = useState<UploadItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [matching, setMatching] = useState("");
  const [notice, setNotice] = useState<{ type: "ok" | "error"; text: string } | null>(null);
  const file = fileList[0]?.originFile ?? null;
  const runRows = useMemo(() => sortRows(runs ?? [], RUN_COLUMNS, runSort), [runs, runSort]);
  const receiptRows = useMemo(() => sortRows(receipts ?? [], RECEIPT_COLUMNS, receiptSort), [receipts, receiptSort]);
  const runPager = useClientPager(runRows, 20);
  const receiptPager = useClientPager(receiptRows, 20);

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
      setFileList([]);
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

  const runColumns: ColumnProps<Run>[] = [
    {
      title: sortHeader(RUN_COLUMNS[0], runSort, onRunSort),
      dataIndex: "statementDate",
      render: (_: unknown, run: Run) => <span {...sortValueProps(run, RUN_COLUMNS[0])}><strong>{shortDate(run.statementDate)}</strong><div className="muted">{run.fileName ?? "—"}</div></span>,
    },
    {
      title: sortHeader(RUN_COLUMNS[1], runSort, onRunSort),
      dataIndex: "status",
      width: 140,
      render: (_: unknown, run: Run) => <span {...sortValueProps(run, RUN_COLUMNS[1])}><HoverDetail text={run.errorMessage} tone="danger"><Status value={run.status} /></HoverDetail></span>,
    },
    {
      title: sortHeader(RUN_COLUMNS[2], runSort, onRunSort),
      dataIndex: "importedCount",
      width: 170,
      render: (_: unknown, run: Run) => <span {...sortValueProps(run, RUN_COLUMNS[2])}>新增 {run.importedCount}<div className="muted">重复 {run.duplicateCount} / 跳过 {run.skippedCount}</div></span>,
    },
    {
      title: sortHeader(RUN_COLUMNS[3], runSort, onRunSort),
      dataIndex: "matchedCount",
      width: 210,
      render: (_: unknown, run: Run) => <span {...sortValueProps(run, RUN_COLUMNS[3])}><span className="match-count ok">{run.matchedCount} 已匹配</span><div className="muted"><span className="match-count bad">{run.mismatchedCount} 差错</span> / {run.unmatchedCount} 未匹配</div></span>,
    },
    {
      title: sortHeader(RUN_COLUMNS[4], runSort, onRunSort),
      dataIndex: "completedAt",
      width: 190,
      render: (_: unknown, run: Run) => <span {...sortValueProps(run, RUN_COLUMNS[4])}>{time(run.completedAt)}</span>,
    },
  ];

  const receiptColumns: ColumnProps<Receipt>[] = [
    {
      title: sortHeader(RECEIPT_COLUMNS[0], receiptSort, onReceiptSort),
      dataIndex: "occurredAt",
      width: 190,
      render: (_: unknown, item: Receipt) => <span {...sortValueProps(item, RECEIPT_COLUMNS[0])}><strong>{item.direction === "INCOME" ? "收入" : "退款"}</strong><div className="muted">{time(item.occurredAt)}</div></span>,
    },
    {
      title: sortHeader(RECEIPT_COLUMNS[1], receiptSort, onReceiptSort),
      dataIndex: "providerTradeNo",
      width: 230,
      render: (_: unknown, item: Receipt) => <span {...sortValueProps(item, RECEIPT_COLUMNS[1])}>
        {item.providerTradeNo ?? item.providerRefundNo ? <div className="id-line"><span className="mono">{item.providerTradeNo ?? item.providerRefundNo}</span><CopyValue value={item.providerTradeNo ?? item.providerRefundNo ?? ""} label="复制渠道流水号" /></div> : "—"}
        {item.merchantRefundNo ?? item.merchantOrderNo ? <div className="id-line"><span className="mono muted">{item.merchantRefundNo ?? item.merchantOrderNo}</span><CopyValue value={item.merchantRefundNo ?? item.merchantOrderNo ?? ""} label="复制商户单号" /></div> : null}
      </span>,
    },
    {
      title: sortHeader(RECEIPT_COLUMNS[2], receiptSort, onReceiptSort),
      dataIndex: "amount",
      align: "right",
      className: "amount-cell",
      width: 130,
      render: (_: unknown, item: Receipt) => <strong {...sortValueProps(item, RECEIPT_COLUMNS[2])}>{money(item.amount)}</strong>,
    },
    {
      title: sortHeader(RECEIPT_COLUMNS[3], receiptSort, onReceiptSort),
      dataIndex: "systemRecord",
      width: 230,
      render: (_: unknown, item: Receipt) => <span {...sortValueProps(item, RECEIPT_COLUMNS[3])}>{item.payment ? <><strong>{item.payment.order.subject}</strong><div className="id-line"><span className="mono muted">{item.refund?.refundNo ?? item.payment.paymentNo}</span><CopyValue value={item.refund?.refundNo ?? item.payment.paymentNo} label="复制系统单号" /></div></> : "—"}</span>,
    },
    {
      title: sortHeader(RECEIPT_COLUMNS[4], receiptSort, onReceiptSort),
      dataIndex: "matchStatus",
      width: 140,
      render: (_: unknown, item: Receipt) => <span {...sortValueProps(item, RECEIPT_COLUMNS[4])}><HoverDetail text={item.mismatchReason} tone="danger"><Status value={item.matchStatus} /></HoverDetail></span>,
    },
    {
      title: "操作",
      dataIndex: "actions",
      width: 110,
      render: (_: unknown, item: Receipt) => item.matchStatus !== "MATCHED"
        ? <button type="button" className="link-button" disabled={matching !== ""} onClick={() => void rematch(item.id)}>{matching === item.id ? "匹配中…" : "重新匹配"}</button>
        : null,
    },
  ];

  return <>
    <PageHead eyebrow="Alipay Reconciliation" title="支付宝账单对账" copy="上传支付宝交易明细 CSV；系统会幂等导入，逐笔核对单号、渠道流水和金额。" />
    {notice && <Toast type={notice.type} text={notice.text} onClose={() => setNotice(null)} />}
    <section className="card reconciliation-upload">
      <div className="upload-copy"><div className="upload-icon"><FileUp size={21} aria-hidden="true" /></div><div><h2>导入日账单</h2><p>支持 UTF-8、GBK/GB18030 编码。重复上传不会重复入账。</p></div></div>
      <div className="upload-form">
        {/* 日期用 Arco DatePicker：值就是 YYYY-MM-DD 字符串，与接口归档口径一致，不需要再转换 */}
        <label>账单日期<DatePicker value={statementDate} format="YYYY-MM-DD" allowClear={false} style={{ width: "100%" }} onChange={(value) => setStatementDate(value)} /></label>
        <label>支付宝 CSV
          {/* 只保留最后选中的那个文件：文件列表不展示，攒着旧文件会让「导入并对账」用错账单 */}
          <Upload accept=".csv,text/csv" autoUpload={false} showUploadList={false} fileList={fileList} onChange={(list) => setFileList(list.length ? [list[list.length - 1]] : [])}>
            <Button>{file ? file.name : "选择 CSV 文件"}</Button>
          </Upload>
        </label>
        <Button type="primary" disabled={!file || !statementDate} loading={uploading} onClick={() => void upload()}>{uploading ? "导入中…" : "导入并对账"}</Button>
      </div>
      <div className="channel-safety">账单日期用于归档。收入与退款只会通过支付核心的统一成功入口更新，不会直接改订单。</div>
    </section>

    <ListPage>
      <LoadingState loading={runsLoading} error={runsError} empty={!runs?.length} emptyText="还没有导入过支付宝账单">
        <ListCard
          toolbar={<><strong>导入批次</strong><ToolbarNote>共 {runRows.length} 个 · 按账单日期幂等覆盖统计</ToolbarNote></>}
          pagination={<Pager total={runPager.total} page={runPager.page} pageSize={runPager.pageSize} onChange={runPager.setPage} onPageSizeChange={runPager.setPageSize} />}
        >
          <Table<Run>
            className="list-table"
            columns={runColumns}
            data={runPager.rows}
            rowKey="id"
            pagination={false}
            borderCell={false}
            loading={false}
            noDataElement={<div className="empty compact">没有符合条件的导入批次</div>}
          />
        </ListCard>
      </LoadingState>
    </ListPage>

    {/* 两张 ListPage 之间没有现成的外边距规则（admin.css 已冻结），这里用外层 div 补 16px */}
    <div style={{ marginTop: 16 }}>
      <ListPage>
        <FilterCard onSearch={() => setStatus(draftStatus)} onReset={() => { setDraftStatus(""); setStatus(""); }}>
          <FilterItem label="匹配状态"><FilterSelect value={draftStatus} onChange={setDraftStatus} options={STATUS_OPTIONS} /></FilterItem>
        </FilterCard>
        <LoadingState loading={receiptsLoading} error={receiptsError} empty={!receipts?.length} emptyText={status ? "当前筛选条件下没有对账流水" : "还没有标准化对账流水"}>
          <ListCard
            toolbar={<><strong>标准化流水</strong><ToolbarNote>共 {receiptRows.length} 条 · 状态筛选在服务端执行</ToolbarNote></>}
            pagination={<Pager total={receiptPager.total} page={receiptPager.page} pageSize={receiptPager.pageSize} onChange={receiptPager.setPage} onPageSizeChange={receiptPager.setPageSize} />}
          >
            <Table<Receipt>
              className="list-table"
              columns={receiptColumns}
              data={receiptPager.rows}
              rowKey="id"
              pagination={false}
              borderCell={false}
              loading={false}
              noDataElement={<div className="empty compact">没有符合条件的对账流水</div>}
            />
          </ListCard>
        </LoadingState>
      </ListPage>
    </div>
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
