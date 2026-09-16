"use client";
import { useState } from "react";
import { RefreshCw, Settings2 } from "lucide-react";
import { api, useApi } from "../lib/api";
import { Drawer, LoadingState, PageHead, Section, Status, time } from "./common";
import { ChannelEditor } from "./channel-editor";

export type Channel = {
  id: string; name: string; plugin: string; enabled: boolean; revision: number;
  settings: Record<string, string | number | boolean>; checkStatus: string; checkMessage: string | null; checkedAt: string | null;
  watcherUrl: string; webhookUrl: string;
  testPayment: { paymentNo: string; status: string; currentRevision: boolean; cashierUrl: string } | null;
};
type Application = { id: string; name: string; defaultChannel: string; defaultChannelId: string | null };
export const checkLabels: Record<string, string> = { UNCHECKED: "待检测", API_VERIFIED: "接口已验证", PAYMENT_VERIFIED: "实付已验证", SIMULATED: "模拟配置通过", NEEDS_PAYMENT: "待实付验证", FAILED: "检测失败" };
export const assignable = (channel: Channel) => channel.enabled && ["API_VERIFIED", "PAYMENT_VERIFIED", "SIMULATED"].includes(channel.checkStatus);

export function Channels() {
  const channels = useApi<Channel[]>("/channel-instances", 10_000);
  const applications = useApi<Application[]>("/applications");
  const [editor, setEditor] = useState<Channel | null>(null);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  async function operate(channel: Channel, action: "check" | "test-payment") {
    let amount: string | undefined;
    if (action === "test-payment") {
      const input = window.prompt("验收金额（元）。账单金额模式会在此基础上增加最多 ¥0.99，以收银台显示金额为准。", "0.01");
      if (input === null) return;
      amount = input.trim() || "0.01";
    }
    setBusy(channel.id); setNotice(null);
    try {
      const result = await api<{ data: Channel | { cashierUrl: string } }>(`/channel-instances/${channel.id}/${action}`, { method: "POST", body: JSON.stringify({ revision: channel.revision, ...(amount ? { amount } : {}) }) });
      if (action === "check") {
        const checked = result.data as Channel;
        setNotice({ ok: checked.checkStatus !== "FAILED", text: checked.checkMessage || checkLabels[checked.checkStatus] || "检测完成" });
      } else {
        const cashierUrl = (result.data as { cashierUrl: string }).cashierUrl;
        if (cashierUrl) window.open(cashierUrl, "_blank", "noopener");
        setNotice({ ok: true, text: `测试订单已创建（¥${amount}），已在新窗口打开收银台；测试款不会自动退款。` });
      }
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
    <PageHead eyebrow="Channels" title="支付通道" copy="独立收款账号的通道实例；修改配置后需重新检测，验证通过才能分配给应用。" action={<button className="button secondary" onClick={() => void channels.reload()}><RefreshCw size={14} />刷新状态</button>} />
    {notice && <div role="status" className={`operation-notice ${notice.ok ? "ok" : "error"}`}>{notice.text}</div>}
    <Section title="通道列表" action={<span className="muted">创建通道请前往「支付插件」</span>}>
      <LoadingState loading={channels.loading} error={channels.error} empty={!channels.data?.length}>
        <div className="table-wrap"><table><thead><tr><th>通道 / 插件</th><th>新订单</th><th>验证状态</th><th>最近检测</th><th>操作</th></tr></thead><tbody>
          {channels.data?.map(channel => <tr key={channel.id}>
            <td><div className="channel-id-cell"><div className={`channel-icon xs ${channel.plugin === "MOCK" ? "mock" : "alipay"}`}>{channel.plugin === "MOCK" ? "M" : channel.plugin === "ALIPAY_BILL" ? "账" : "支"}</div><div><strong>{channel.name}</strong><div className="mono muted">{channel.plugin} · {channel.id}</div></div></div></td>
            <td><Status value={channel.enabled ? "ACTIVE" : "DISABLED"} /></td>
            <td><span className={`badge badge-${channel.checkStatus === "FAILED" ? "danger" : ["PAYMENT_VERIFIED", "API_VERIFIED"].includes(channel.checkStatus) ? "success" : "warning"}`}>{checkLabels[channel.checkStatus]}</span>{channel.checkMessage && <div className="muted check-msg ellipsis" title={channel.checkMessage}>{channel.checkMessage}</div>}
              {channel.testPayment && <div className="muted check-msg">实付订单 <Status value={channel.testPayment.status} />{!channel.testPayment.currentRevision && "（旧配置）"}</div>}
            </td><td>{time(channel.checkedAt)}</td>
            <td><div className="channel-actions">
              <button className="button secondary" disabled={!!busy} onClick={() => setEditor(channel)}><Settings2 size={14} />配置</button>
              <button className="link-button" disabled={!!busy} onClick={() => void operate(channel, "check")}>{busy === channel.id ? "处理中…" : "检测"}</button>
              <button className="link-button" disabled={!!busy || !channel.enabled} onClick={() => void operate(channel, "test-payment")}>{channel.plugin === "MOCK" ? "模拟验收" : "实付验收"}</button>
            </div></td>
          </tr>)}
        </tbody></table></div>
      </LoadingState>
    </Section>
    {editor && <Drawer title={`配置通道 · ${editor.name}`} onClose={() => setEditor(null)}><ChannelEditor key={editor.id} plugin={editor.plugin} channel={editor} onClose={() => setEditor(null)} onSaved={async () => { setEditor(null); await channels.reload(); }} /></Drawer>}
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
