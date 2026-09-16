"use client";

import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { api, useApi } from "../lib/api";
import { money, statusText } from "./common";

type Payment = { paymentNo: string; status: string; channel: string; amount: number; businessAmount: number; currency: string; subject: string; payable: boolean; validUntil: string | null; clientPayload: { type?: string; value?: string; remark?: string | null; validUntil?: string | null } | null; returnUrl: string | null };

export function Cashier({ paymentNo }: { paymentNo: string }) {
  const { data, loading, error, reload } = useApi<Payment>(`/public/payments/${paymentNo}`, 2_000);
  const [qr, setQr] = useState("");
  const [qrError, setQrError] = useState("");
  const [actionError, setActionError] = useState("");
  const [paying, setPaying] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const deadline = data?.validUntil ? Date.parse(data.validUntil) : null;
  const canPay = Boolean(data?.payable && !error && (deadline === null || now < deadline));
  useEffect(() => {
    let active = true;
    setQr("");
    setQrError("");
    if (canPay && data?.clientPayload?.type === "qr_code" && data.clientPayload.value) {
      void QRCode.toDataURL(data.clientPayload.value, { width: 420, margin: 1 })
        .then(value => { if (active) setQr(value); })
        .catch(() => { if (active) setQrError("付款二维码生成失败，请刷新页面重试。"); });
    }
    return () => { active = false; };
  }, [data?.clientPayload, canPay]);
  async function mockPay() {
    setPaying(true);
    setActionError("");
    try { await api(`/mock/${paymentNo}/succeed`, { method: "POST" }); await reload(); }
    catch (cause) { setActionError(cause instanceof Error ? cause.message : "模拟支付失败"); }
    finally { setPaying(false); }
  }
  const paid = data?.status === "SUCCESS";
  return <div className="cashier-shell"><section className="card cashier">
    <div className="brand-badge">T</div>
    {loading && <div className="loading">正在读取订单…</div>}
    {error && <div className="error">{error}</div>}
    {data && <>
      <div className="eyebrow">TUOXIN PAY</div><h1>{data.subject}</h1><div className="amount">{money(data.amount)}</div>
      {paid ? <><div className="cashier-state success">✓ 支付成功</div><p className="muted">支付结果已经确认，可以安全返回。</p>{data.returnUrl && <a className="button" href={data.returnUrl}>返回业务页面</a>}</>
        : data.status === "FAILED" ? <div className="cashier-state failure"><strong>支付发起失败</strong><span>请返回业务页面重新创建支付。</span></div>
        : data.status === "CLOSED" ? <div className="cashier-state neutral"><strong>支付已关闭</strong><span>请勿继续付款；个人静态收款码无法撤销，请返回业务页面重新发起支付。</span></div>
        : data.status === "UNKNOWN" ? <div className="cashier-state warning"><strong>正在确认支付结果</strong><span>请不要重复付款，系统将通过回调或主动查单确认结果。</span></div>
        : !canPay ? <div className="cashier-state neutral"><strong>当前支付不可继续</strong><span>订单已过期、业务已结束或暂时无法核实状态，请勿付款。如果已经付款，请等待确认或联系管理员，不要重复支付。</span></div>
        : data.channel === "MOCK" ? <><p className="muted">当前为开发环境模拟支付，不会产生真实扣款。</p><button className="button" onClick={() => void mockPay()} disabled={paying}>{paying ? "处理中…" : "模拟支付成功"}</button></>
        : <>{qrError ? <div className="cashier-state failure">{qrError}</div> : qr ? <img className="qr" src={qr} alt="支付宝付款二维码" /> : <div className="loading compact">正在生成二维码…</div>}{data.channel === "ALIPAY_BILL" ? <div className="cashier-state warning"><strong>必须支付精确金额 {money(data.amount)}</strong>{data.clientPayload?.remark && <span>付款备注请填写：<b className="mono">{data.clientPayload.remark}</b></span>}<span>不要修改金额或重复付款；到账后页面会自动确认。</span></div> : <p className="muted">请使用支付宝扫码完成付款，页面会自动确认结果。</p>}</>}
      {actionError && <div className="operation-notice error" aria-live="polite">{actionError}</div>}
      {canPay && deadline !== null && <p className="muted">剩余付款时间：{Math.max(0, Math.ceil((deadline - now) / 1000))} 秒</p>}
      {data.channel === "ALIPAY_BILL" && <p className="muted">请勿保存、转发收款码或在其他订单复用。款项直接进入支付宝收款账号；备注错误、金额不符或超时付款可能需要人工核对。</p>}
      <div className="cashier-meta"><span className="mono">{data.paymentNo}</span><span>{statusText(data.status)}</span></div>
    </>}
  </section></div>;
}
