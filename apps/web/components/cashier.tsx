"use client";

import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { api, useApi } from "../lib/api";
import { money, statusText } from "./common";

type Payment = { paymentNo: string; status: string; channel: string; amount: number; businessAmount: number; currency: string; subject: string; clientPayload: { type?: string; value?: string; remark?: string | null; validUntil?: string | null } | null; returnUrl: string | null };

export function Cashier({ paymentNo }: { paymentNo: string }) {
  const { data, loading, error, reload } = useApi<Payment>(`/public/payments/${paymentNo}`, 2_000);
  const [qr, setQr] = useState("");
  const [qrError, setQrError] = useState("");
  const [actionError, setActionError] = useState("");
  const [paying, setPaying] = useState(false);
  useEffect(() => {
    let active = true;
    setQr("");
    setQrError("");
    if (data?.clientPayload?.type === "qr_code" && data.clientPayload.value) {
      void QRCode.toDataURL(data.clientPayload.value, { width: 420, margin: 1 })
        .then(value => { if (active) setQr(value); })
        .catch(() => { if (active) setQrError("付款二维码生成失败，请刷新页面重试。"); });
    }
    return () => { active = false; };
  }, [data?.clientPayload]);
  async function mockPay() {
    setPaying(true);
    setActionError("");
    try { await api(`/mock/${paymentNo}/succeed`, { method: "POST" }); await reload(); }
    catch (cause) { setActionError(cause instanceof Error ? cause.message : "模拟支付失败"); }
    finally { setPaying(false); }
  }
  const paid = data?.status === "SUCCESS";
  return <div className="cashier-shell"><section className="card cashier">
    <div className="cashier-logo">T</div>
    {loading && <div className="loading">正在读取订单…</div>}
    {error && <div className="error">{error}</div>}
    {data && <>
      <div className="eyebrow">TUOXIN PAY</div><h1>{data.subject}</h1><div className="amount">{money(data.amount)}</div>
      {paid ? <><div className="cashier-state success">✓ 支付成功</div><p className="muted">支付结果已经确认，可以安全返回。</p>{data.returnUrl && <a className="button" href={data.returnUrl}>返回业务页面</a>}</>
        : data.status === "FAILED" ? <div className="cashier-state failure"><strong>支付发起失败</strong><span>请返回业务页面重新创建支付。</span></div>
        : data.status === "CLOSED" ? <div className="cashier-state neutral"><strong>支付已关闭</strong><span>当前付款码已经失效，请重新发起支付。</span></div>
        : data.status === "UNKNOWN" ? <div className="cashier-state warning"><strong>正在确认支付结果</strong><span>请不要重复付款，系统将通过回调或主动查单确认结果。</span></div>
        : data.channel === "MOCK" ? <><p className="muted">当前为开发环境模拟支付，不会产生真实扣款。</p><button className="button" onClick={() => void mockPay()} disabled={paying}>{paying ? "处理中…" : "模拟支付成功"}</button></>
        : <>{qrError ? <div className="cashier-state failure">{qrError}</div> : qr ? <img className="qr" src={qr} alt="支付宝付款二维码" /> : <div className="loading compact">正在生成二维码…</div>}{data.channel === "ALIPAY_BILL" ? <div className="cashier-state warning"><strong>必须支付精确金额 {money(data.amount)}</strong>{data.clientPayload?.remark && <span>付款备注请填写：<b className="mono">{data.clientPayload.remark}</b></span>}<span>不要修改金额或重复付款；到账后页面会自动确认。</span></div> : <p className="muted">请使用支付宝扫码完成付款，页面会自动确认结果。</p>}</>}
      {actionError && <div className="operation-notice error" aria-live="polite">{actionError}</div>}
      <div className="cashier-meta"><span className="mono">{data.paymentNo}</span><span>{statusText(data.status)}</span></div>
    </>}
  </section></div>;
}
