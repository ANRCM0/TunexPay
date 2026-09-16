"use client";
import { useState, type FormEvent } from "react";
import { api, useApi } from "../lib/api";
import { Toggle } from "./common";
import type { Channel } from "./channels";

const defaults: Record<string, string | number | boolean> = { appId: "", userId: "", gateway: "https://openapi.alipay.com/gateway.do", qrContent: "", collectorEnabled: false, matchMode: "AMOUNT", validSeconds: 300, amountOffsetMax: 99, pollSeconds: 10, lookbackSeconds: 3600, overlapSeconds: 300, lagSeconds: 15 };
export function ChannelEditor({ plugin, channel, onSaved, onClose }: { plugin: string; channel?: Channel; onSaved: () => Promise<void>; onClose: () => void }) {
  const [name, setName] = useState(channel?.name || "");
  const [enabled, setEnabled] = useState(channel?.enabled || false);
  const [settings, setSettings] = useState({ ...defaults, ...channel?.settings });
  const [secrets, setSecrets] = useState({ privateKey: "", publicKey: "", watcherToken: "" });
  const [clear, setClear] = useState({ privateKey: false, publicKey: false, watcherToken: false });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const update = (key: string, value: string | number | boolean) => setSettings(previous => ({ ...previous, [key]: value }));
  async function submit(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError("");
    try {
      await api(channel ? `/channel-instances/${channel.id}` : "/channel-instances", { method: "POST", body: JSON.stringify({ name, enabled, plugin, revision: channel?.revision,
        settings: { ...settings, privateKey: clear.privateKey ? null : secrets.privateKey, publicKey: clear.publicKey ? null : secrets.publicKey, watcherToken: clear.watcherToken ? null : secrets.watcherToken },
      }) });
      await onSaved();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "保存失败"); }
    finally { setSaving(false); }
  }
  return <div>
    {channel && plugin === "ALIPAY_BILL" && <CollectorStatus id={channel.id} />}
    <form onSubmit={event => void submit(event)}><fieldset className="bill-settings-fields" disabled={saving}>
      {error && <div role="alert" className="error">{error}</div>}
      <div className="bill-settings-grid"><label>通道名称<input value={name} onChange={event => setName(event.target.value)} required maxLength={120} placeholder="例如：支付宝 · 工作室" /></label>
        <div><Toggle checked={enabled} onChange={setEnabled} label="启用新订单" /></div>
        {plugin !== "MOCK" && <>
          <label>支付宝 App ID<input value={String(settings.appId)} onChange={event => update("appId", event.target.value)} autoComplete="off" maxLength={40} /></label>
          <label>官方网关<select value={String(settings.gateway)} onChange={event => update("gateway", event.target.value)}><option value="https://openapi.alipay.com/gateway.do">生产环境</option><option value="https://openapi-sandbox.dl.alipaydev.com/gateway.do">沙箱环境</option><option value="https://openapi.alipaydev.com/gateway.do">旧版沙箱</option></select></label>
          {(["privateKey", "publicKey"] as const).map(key => <label key={key}>{key === "privateKey" ? "应用 RSA2 私钥" : "支付宝 RSA2 公钥"}（{settings[`${key}Configured`] ? "已配置" : "未配置"}）<textarea rows={4} value={secrets[key]} disabled={clear[key]} autoComplete="off" spellCheck={false} placeholder="留空保留原密钥" onChange={event => setSecrets(previous => ({ ...previous, [key]: event.target.value }))} /></label>)}
        </>}
        {plugin === "ALIPAY_BILL" && <>
          <label>收款用户 ID<input value={String(settings.userId)} maxLength={32} placeholder="2088 开头的 16 位 ID" onChange={event => update("userId", event.target.value)} /></label>
          <div><Toggle checked={Boolean(settings.collectorEnabled)} onChange={value => update("collectorEnabled", value)} label="启用该通道的自动账单采集" /></div>
          <label className="bill-settings-wide">收款码内容<textarea rows={3} maxLength={4000} value={String(settings.qrContent)} onChange={event => update("qrContent", event.target.value)} placeholder="二维码解析后的完整内容" /></label>
          <label>匹配方式<select value={String(settings.matchMode)} onChange={event => update("matchMode", event.target.value)}><option value="AMOUNT">金额偏移（内置采集推荐）</option><option value="REMARK">付款备注（仅外部 Watcher）</option></select></label>
          <p className="muted bill-settings-wide">官方账务接口不下发付款备注，内置采集器只能用金额匹配；备注匹配需要接入能抓到备注的外部 Watcher。</p>
          <label>外部 Watcher 令牌（{settings.watcherTokenConfigured ? "已配置" : "未配置"}）<input type="password" value={secrets.watcherToken} disabled={clear.watcherToken} autoComplete="new-password" maxLength={200} placeholder="不用内置采集时填写，至少 24 字符" onChange={event => setSecrets(previous => ({ ...previous, watcherToken: event.target.value }))} /></label>
          {([ ["validSeconds", "识别有效期（秒）", 60, 3600], ["amountOffsetMax", "最大金额偏移（分）", 0, 99], ["pollSeconds", "采集间隔（秒）", 3, 3600], ["overlapSeconds", "重叠补拉（秒）", 60, 3600], ["lagSeconds", "采集延迟（秒）", 2, 300], ["lookbackSeconds", "首次回看（秒）", 300, 86400] ] as const).map(([key, label, min, max]) => <label key={key}>{label}<input type="number" required min={min} max={max} step={1} value={Number(settings[key])} onChange={event => update(key, Number(event.target.value))} /></label>)}
        </>}
      </div>
      {plugin !== "MOCK" && <details className="bill-settings-advanced"><summary>清除已保存密钥</summary><div className="bill-settings-switches">{(["privateKey", "publicKey", ...(plugin === "ALIPAY_BILL" ? ["watcherToken" as const] : [])] as const).map(key => <label key={key}><input type="checkbox" checked={clear[key]} onChange={event => setClear(previous => ({ ...previous, [key]: event.target.checked }))} />清除{key === "privateKey" ? "应用私钥" : key === "publicKey" ? "支付宝公钥" : "Watcher 令牌"}</label>)}</div></details>}
      {plugin === "MOCK" && <p className="muted">模拟通道仍受服务器 Mock 开关和令牌控制，不用于真实收款。</p>}
      {channel && plugin === "ALIPAY_BILL" && <p className="channel-check-detail">此通道的 Watcher 地址：<code>{channel.watcherUrl}</code></p>}
      <p className="muted">保存后请重新检测。已有交易的通道不能更换账号或网关；可创建新通道再分配。停用新订单后，已有交易仍可查单、收取回调和退款。</p>
      <div className="bill-settings-actions"><button className="button" type="submit">{saving ? "保存中…" : "保存通道"}</button><button className="button secondary" type="button" onClick={onClose}>取消</button></div>
    </fieldset></form>
  </div>;
}

function CollectorStatus({ id }: { id: string }) {
  const { data, error } = useApi<{ status: string; lastError?: string; lastSuccessAt?: string }>(`/channel-instances/${id}/collector`, 10_000);
  return <p className="channel-check-detail">采集器：{error || data?.status || "加载中…"}{data?.lastError && ` · ${data.lastError}`}{data?.lastSuccessAt && ` · 最近成功 ${new Date(data.lastSuccessAt).toLocaleString("zh-CN")}`}</p>;
}
