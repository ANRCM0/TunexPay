"use client";
import { useState } from "react";
import { Plus, RefreshCw, Settings2 } from "lucide-react";
import { api, useApi } from "../lib/api";
import { LoadingState, PageHead, Section, Status, Drawer, time } from "./common";
import { ChannelEditor } from "./channel-editor";

export type Channel = {
  id: string; name: string; plugin: string; enabled: boolean; revision: number;
  settings: Record<string, string | number | boolean>; checkStatus: string; checkMessage: string | null; checkedAt: string | null;
  watcherUrl: string; webhookUrl: string;
  testPayment: { paymentNo: string; status: string; currentRevision: boolean; cashierUrl: string } | null;
};
type Plugin = { code: string; name: string; description: string; capabilities: string[] };
type Application = { id: string; name: string; defaultChannel: string; defaultChannelId: string | null };
export const checkLabels: Record<string, string> = { UNCHECKED: "待检测", API_VERIFIED: "接口已验证", PAYMENT_VERIFIED: "实付已验证", SIMULATED: "模拟配置通过", NEEDS_PAYMENT: "待实付验证", FAILED: "检测失败" };
export const assignable = (channel: Channel) => channel.enabled && ["API_VERIFIED", "PAYMENT_VERIFIED", "SIMULATED"].includes(channel.checkStatus);

