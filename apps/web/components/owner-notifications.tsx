"use client";
import { useEffect, useState } from "react";
import { api, useApi } from "../lib/api";
import { LoadingState } from "./common";
type Draft = { revision: number; emailEnabled: boolean; feishuEnabled: boolean; smtpHost: string; smtpPort: 465 | 587; smtpUser: string; from: string; to: string; paymentSuccess: boolean; anomalies: boolean; webhookFailure: boolean; collectorFailure: boolean };
type View = Draft & { smtpPasswordConfigured: boolean; feishuWebhookConfigured: boolean; feishuSecretConfigured: boolean };
type Delivery = { id: string; channel: string; title: string; status: string; attempts: number; lastError: string | null; createdAt: string };
const empty = { smtpPassword: "", feishuWebhook: "", feishuSecret: "" };
export function OwnerNotificationsPanel() {
  const { data, loading, error, reload } = useApi<View>("/owner-notifications/settings");
  const { data: deliveries, reload: reloadDeliveries } = useApi<Delivery[]>("/owner-notifications/deliveries",10000);
  const [draft,setDraft] = useState<Draft | null>(null);
  const [secrets,setSecrets] = useState(empty);
  const [clear,setClear] = useState({ smtpPassword: false, feishuWebhook: false, feishuSecret: false });
  const [busy,setBusy] = useState(false); const [notice,setNotice] = useState("");
  useEffect(() => { if (data) { const { smtpPasswordConfigured: _p, feishuWebhookConfigured: _w, feishuSecretConfigured: _s,...rest } = data; setDraft(rest); setSecrets(empty); setClear({ smtpPassword: false, feishuWebhook: false, feishuSecret: false }); } },[data]);
  function update<K extends keyof Draft>(key: K,value: Draft[K]) { setDraft(v => v ? { ...v,[key]:value } : v); }
  async function save(event: React.FormEvent) {
    event.preventDefault(); if (!draft) return; setBusy(true); setNotice("");
    try { await api("/owner-notifications/settings",{ method:"POST",body:JSON.stringify({ ...draft,...Object.fromEntries(Object.entries(secrets).map(([k,v]) => [k,clear[k as keyof typeof clear] ? null : v])) }) }); setSecrets(empty); await reload(); setNotice("已保存，后续通知动态使用新配置。"); }
    catch (e) { setNotice(e instanceof Error ? e.message : "保存失败"); } finally { setBusy(false); }
  }
  async function test(channel: "EMAIL" | "FEISHU") {
    setBusy(true); try { await api("/owner-notifications/test",{method:"POST",body:JSON.stringify({channel})}); setNotice("测试任务已排队，请查看下方投递状态（SUCCESS 才代表发送成功）。"); await reloadDeliveries(); }
    catch(e) { setNotice(e instanceof Error ? e.message : "测试失败"); } finally {setBusy(false);}
  }
  return <section className="card section detail-section"><div className="section-title"><h2>本人通知 · 邮箱与飞书</h2><span className="muted">与业务回调独立 · 密钥加密保存</span></div>
    {notice && <div className="operation-notice" aria-live="polite">{notice}</div>}
    <LoadingState loading={loading} error={error}>{draft && data && <form onSubmit={e => void save(e)}><fieldset className="bill-settings-fields" disabled={busy}>
      <div className="bill-settings-grid">
        <label><input type="checkbox" checked={draft.emailEnabled} onChange={e=>update("emailEnabled",e.target.checked)} />启用邮箱通知</label>
        <label><input type="checkbox" checked={draft.feishuEnabled} onChange={e=>update("feishuEnabled",e.target.checked)} />启用飞书机器人通知</label>
        {([ ["smtpHost","SMTP 主机"],["smtpUser","SMTP 登录账号"],["from","发件邮箱"],["to","收件邮箱"] ] as const).map(([key,label])=><label key={key}>{label}<input value={draft[key]} onChange={e=>update(key,e.target.value)} autoComplete="off" /></label>)}
        <label>SMTP 加密方式<select value={draft.smtpPort} onChange={e=>update("smtpPort",Number(e.target.value) as 465|587)}><option value={465}>465 · TLS</option><option value={587}>587 · 强制 STARTTLS</option></select></label>
        {([ ["smtpPassword","SMTP 密码/授权码",data.smtpPasswordConfigured],["feishuWebhook","飞书 Webhook",data.feishuWebhookConfigured],["feishuSecret","飞书签名校验密钥（选填）",data.feishuSecretConfigured] ] as const).map(([key,label,configured])=><label key={key}>{label}（{configured ? "已配置，留空保留" : "未配置"}）<input type="password" value={secrets[key]} autoComplete="new-password" onChange={e=>setSecrets(v=>({...v,[key]:e.target.value}))} /><span><input type="checkbox" checked={clear[key]} onChange={e=>setClear(v=>({...v,[key]:e.target.checked}))} />明确清除</span></label>)}
        {([ ["paymentSuccess","收款成功"],["anomalies","支付/流水异常"],["webhookFailure","业务回调重试耗尽"],["collectorFailure","采集连续失败"] ] as const).map(([key,label])=><label key={key}><input type="checkbox" checked={draft[key]} onChange={e=>update(key,e.target.checked)} />{label}</label>)}
      </div><p className="muted">先保存再测试。SMTP 只允许公网主机和安全 TLS；飞书只允许官方自定义机器人地址。请使用私密群，避免泄露订单信息。相同采集故障每 15 分钟最多提醒一次。Mock 收款不发送本人通知。</p>
      <div className="bill-settings-actions"><button className="button" type="submit">保存通知配置</button><button className="button" type="button" disabled={!data.emailEnabled} onClick={()=>void test("EMAIL")}>测试邮箱</button><button className="button" type="button" disabled={!data.feishuEnabled} onClick={()=>void test("FEISHU")}>测试飞书</button><button className="button" type="button" onClick={()=>void reload()}>重新加载</button></div>
    </fieldset></form>}</LoadingState>
    <h3>最近 50 条投递记录</h3>{deliveries?.map(row=><p key={row.id} className="muted">{new Date(row.createdAt).toLocaleString()} · {row.channel} · {row.title} · {row.status} · 尝试 {row.attempts} 次 {row.lastError ?? ""}</p>)}
  </section>;
}
