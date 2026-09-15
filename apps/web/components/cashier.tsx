"use client";

import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { api, useApi } from "../lib/api";
import { money } from "./common";

type Payment = { paymentNo: string; status: string; channel: string; amount: number; currency: string; subject: string; clientPayload: { type?: string; value?: string } | null; returnUrl: string | null };

export function Cashier({ paymentNo }: { paymentNo: string }) {
  const { data, loading, error, reload } = useApi<Payment>(`/public/payments/${paymentNo}`, 2_000);
  const [qr, setQr] = useState("");
  const [paying, setPaying] = useState(false);
  useEffect(() => {
    if (data?.clientPayload?.type === "qr_code" && data.clientPayload.value) void QRCode.toDataURL(data.clientPayload.value, { width: 420, margin: 1 }).then(setQr);
  }, [data?.clientPayload]);
  async function mockPay() {
    setPaying(true);
    try { await api(`/mock/${paymentNo}/succeed`, { method: "POST" }); await reload(); }
    finally { setPaying(false); }
  }
  const paid = data && ["SUCCESS"].includes(data.status);
  return <div className="cashier-shell"><section className="card cashier">
    <div className="cashier-logo">T</div>
    {loading && <div className="loading">正在读取订单…</div>}
    {error && <div className="error">{error}</div>}
    {data && <>
      <div className="eyebrow">TUOXIN PAY</div><h1>{data.subject}</h1><div className="amount">{money(data.amount)}</div>
      {paid ? <><div className="paid">✓ 支付成功</div>{data.returnUrl && <a className="button" href={data.returnUrl}>返回业务页面</a>}</>
        : data.channel === "MOCK" ? <><p className="muted">当前为开发环境模拟支付，不会产生真实扣款。</p><button className="button" onClick={() => void mockPay()} disabled={paying}>{paying ? "处理中…" : "模拟支付成功"}</button></>
        : <>{qr ? <img className="qr" src={qr} alt="支付宝付款二维码" /> : <div className="loading">正在生成二维码…</div>}<p className="muted">请使用支付宝扫码完成付款</p></>}
      <div className="mono muted" style={{ marginTop: 24 }}>{data.paymentNo}<br />{data.status}</div>
    </>}
  </section></div>;
}
