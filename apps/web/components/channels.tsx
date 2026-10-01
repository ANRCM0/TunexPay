"use client";
import { useMemo, useState } from "react";
import { RefreshCw, Settings2, Trash2 } from "lucide-react";
import { api, useApi } from "../lib/api";
import { nextSortState, sortRows, type SortColumn } from "../lib/sort";
import { ConfirmModal, CopyValue, HoverDetail, LoadingState, Modal, PageHead, Section, SortableTh, Status, Toast, sortValueProps, statusText, time } from "./common";
import { channelLabel } from "../lib/labels";
import { RoutingTargetSelect, applicationRoutingTarget, assignPaymentRouting } from "./routing-target";
import type { RoutingGroup } from "../lib/routing-groups";
import { ChannelEditor, type PluginOption } from "./channel-editor";

export type Channel = {
  id: string; name: string; plugin: string; enabled: boolean; revision: number;
  archivedAt?: string | null;
  settings: Record<string, string | number | boolean>; checkStatus: string; checkMessage: string | null; checkedAt: string | null;
  watcherUrl: string; webhookUrl: string;
  testPayment: { paymentNo: string; status: string; currentRevision: boolean; cashierUrl: string } | null;
};
type Application = { id: string; name: string; defaultChannel: string; defaultChannelId: string | null; routingGroupId: string | null };
export const checkLabels: Record<string, string> = { UNCHECKED: "待检测", API_VERIFIED: "接口已验证", PAYMENT_VERIFIED: "实付已验证", SIMULATED: "模拟配置通过", NEEDS_PAYMENT: "待实付验证", FAILED: "检测失败" };
export const assignable = (channel: Channel) => !channel.archivedAt && channel.enabled && ["API_VERIFIED", "PAYMENT_VERIFIED", "SIMULATED"].includes(channel.checkStatus);

// 验证状态列的次要说明默认收起（否则每行被撑高两三行），悬浮或聚焦徽章才展开。
function checkDetail(channel: Channel): string {
  return [
    channel.checkMessage,
    channel.testPayment ? `实付验收：${statusText(channel.testPayment.status)} · ${channel.testPayment.paymentNo}` : null,
  ].filter(Boolean).join("\n");
}

const SORT_COLUMNS: SortColumn<Channel>[] = [
  { key: "name", label: "通道 / 插件" },
  { key: "enabled", label: "新订单", accessor: (row) => (row.enabled ? 1 : 0), type: "number" },
  { key: "checkStatus", label: "验证状态" },
  // checkedAt 可能为 null（从未检测），空值由 sortRows 统一排到末尾
  { key: "checkedAt", label: "最近检测", type: "date", accessor: (row) => row.checkedAt ?? "" },
];

