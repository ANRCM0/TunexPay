"use client";

import { useEffect, useState } from "react";
import { api, useApi } from "../lib/api";
import { LoadingState, Section, Toggle } from "./common";

type Draft = {
  revision: number; enabled: boolean; collectorEnabled: boolean; appId: string; userId: string;
  gateway: string; qrContent: string; matchMode: "REMARK" | "AMOUNT";
  validSeconds: number; amountOffsetMax: number; pollSeconds: number;
  lookbackSeconds: number; overlapSeconds: number; lagSeconds: number;
};
type View = Draft & { privateKeyConfigured: boolean; publicKeyConfigured: boolean; watcherTokenConfigured: boolean; updatedAt: string };
const emptySecrets = { privateKey: "", publicKey: "", watcherToken: "" };
const emptyClear = { privateKey: false, publicKey: false, watcherToken: false };

export function BillSettingsPanel({ onSaved }: { onSaved: () => Promise<void> }) {
  const { data, loading, error, reload } = useApi<View>("/channels/alipay-bill/settings");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [secrets, setSecrets] = useState(emptySecrets);
  const [clear, setClear] = useState(emptyClear);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    if (!data) return;
    const { privateKeyConfigured: _private, publicKeyConfigured: _public, watcherTokenConfigured: _token, updatedAt: _updated, ...values } = data;
    setDraft(values); setSecrets(emptySecrets); setClear(emptyClear);
  }, [data]);
  function update<K extends keyof Draft>(key: K, value: Draft[K]) { setDraft(current => current ? { ...current, [key]: value } : current); }
  async function save(event: React.FormEvent) {
    event.preventDefault(); if (!draft) return;
    setSaving(true); setNotice(null);
    try {
      await api("/channels/alipay-bill/settings", { method: "POST", body: JSON.stringify({ ...draft,
        privateKey: clear.privateKey ? null : secrets.privateKey,
        publicKey: clear.publicKey ? null : secrets.publicKey,
        watcherToken: clear.watcherToken ? null : secrets.watcherToken,
      }) });
      setSecrets(emptySecrets); setClear(emptyClear);
      setNotice({ ok: true, text: "已保存。新订单立即使用新配置，采集器会在当前页结束后切换，无需重启容器。" });
      await reload(); await onSaved();
    } catch (cause) { setNotice({ ok: false, text: cause instanceof Error ? cause.message : "保存失败" }); }
    finally { setSaving(false); }
  }
  return <Section title="支付宝账单收款配置" action={<span className="muted">数据库持久化 · 密钥加密 · 仅影响账单通道</span>} className="detail-section">
    {notice && <div className={`operation-notice ${notice.ok ? "ok" : "error"}`}>{notice.text}</div>}
    <LoadingState loading={loading} error={error}>
      {draft && data && <form onSubmit={event => void save(event)}>
        <fieldset className="bill-settings-fields" disabled={saving}>
          <div className="bill-settings-switches">
            <Toggle checked={draft.enabled} onChange={value => update("enabled", value)} label="启用账单收款（接收新订单）" />
            <Toggle checked={draft.collectorEnabled} onChange={value => update("collectorEnabled", value)} label="启用自动账单采集" />
          </div>
          <p className="muted">暂停新订单时可保留采集，用于确认已有订单。停止采集不会撤销已接收流水，也无法停用支付宝静态收款码。</p>
          <div className="bill-settings-grid">
            <label>支付宝 App ID<input value={draft.appId} maxLength={40} onChange={event => update("appId", event.target.value)} autoComplete="off" /></label>
            <label>收款支付宝用户 ID<input value={draft.userId} maxLength={32} placeholder="2088 开头的 16 位用户 ID" onChange={event => update("userId", event.target.value)} autoComplete="off" /></label>
            <label className="bill-settings-wide">支付宝官方网关<input type="url" value={draft.gateway} onChange={event => update("gateway", event.target.value)} required /></label>
            <label className="bill-settings-wide">收款码内容<textarea rows={3} value={draft.qrContent} maxLength={4000} placeholder="填写从收款二维码解析出的完整内容，不是图片文件路径" onChange={event => update("qrContent", event.target.value)} /></label>
            <label>匹配模式<select value={draft.matchMode} onChange={event => update("matchMode", event.target.value as Draft["matchMode"])}><option value="AMOUNT">金额偏移（内置采集推荐）</option><option value="REMARK">付款备注（仅外部 Watcher）</option></select></label>
            <NumberField label="识别有效期（秒）" value={draft.validSeconds} min={60} max={3600} onChange={value => update("validSeconds", value)} />
            <NumberField label="最大金额偏移（分）" value={draft.amountOffsetMax} min={0} max={99} onChange={value => update("amountOffsetMax", value)} />
            <NumberField label="查询间隔（秒）" value={draft.pollSeconds} min={3} max={3600} onChange={value => update("pollSeconds", value)} />
            <label>应用 RSA2 私钥（{data.privateKeyConfigured ? "已配置" : "未配置"}）<textarea rows={4} value={secrets.privateKey} disabled={clear.privateKey} autoComplete="off" spellCheck={false} placeholder="留空保留原密钥；支持 PEM 或 PKCS8 裸密钥" onChange={event => setSecrets(current => ({ ...current, privateKey: event.target.value }))} /></label>
            <label>支付宝 RSA2 公钥（{data.publicKeyConfigured ? "已配置" : "未配置"}）<textarea rows={4} value={secrets.publicKey} disabled={clear.publicKey} autoComplete="off" spellCheck={false} placeholder="不是应用公钥；留空保留原配置" onChange={event => setSecrets(current => ({ ...current, publicKey: event.target.value }))} /></label>
          </div>
          <details className="bill-settings-advanced"><summary>补拉参数、外部 Watcher 与密钥清除</summary>
            <div className="bill-settings-grid">
              <NumberField label="首次启动回看（秒）" value={draft.lookbackSeconds} min={300} max={86400} onChange={value => update("lookbackSeconds", value)} />
              <NumberField label="重复补拉窗口（秒）" value={draft.overlapSeconds} min={60} max={3600} onChange={value => update("overlapSeconds", value)} />
              <NumberField label="最新流水查询延迟（秒）" value={draft.lagSeconds} min={5} max={300} onChange={value => update("lagSeconds", value)} />
              <label>外部 Watcher 令牌（{data.watcherTokenConfigured ? "已配置" : "可选"}）<input type="password" value={secrets.watcherToken} disabled={clear.watcherToken} maxLength={200} autoComplete="new-password" placeholder="内置采集不需要；留空保留" onChange={event => setSecrets(current => ({ ...current, watcherToken: event.target.value }))} /></label>
            </div>
            <div className="bill-settings-switches">{(["privateKey", "publicKey", "watcherToken"] as const).map(key => <label key={key}><input type="checkbox" checked={clear[key]} onChange={event => setClear(current => ({ ...current, [key]: event.target.checked }))} />清除{key === "privateKey" ? "应用私钥" : key === "publicKey" ? "支付宝公钥" : "外部令牌"}</label>)}</div>
          </details>
          <p className="muted">已有账单支付记录或采集断点后，禁止直接更换账号、网关和收款码。密钥可轮换；清除必需密钥前请关闭相应开关。首次回看参数不会重置已有断点。</p>
          <div className="bill-settings-actions"><button className="button" type="submit">{saving ? "保存中…" : "保存账单配置"}</button><button className="button secondary" type="button" onClick={() => void reload()}>重新加载（放弃未保存修改）</button><span className="muted">版本 {data.revision}</span></div>
        </fieldset>
      </form>}
    </LoadingState>
  </Section>;
}

function NumberField({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (value: number) => void }) {
  return <label>{label}<input type="number" value={value} min={min} max={max} step={1} required onChange={event => onChange(Number(event.target.value))} /></label>;
}
