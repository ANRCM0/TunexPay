"use client";
import { useState } from "react";
import { RefreshCw, Settings2 } from "lucide-react";
import { api, useApi } from "../lib/api";
import { CopyValue, LoadingState, PageHead, Section, Status, Modal, Toast, time } from "./common";
import { channelLabel } from "../lib/labels";
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
  const [assignOpen, setAssignOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [testChannel, setTestChannel] = useState<Channel | null>(null);
  const [testAmount, setTestAmount] = useState("0.01");
  async function operate(channel: Channel, action: "check" | "test-payment", amount?: string) {
    setBusy(channel.id); setNotice(null);
    try {
      const result = await api<{ data: Channel | { cashierUrl: string } }>(`/channel-instances/${channel.id}/${action}`, { method: "POST", body: JSON.stringify({ revision: channel.revision, ...(amount ? { amount } : {}) }) });
      if (action === "check") {
        const checked = result.data as Channel;
        setNotice({ ok: checked.checkStatus !== "FAILED", text: checked.checkMessage || checkLabels[checked.checkStatus] || "检测完成" });
      } else {
        const cashierUrl = (result.data as { cashierUrl: string }).cashierUrl;
        if (cashierUrl) window.open(cashierUrl, "_blank", "noopener");
        setNotice({ ok: true, text: `测试订单已创建（¥${amount || "0.01"}），已在新窗口打开收银台；测试款不会自动退款。` });
        setTestChannel(null);
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
    {notice && <Toast type={notice.ok ? "ok" : "error"} text={notice.text} onClose={() => setNotice(null)} />}
    <Section title="通道列表" action={<span className="muted">创建通道请前往「支付插件」 · <button className="link-button" onClick={() => setAssignOpen(true)}>通道分配</button></span>}>
      <LoadingState loading={channels.loading} error={channels.error} empty={!channels.data?.length} emptyText="还没有支付通道，请先从支付插件创建并配置一个通道">
        <div className="table-wrap"><table><thead><tr><th>通道 / 插件</th><th>新订单</th><th>验证状态</th><th>最近检测</th><th>操作</th></tr></thead><tbody>
          {channels.data?.map(channel => <tr key={channel.id}>
            <td><div className="channel-id-cell"><div className={`channel-icon xs ${channel.plugin === "MOCK" ? "mock" : "alipay"}`}>{channel.plugin === "MOCK" ? "M" : channel.plugin === "ALIPAY_BILL" ? "账" : "支"}</div><div><strong>{channel.name}</strong><div className="id-line"><span className="muted">{channelLabel(channel.plugin)} · <span className="mono">{channel.id}</span></span><CopyValue value={channel.id} label="复制通道 ID" /></div></div></div></td>
            <td data-label="新订单"><Status value={channel.enabled ? "ACTIVE" : "DISABLED"} /></td>
            <td data-label="验证状态"><span className={`badge badge-${channel.checkStatus === "FAILED" ? "danger" : ["PAYMENT_VERIFIED", "API_VERIFIED"].includes(channel.checkStatus) ? "success" : "warning"}`}>{checkLabels[channel.checkStatus]}</span>{channel.checkMessage && <div className="muted check-msg ellipsis" title={channel.checkMessage}>{channel.checkMessage}</div>}
              {channel.testPayment && <div className="check-msg"><span className="muted">实付订单 </span><Status value={channel.testPayment.status} /><div className="id-line"><span className="mono muted">{channel.testPayment.paymentNo}</span><CopyValue value={channel.testPayment.paymentNo} label="复制测试支付单号" /></div>{!channel.testPayment.currentRevision && <div className="muted">旧配置</div>}</div>}
            </td><td data-label="最近检测">{time(channel.checkedAt)}</td>
            <td data-label="操作"><div className="channel-actions">
              <button className="button secondary" disabled={!!busy} onClick={() => setEditor(channel)}><Settings2 size={14} />配置</button>
              <button className="link-button" disabled={!!busy} onClick={() => void operate(channel, "check")}>{busy === channel.id ? "处理中…" : "检测"}</button>
              <button className="link-button" disabled={!!busy || !channel.enabled} onClick={() => { setTestAmount("0.01"); setTestChannel(channel); }}>{channel.plugin === "MOCK" ? "模拟验收" : "实付验收"}</button>
            </div></td>
          </tr>)}
        </tbody></table></div>
      </LoadingState>
    </Section>
    {testChannel && <Modal title={testChannel.plugin === "MOCK" ? "模拟验收" : "实付验收"} onClose={busy ? () => undefined : () => setTestChannel(null)}>
      <div className="resolution-form">
        <p className="dialog-copy">{testChannel.plugin === "MOCK"
          ? "将创建一笔模拟测试订单，用于验证完整支付流程，不会产生真实扣款。"
          : "将创建一笔真实测试订单并打开收银台。账单金额模式可能在输入金额基础上增加最多 ¥0.99，请以收银台最终显示金额为准。"}</p>
        <label>验收金额（元）
          <input type="number" min="0.01" step="0.01" value={testAmount} onChange={event => setTestAmount(event.target.value)} autoFocus />
        </label>
        {testChannel.plugin !== "MOCK" && <div className="dialog-warning">测试款不会自动退款，请使用你可以确认到账并接受实际扣款的金额。</div>}
        <div className="dialog-actions">
          <button className="button" disabled={!!busy || !Number.isFinite(Number(testAmount)) || Number(testAmount) <= 0} onClick={() => void operate(testChannel, "test-payment", testAmount.trim() || "0.01")}>{busy === testChannel.id ? "创建中…" : "创建验收订单"}</button>
          <button className="button secondary" disabled={!!busy} onClick={() => setTestChannel(null)}>取消</button>
        </div>
      </div>
    </Modal>}

    {editor && <Modal title={`配置通道 · ${editor.name}`} onClose={() => setEditor(null)}><ChannelEditor key={editor.id} plugin={editor.plugin} channel={editor} onClose={() => setEditor(null)} onSaved={async () => { setEditor(null); await channels.reload(); setNotice({ ok: true, text: "通道配置已保存，请重新检测后再分配给应用。" }); }} /></Modal>}
    {assignOpen && <Modal title="应用通道分配" onClose={() => setAssignOpen(false)}>
      <LoadingState loading={applications.loading} error={applications.error} empty={!applications.data?.length} emptyText="还没有业务应用，创建应用后即可在这里分配收款通道">
        <div className="table-wrap"><table><thead><tr><th>业务应用</th><th>收款通道</th></tr></thead><tbody>{applications.data?.map(app => {
          const current = app.defaultChannelId || `${app.defaultChannel.toLowerCase().replaceAll("_", "-")}-default`;
          return <tr key={app.id}><td><strong>{app.name}</strong></td><td data-label="收款通道"><select aria-label={`${app.name} 收款通道`} value={current} disabled={!!busy} onChange={event => void assign(app, event.target.value)}>
            {!channels.data?.some(channel => channel.id === current) && <option value={current}>原默认通道（待加载）</option>}
            {channels.data?.map(channel => <option key={channel.id} value={channel.id} disabled={!assignable(channel)}>{channel.name} · {checkLabels[channel.checkStatus]}{!channel.enabled ? " · 已停用" : ""}</option>)}
          </select></td></tr>;
        })}</tbody></table></div>
      </LoadingState>
    </Modal>}
  </>;
}