export function Channels() {
  const channels = useApi<Channel[]>("/channel-instances", 10_000);
  const plugins = useApi<Plugin[]>("/plugins");
  const applications = useApi<Application[]>("/applications");
  const [editor, setEditor] = useState<{ plugin: string; channel?: Channel } | null>(null);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  async function operate(channel: Channel, action: "check" | "test-payment") {
    setBusy(channel.id); setNotice(null);
    try {
      const result = await api<{ data: Channel | { cashierUrl: string } }>(`/channel-instances/${channel.id}/${action}`, { method: "POST", body: JSON.stringify({ revision: channel.revision }) });
      if (action === "check") {
        const checked = result.data as Channel;
        setNotice({ ok: checked.checkStatus !== "FAILED", text: checked.checkMessage || checkLabels[checked.checkStatus] || "检测完成" });
      } else setNotice({ ok: true, text: "测试订单已创建。请打开收银台付款，到账后刷新结果。金额模式以收银台金额为准；测试款不会自动退款。" });
      await channels.reload();
    } catch (error) { setNotice({ ok: false, text: error instanceof Error ? error.message : "操作失败" }); }
    finally { setBusy(""); }
  }
  async function assign(app: Application, channelId: string) {
    setBusy(app.id); setNotice(null);
    try {
      await api(`/applications/${app.id}/channel-instance`, { method: "POST", body: JSON.stringify({ channelId }) });
      await applications.reload(); setNotice({ ok: true, text: `${app.name} 已分配通道，新支付使用该通道。` });
    } catch (error) { setNotice({ ok: false, text: error instanceof Error ? error.message : "分配失败" }); }
    finally { setBusy(""); }
  }
  return <>
    <PageHead eyebrow="Plugins & Channels" title="插件与通道" copy="选择支付插件，配置独立收款账号，验证后分配给业务应用。" action={<button className="button secondary" onClick={() => void channels.reload()}><RefreshCw size={14} />刷新状态</button>} />
    {notice && <div role="status" className={`operation-notice ${notice.ok ? "ok" : "error"}`}>{notice.text}</div>}
    <LoadingState loading={plugins.loading} error={plugins.error}>
      <div className="channel-grid">{plugins.data?.map(plugin => <section className="card channel-card" key={plugin.code}>
        <div className="eyebrow">支付插件 · {plugin.code}</div><h2>{plugin.name}</h2><p className="muted">{plugin.description}</p>
        <div className="plugin-capabilities">{plugin.capabilities.map(item => <span key={item}>{item}</span>)}</div>
        <button className="button secondary" onClick={() => setEditor({ plugin: plugin.code })}><Plus size={14} />创建通道</button>
      </section>)}</div>
    </LoadingState>
    {editor && <Drawer title={editor.channel ? `配置通道 · ${editor.channel.name}` : "创建通道"} onClose={() => setEditor(null)}><ChannelEditor key={editor.channel?.id || editor.plugin} plugin={editor.plugin} channel={editor.channel} onClose={() => setEditor(null)} onSaved={async () => { setEditor(null); await channels.reload(); }} /></Drawer>}
    <Section title="已配置通道" action={<span className="muted">修改配置后需重新检测</span>} className="detail-section">
      <LoadingState loading={channels.loading} error={channels.error} empty={!channels.data?.length}>
        <div className="table-wrap"><table><thead><tr><th>通道 / 插件</th><th>新订单</th><th>验证状态</th><th>最近检测</th><th>操作</th></tr></thead><tbody>
          {channels.data?.map(channel => <tr key={channel.id}>
            <td><strong>{channel.name}</strong><div className="muted">{channel.plugin}</div><code>{channel.id}</code></td>
            <td><Status value={channel.enabled ? "ACTIVE" : "DISABLED"} /></td>
            <td><span className={`badge badge-${channel.checkStatus === "FAILED" ? "danger" : ["PAYMENT_VERIFIED", "API_VERIFIED"].includes(channel.checkStatus) ? "success" : "warning"}`}>{checkLabels[channel.checkStatus]}</span><p className="channel-check-detail">{channel.checkMessage}</p>
              {channel.testPayment && <div className="muted">实付订单：<Status value={channel.testPayment.status} />{!channel.testPayment.currentRevision && "（旧配置）"}</div>}
            </td><td>{time(channel.checkedAt)}</td>
            <td><div className="channel-actions">
              <button className="button secondary" disabled={!!busy} onClick={() => setEditor({ plugin: channel.plugin, channel })}><Settings2 size={14} />配置</button>
              <button className="button secondary" disabled={!!busy} onClick={() => void operate(channel, "check")}>{busy === channel.id ? "处理中…" : "真实接口检测"}</button>
              <button className="button secondary" disabled={!!busy || !channel.enabled} onClick={() => void operate(channel, "test-payment")}>{channel.plugin === "MOCK" ? "模拟验收" : "创建 ¥0.01 实付单"}</button>
              {channel.testPayment?.currentRevision && <a className="button secondary" href={channel.testPayment.cashierUrl} target="_blank" rel="noreferrer">打开测试收银台</a>}
            </div></td>
          </tr>)}
        </tbody></table></div>
        <p className="muted">接口检测验证账号与上游通信。实付验收还会验证下单、到账和支付状态更新；业务系统 Webhook 需单独验收。账单金额模式可能增加最多 ¥0.99，请按收银台显示金额付款。</p>
      </LoadingState>
    </Section>
    <Section title="应用通道分配" className="detail-section">
      <LoadingState loading={applications.loading} error={applications.error} empty={!applications.data?.length}>
        <div className="table-wrap"><table><thead><tr><th>业务应用</th><th>收款通道</th></tr></thead><tbody>{applications.data?.map(app => {
          const current = app.defaultChannelId || `${app.defaultChannel.toLowerCase().replaceAll("_", "-")}-default`;
          return <tr key={app.id}><td><strong>{app.name}</strong></td><td><select aria-label={`${app.name} 收款通道`} value={current} disabled={!!busy} onChange={event => void assign(app, event.target.value)}>
            {!channels.data?.some(channel => channel.id === current) && <option value={current}>原默认通道（待加载）</option>}
            {channels.data?.map(channel => <option key={channel.id} value={channel.id} disabled={!assignable(channel)}>{channel.name} · {checkLabels[channel.checkStatus]}{!channel.enabled ? " · 已停用" : ""}</option>)}
          </select></td></tr>;
        })}</tbody></table></div>
      </LoadingState>
    </Section>
  </>;
}
