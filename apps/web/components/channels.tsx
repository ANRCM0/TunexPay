"use client";

import { CheckCircle2, CircleX, RefreshCw, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { api, useApi } from "../lib/api";
import { LoadingState, PageHead, Status } from "./common";

type ChannelStatus = {
  alipay: { code: string; name: string; ready: boolean; environment: string; gateway: string; webhookUrl: string; checks: { appId: boolean; privateKey: boolean; publicKey: boolean } };
  alipayBill: { code: string; name: string; ready: boolean; enabled: boolean; qrContent: boolean; watcherToken: boolean; matchMode: string; validSeconds: number; watcherUrl: string };
  mock: { code: string; name: string; ready: boolean; enabled: boolean; token: boolean };
};
type Application = { id: string; appId: string; name: string; status: string; defaultChannel: string };

export function Channels() {
  const { data, loading, error } = useApi<ChannelStatus>("/channels");
  const { data: applications, loading: appsLoading, error: appsError, reload } = useApi<Application[]>("/applications");
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState("");
  const [notice, setNotice] = useState<{ type: "ok" | "error"; text: string } | null>(null);

  async function checkAlipay() {
    setChecking(true); setNotice(null);
    try {
      await api("/channels/alipay/check", { method: "POST" });
      setNotice({ type: "ok", text: "支付宝连接正常：请求签名、网关访问和响应验签均已通过。" });
    } catch (cause) { setNotice({ type: "error", text: cause instanceof Error ? cause.message : "支付宝连接检查失败" }); }
    finally { setChecking(false); }
  }

  async function changeDefault(application: Application, channel: string) {
    setSaving(application.id); setNotice(null);
    try {
      await api(`/applications/${application.id}/default-channel`, { method: "POST", body: JSON.stringify({ channel }) });
      setNotice({ type: "ok", text: `${application.name} 的默认通道已切换为 ${channel}。` });
      await reload();
    } catch (cause) { setNotice({ type: "error", text: cause instanceof Error ? cause.message : "通道切换失败" }); }
    finally { setSaving(""); }
  }

  return <>
    <PageHead eyebrow="Payment Channels" title="支付渠道" copy="检查通道是否具备收款条件，并为每个业务应用选择默认支付方式。" />
    {notice && <div className={`operation-notice ${notice.type}`}>{notice.text}</div>}
    <LoadingState loading={loading} error={error}>
      {data && <div className="channel-grid">
        <section className="card channel-card">
          <div className="channel-head"><div><div className="channel-icon alipay">支</div><div><h2>{data.alipay.name}</h2><span>{data.alipay.environment}</span></div></div><Status value={data.alipay.ready ? "ACTIVE" : "DISABLED"} /></div>
          <div className="check-list">
            <Check ok={data.alipay.checks.appId} label="支付宝 App ID" />
            <Check ok={data.alipay.checks.privateKey} label="应用 RSA2 私钥" />
            <Check ok={data.alipay.checks.publicKey} label="支付宝 RSA2 公钥" />
          </div>
          <div className="channel-meta"><span>网关</span><code>{data.alipay.gateway}</code><span>异步通知</span><code>{data.alipay.webhookUrl}</code></div>
          <button className="button" disabled={!data.alipay.ready || checking} onClick={() => void checkAlipay()}><RefreshCw size={14} />{checking ? "检查中…" : "测试支付宝连接"}</button>
        </section>

        <section className="card channel-card">
          <div className="channel-head"><div><div className="channel-icon alipay">账</div><div><h2>{data.alipayBill.name}</h2><span>Watcher 流水识别 · {data.alipayBill.matchMode}</span></div></div><Status value={data.alipayBill.ready ? "ACTIVE" : "DISABLED"} /></div>
          <div className="check-list"><Check ok={data.alipayBill.enabled} label="账单收款开关" /><Check ok={data.alipayBill.qrContent} label="收款二维码内容" /><Check ok={data.alipayBill.watcherToken} label="Watcher 专用令牌" /></div>
          <div className="channel-meta"><span>识别有效期</span><code>{data.alipayBill.validSeconds} 秒</code><span>流水入口</span><code>{data.alipayBill.watcherUrl}</code></div>
          <div className="channel-safety"><ShieldCheck size={18} /><span>流水先标准化并锁定，再通过支付核心统一成功入口推进；多候选不会自动猜单。</span></div>
        </section>

        <section className="card channel-card">
          <div className="channel-head"><div><div className="channel-icon mock">M</div><div><h2>{data.mock.name}</h2><span>仅用于开发与验收</span></div></div><Status value={data.mock.ready ? "ACTIVE" : "DISABLED"} /></div>
          <div className="check-list"><Check ok={data.mock.enabled} label="Mock 通道开关" /><Check ok={data.mock.token} label="内部操作令牌" /></div>
          <div className="channel-safety"><ShieldCheck size={18} /><span>生产环境应关闭 Mock；API 仍会二次校验专用令牌。</span></div>
        </section>
      </div>}
    </LoadingState>

    <section className="card section detail-section">
      <div className="section-title"><h2>应用默认通道</h2><span className="muted">切换后仅影响新创建的支付</span></div>
      <LoadingState loading={appsLoading} error={appsError} empty={!applications?.length}>
        <div className="table-wrap"><table><thead><tr><th>应用</th><th>App ID</th><th>状态</th><th>默认支付渠道</th></tr></thead><tbody>
          {applications?.map(application => <tr key={application.id}><td><strong>{application.name}</strong></td><td className="mono">{application.appId}</td><td><Status value={application.status} /></td><td>
            <select value={application.defaultChannel} disabled={saving === application.id} onChange={event => void changeDefault(application, event.target.value)} aria-label={`${application.name} 默认支付渠道`}>
              <option value="MOCK" disabled={!data?.mock.ready}>Mock（开发）</option><option value="ALIPAY" disabled={!data?.alipay.ready}>支付宝当面付</option><option value="ALIPAY_BILL" disabled={!data?.alipayBill.ready}>支付宝账单收款</option>
            </select>
          </td></tr>)}
        </tbody></table></div>
      </LoadingState>
    </section>
  </>;
}

function Check({ ok, label }: { ok: boolean; label: string }) {
  return <div className={ok ? "check ok" : "check missing"}>{ok ? <CheckCircle2 size={17} /> : <CircleX size={17} />}<span>{label}</span><strong>{ok ? "已配置" : "缺失"}</strong></div>;
}