export function Channels() {
  const channels = useApi<Channel[]>("/channel-instances", 10_000);
  const applications = useApi<Application[]>("/applications");
  const groups = useApi<RoutingGroup[]>("/routing-groups");
  const plugins = useApi<PluginOption[]>("/plugins");
  const [editor, setEditor] = useState<Channel | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [removing, setRemoving] = useState<Channel | null>(null);
  const [busy, setBusy] = useState("");
  const [sort, setSort] = useState(() => null as ReturnType<typeof nextSortState>);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const rows = useMemo(() => sortRows(channels.data ?? [], SORT_COLUMNS, sort), [channels.data, sort]);
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
  // 删除分两种结果：从未产生资金数据的通道被真删；承载过支付/退款的通道转为归档
  // （行与对接密钥保留，历史支付单仍能查单与原路退款）。提示里必须说清是哪一种。
  async function remove(channel: Channel) {
    setBusy(channel.id); setNotice(null);
    try {
      const result = await api<{ data: { archived: boolean; retained: { payments: number; refunds: number } } }>(`/channel-instances/${channel.id}/delete`, { method: "POST", body: JSON.stringify({}) });
      setRemoving(null);
      setNotice(result.data.archived
        ? { ok: true, text: `通道「${channel.name}」已归档删除：不再出现于列表与分配选项，也不能再发起新支付；保留 ${result.data.retained.payments} 笔支付、${result.data.retained.refunds} 笔退款的对接密钥，历史单据仍可查单与退款。` }
        : { ok: true, text: `通道「${channel.name}」已删除（它从未产生过支付或退款记录）。` });
      await channels.reload();
    } catch (error) { setNotice({ ok: false, text: error instanceof Error ? error.message : "删除失败" }); }
    finally { setBusy(""); }
  }
  async function assign(app: Application, target: string) {
    setBusy(app.id); setNotice(null);
    try {
      await assignPaymentRouting(app.id, target);
      await applications.reload(); await groups.reload(); setNotice({ ok: true, text: target ? `${app.name} 收款路由已更新，仅影响新支付。` : `${app.name} 已解除收款绑定，新支付将被拒绝。` });
    } catch (error) { setNotice({ ok: false, text: error instanceof Error ? error.message : "分配失败" }); }
    finally { setBusy(""); }
  }
  return <>
    <PageHead eyebrow="Channels" title="支付通道" copy="独立收款账号的通道实例；修改配置后需重新检测，验证通过才能分配给应用。" action={
      <div className="page-head-actions">
        <button className="button secondary" onClick={() => void channels.reload()}><RefreshCw size={14} />刷新状态</button>
        <button className="button" onClick={() => setCreateOpen(true)}>创建通道</button>
      </div>
    } />
    {notice && <Toast type={notice.ok ? "ok" : "error"} text={notice.text} onClose={() => setNotice(null)} />}
    <Section title="通道列表" action={<span className="muted">创建通道需先选择支付插件 · <button className="link-button" onClick={() => setAssignOpen(true)}>通道分配</button></span>}>
      <LoadingState loading={channels.loading} error={channels.error} empty={!channels.data?.length} emptyText="还没有支付通道：请先创建通道并选择对接的支付插件，检测通过后再分配给应用">
        <div className="table-wrap"><table><thead><tr>
          <SortableTh label="通道 / 插件" sortKey="name" sort={sort} onSort={key => setSort(nextSortState(sort, key))} />
          <SortableTh label="新订单" sortKey="enabled" sort={sort} onSort={key => setSort(nextSortState(sort, key))} />
          <SortableTh label="验证状态" sortKey="checkStatus" sort={sort} onSort={key => setSort(nextSortState(sort, key))} />
          <SortableTh label="最近检测" sortKey="checkedAt" sort={sort} onSort={key => setSort(nextSortState(sort, key))} />
          <th scope="col">操作</th>
        </tr></thead><tbody>
          {rows.map(channel => <tr key={channel.id}>
            <td {...sortValueProps(channel, SORT_COLUMNS[0])}><div className="channel-id-cell"><div className={`channel-icon xs ${channel.plugin === "MOCK" ? "mock" : "alipay"}`}>{channel.plugin === "MOCK" ? "M" : channel.plugin === "ALIPAY_BILL" ? "账" : "支"}</div><div><strong>{channel.name}</strong><div className="id-line"><span className="muted">{channelLabel(channel.plugin)} · <span className="mono">{channel.id}</span></span><CopyValue value={channel.id} label="复制通道 ID" /></div></div></div></td>
            <td data-label="新订单" {...sortValueProps(channel, SORT_COLUMNS[1])}><Status value={channel.enabled ? "ACTIVE" : "DISABLED"} /></td>
            <td data-label="验证状态" {...sortValueProps(channel, SORT_COLUMNS[2])}><HoverDetail text={checkDetail(channel)} tone={channel.checkStatus === "FAILED" ? "danger" : "muted"}><span className={`badge badge-${channel.checkStatus === "FAILED" ? "danger" : ["PAYMENT_VERIFIED", "API_VERIFIED"].includes(channel.checkStatus) ? "success" : "warning"}`}>{checkLabels[channel.checkStatus]}</span></HoverDetail>{channel.testPayment && !channel.testPayment.currentRevision && <div className="recovery-note">验收记录来自旧配置，请重新检测</div>}
            </td><td data-label="最近检测" {...sortValueProps(channel, SORT_COLUMNS[3])}>{time(channel.checkedAt)}</td>
            <td data-label="操作"><div className="channel-actions">
              <button className="button secondary" disabled={!!busy} onClick={() => setEditor(channel)}><Settings2 size={14} />配置</button>
              <button className="link-button" disabled={!!busy} onClick={() => void operate(channel, "check")}>{busy === channel.id ? "处理中…" : "检测"}</button>
              <button className="link-button" disabled={!!busy || !channel.enabled} onClick={() => { setTestAmount("0.01"); setTestChannel(channel); }}>{channel.plugin === "MOCK" ? "模拟验收" : "实付验收"}</button>
              <button className="link-button danger-link" disabled={!!busy} onClick={() => setRemoving(channel)}><Trash2 size={13} />删除</button>
            </div></td>
          </tr>)}
        </tbody></table></div>
      </LoadingState>
    </Section>
    {removing && <ConfirmModal title={`删除通道 · ${removing.name}`} danger confirmLabel="确认删除"
      copy={`即将删除通道「${removing.name}」（${removing.id}）。如果它从未产生过支付或退款记录，会被直接删除；如果承载过资金数据，则转为归档删除：不再出现于列表与分配选项、不能再发起新支付，但对接密钥与历史单据保留，历史支付单仍可查单与原路退款。若仍有应用正在使用该通道，删除会被拒绝，请先在「通道分配」里改派。`}
      warning="删除不可逆。归档保留的密钥是历史支付单查单与原路退款的唯一凭据。"
      working={busy === removing.id} onConfirm={() => void remove(removing)} onClose={() => setRemoving(null)} />}
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

    {editor && <Modal title={`配置通道 · ${editor.name}`} onClose={() => setEditor(null)}><ChannelEditor key={editor.id} channel={editor} plugins={plugins.data ?? []} onClose={() => setEditor(null)} onSaved={async () => { setEditor(null); await channels.reload(); setNotice({ ok: true, text: "通道配置已保存，请重新检测后再分配给应用。" }); }} /></Modal>}
    {createOpen && <Modal title="创建通道" onClose={() => setCreateOpen(false)}><ChannelEditor plugins={plugins.data ?? []} onClose={() => setCreateOpen(false)} onSaved={async () => { setCreateOpen(false); await channels.reload(); setNotice({ ok: true, text: "支付通道已创建，请完成检测与验收后再分配给应用。" }); }} /></Modal>}
    {assignOpen && <Modal title="应用收款路由分配" onClose={() => setAssignOpen(false)}>
      <LoadingState loading={applications.loading} error={applications.error} empty={!applications.data?.length} emptyText="还没有业务应用，创建应用后即可在这里分配收款通道">
        {groups.error && <div className="error">{groups.error}</div>}
        <div className="table-wrap"><table><thead><tr><th scope="col">业务应用</th><th scope="col">收款路由</th></tr></thead><tbody>{applications.data?.map(app => {
          const current = applicationRoutingTarget(app);
          return <tr key={app.id}><td><strong>{app.name}</strong></td><td data-label="收款路由"><RoutingTargetSelect aria-label={`${app.name} 收款路由`} value={current} currentTarget={current} groups={groups.data ?? []} channels={channels.data ?? []} disabled={!!busy || groups.loading || !!groups.error} onChange={event => void assign(app, event.target.value)} /></td></tr>;
        })}</tbody></table></div>
      </LoadingState>
    </Modal>}
  </>;
}
