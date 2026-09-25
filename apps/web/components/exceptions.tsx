"use client";

import Link from "next/link";
import { useState } from "react";
import { api, useApi } from "../lib/api";
import { CopyValue, LoadingState, Modal, PageHead, Section, Status, Toast, money, time } from "./common";
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

export function Exceptions() {
  const [status, setStatus] = useState("");
  const { data, loading, error, reload } = useApi<PaymentException[]>(`/exceptions?pageSize=100${status ? `&status=${status}` : ""}`, 10_000);
  const [working, setWorking] = useState("");
  const [notice, setNotice] = useState<{ type: "ok" | "error"; text: string } | null>(null);
  const [pending, setPending] = useState<{ item: PaymentException; next: FinalAction } | null>(null);
  const [resolution, setResolution] = useState("");
  const [resolutionRef, setResolutionRef] = useState("");

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
    if (ok) setPending(null);
  }

  const statusFilter = <select value={status} onChange={event => setStatus(event.target.value)} aria-label="异常状态">
    <option value="">全部状态</option>
    <option value="OPEN">待处理</option>
    <option value="PROCESSING">处理中</option>
    <option value="RESOLVED">已解决</option>
    <option value="IGNORED">已忽略</option>
  </select>;

  return <>
    <PageHead eyebrow="Payment Exceptions" title="支付异常" copy="晚到重复付款、流水多候选和状态冲突必须在这里形成明确处置记录。" />
    {notice && <Toast type={notice.type} text={notice.text} onClose={() => setNotice(null)} />}

    <Section title="异常处置队列" action={statusFilter}>
      <LoadingState loading={loading} error={error} empty={!data?.length}>
        <div className="table-wrap"><table>
          <thead><tr><th>异常 / 风险</th><th>订单与支付</th><th>金额 / 渠道流水</th><th>状态</th><th>发现时间</th><th>处置</th></tr></thead>
          <tbody>{data?.map(item => <tr key={item.id}>
            <td>
              <strong>{exceptionTypeLabel(item.type)}</strong>
              <div className="row-error">{item.summary}</div>
              <div className="id-line"><span className="mono muted">{item.exceptionNo}</span><CopyValue value={item.exceptionNo} label="复制异常单号" /></div>
              <div className="muted">{eventSourceLabel(item.source)}</div>
            </td>

            <td data-label="订单与支付">
              {item.order ? <>
                <Link className="data-link" href={`/orders/${item.order.orderNo}`}><strong>{item.order.subject}</strong></Link>
                <div className="id-line"><span className="mono muted">{item.order.orderNo}</span><CopyValue value={item.order.orderNo} label="复制订单号" /></div>
              </> : "—"}
              {item.payment && <div className="id-line"><span className="mono muted">{item.payment.paymentNo}</span><CopyValue value={item.payment.paymentNo} label="复制支付单号" /></div>}
            </td>

            <td data-label="金额 / 流水">
              {item.payment ? <>
                <strong>{money(item.payment.receivedAmount ?? item.payment.amount)}</strong>
                {item.payment.receivedAmount && item.payment.receivedAmount !== item.payment.amount && <div className="muted">业务金额 {money(item.payment.amount)}</div>}
                {item.payment.channelTradeNo
                  ? <div className="id-line"><span className="mono muted">{item.payment.channelTradeNo}</span><CopyValue value={item.payment.channelTradeNo} label="复制渠道流水" /></div>
                  : <div className="muted">无渠道流水</div>}
              </> : "—"}
            </td>

            <td data-label="状态">
              <Status value={item.status} />
              <div className={`severity ${item.severity}`}>{exceptionSeverityLabel(item.severity)}</div>
              {item.resolution && <div className="muted">{item.resolution}</div>}
              {item.resolutionRef && <div className="id-line"><span className="mono muted">{item.resolutionRef}</span><CopyValue value={item.resolutionRef} label="复制处置凭证" /></div>}
            </td>

            <td data-label="发现时间">{time(item.detectedAt)}{item.resolvedAt && <div className="muted">完成 {time(item.resolvedAt)}</div>}</td>

            <td data-label="处置">
              <div className="row-actions">
                {item.status === "OPEN" && <button className="button secondary" disabled={working !== ""} onClick={() => void update(item, "PROCESSING")}>{working === item.id ? "处理中…" : "开始处理"}</button>}
                {["OPEN", "PROCESSING"].includes(item.status) && <>
                  <button className="button" disabled={working !== ""} onClick={() => openFinal(item, "RESOLVED")}>标记解决</button>
                  <button className="button danger" disabled={working !== ""} onClick={() => openFinal(item, "IGNORED")}>忽略</button>
                </>}
              </div>
            </td>
          </tr>)}</tbody>
        </table></div>
      </LoadingState>
    </Section>

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
          <textarea
            rows={4}
            value={resolution}
            onChange={event => setResolution(event.target.value)}
            placeholder={pending.next === "RESOLVED" ? "例如：已核对渠道流水并完成原路退款" : "例如：确认是测试交易，无需继续处置"}
            autoFocus
          />
        </label>

        {pending.next === "RESOLVED" && <label>
          处置凭证（可选）
          <input value={resolutionRef} onChange={event => setResolutionRef(event.target.value)} placeholder="退款单号 / 外部凭证号" />
        </label>}

        {pending.next === "IGNORED" && <div className="dialog-warning">忽略后该异常将退出待处理队列，但处置记录仍会永久保留。</div>}

        <div className="dialog-actions">
          <button className={pending.next === "IGNORED" ? "button danger" : "button"} disabled={!resolution.trim() || working !== ""} onClick={() => void submitFinal()}>
            {working ? "提交中…" : pending.next === "RESOLVED" ? "确认解决" : "确认忽略"}
          </button>
          <button className="button secondary" disabled={working !== ""} onClick={() => setPending(null)}>取消</button>
        </div>
      </div>
    </Modal>}
  </>;
}
