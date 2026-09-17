"use client";

import { FormEvent, useEffect, useState } from "react";
import { api, useApi } from "../lib/api";
import { LoadingState, Modal, PageHead, Section, Status, time } from "./common";
import { assignable, type Channel } from "./channels";
import { channelLabel } from "../lib/labels";

type Counts = { orders: number; refunds: number; webhookDeliveries: number };
type Application = {
  id: string; appId: string; epayPid: string; name: string; status: string; webhookUrl: string | null;
  defaultChannel: string; defaultChannelId: string | null; archivedAt: string | null; pausedAt: string | null;
  createdAt: string; _count: Counts;
};
type CreatedCredentials = { apiKey: string; webhookSecret: string; epayPid: string; epayKey: string };
type RotatedCredentials = { apiKey: string; webhookSecret: string; epayKey: string };
type Cleared = { orders: number; payments: number; refunds: number; events: number; webhookDeliveries: number; exceptions: number; receipts: number };
type DeleteResult = { appId: string; name: string; archived: boolean; cleared: Cleared };

function businessTotal(count: Counts) { return count.orders + count.refunds + count.webhookDeliveries; }
function businessSummary(count: Counts) { return `订单 ${count.orders} 笔 · 退款 ${count.refunds} 笔 · 通知投递 ${count.webhookDeliveries} 条`; }
function clearedSummary(cleared: Cleared) {
  const parts = [
    cleared.orders && `${cleared.orders} 笔订单`,
    cleared.payments && `${cleared.payments} 次支付尝试`,
    cleared.refunds && `${cleared.refunds} 笔未完成退款`,
    cleared.events && `${cleared.events} 条事件`,
    cleared.webhookDeliveries && `${cleared.webhookDeliveries} 条通知投递`,
    cleared.exceptions && `${cleared.exceptions} 条异常`,
    cleared.receipts && `${cleared.receipts} 条对账线索`,
  ].filter(Boolean);
  return parts.length ? parts.join("、") : "没有需要清理的在用数据";
}
function reason(cause: unknown, fallback: string) { return cause instanceof Error ? cause.message : fallback; }

export function Applications() {
  const [showArchived, setShowArchived] = useState(false);
  const { data, loading, error, reload } = useApi<Application[]>(`/applications${showArchived ? "?includeArchived=true" : ""}`);
  const channels = useApi<Channel[]>("/channel-instances");
  const [credentials, setCredentials] = useState<CreatedCredentials | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<{ type: "ok" | "error"; text: string } | null>(null);
  const [rotating, setRotating] = useState<Application | null>(null);
  const [rotated, setRotated] = useState<RotatedCredentials | null>(null);
  const [removing, setRemoving] = useState<Application | null>(null);
  const [confirmName, setConfirmName] = useState("");
  const [removeError, setRemoveError] = useState("");
  const [removed, setRemoved] = useState<DeleteResult | null>(null);

  useEffect(() => { void reload(); }, [showArchived, reload]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true); setFormError(""); setCredentials(null);
    const element = event.currentTarget;
    const form = new FormData(element);
    try {
      const response = await api<{ data: { credentials: CreatedCredentials } }>("/applications", {
        method: "POST",
        body: JSON.stringify({ name: form.get("name"), webhookUrl: form.get("webhookUrl"), defaultChannelId: form.get("defaultChannelId") }),
      });
      setCredentials(response.data.credentials);
      element.reset();
      await reload();
    } catch (cause) { setFormError(reason(cause, "创建失败")); }
    finally { setSaving(false); }
  }

  async function rotate(application: Application) {
    setBusy(application.id); setNotice(null);
    try {
      const response = await api<{ data: RotatedCredentials }>(`/applications/${application.id}/rotate-credentials`, { method: "POST" });
      setRotated(response.data);
      setNotice({ type: "ok", text: `「${application.name}」凭证已重置，旧凭证立即失效。` });
    } catch (cause) { setNotice({ type: "error", text: reason(cause, "凭证重置失败") }); }
    finally { setBusy(""); }
  }

  async function toggleStatus(application: Application) {
    const next = application.status === "ACTIVE" ? "DISABLED" : "ACTIVE";
    if (next === "DISABLED" && !window.confirm(`停用「${application.name}」后，该应用不能再创建新订单；已存在的订单、退款和通知投递仍会继续处理。确认停用？`)) return;
    setBusy(application.id); setNotice(null);
    try {
      await api(`/applications/${application.id}/status`, { method: "POST", body: JSON.stringify({ status: next }) });
      setNotice({ type: "ok", text: next === "DISABLED" ? `「${application.name}」已停用。` : `「${application.name}」已启用。` });
      await reload();
    } catch (cause) { setNotice({ type: "error", text: reason(cause, next === "DISABLED" ? "停用失败" : "启用失败") }); }
    finally { setBusy(""); }
  }

  async function remove(application: Application) {
    setBusy(application.id); setRemoveError("");
    try {
      const response = await api<{ data: DeleteResult }>(`/applications/${application.id}/delete`, { method: "POST" });
      setRemoved(response.data);
      setNotice({ type: "ok", text: response.data.archived ? `「${application.name}」已删除，业务数据已归档。` : `「${application.name}」已删除。` });
      setConfirmName("");
      await reload();
    } catch (cause) { setRemoveError(reason(cause, "删除失败")); }
    finally { setBusy(""); }
  }

  function closeRotate() { setRotating(null); setRotated(null); }
  function closeRemove() { setRemoving(null); setConfirmName(""); setRemoveError(""); setRemoved(null); }

  return <>
    <PageHead eyebrow="Applications" title="业务应用" copy="每个自有业务使用独立 API Key、Webhook 密钥和 ePay 凭证；凭证可随时重置，不再使用的应用可停用或删除。" />
    {notice && <div className={`operation-notice ${notice.type === "error" ? "error" : ""}`} aria-live="polite">{notice.text}</div>}
    <Section title="创建应用" action={<span className="muted">凭证只显示一次</span>} style={{ marginBottom: 22 }}>
      <form className="form-grid" onSubmit={submit}>
        <label>应用名称<input name="name" required placeholder="TUOXIN Matrix" /></label>
        <label>Webhook 地址<input name="webhookUrl" type="url" placeholder="https://example.com/webhook" /></label>
        <label>默认通道<select name="defaultChannelId" defaultValue="" required><option value="" disabled>请选择已检测的通道</option>{channels.data?.filter(assignable).map(channel => <option key={channel.id} value={channel.id}>{channel.name}</option>)}</select></label>
        <button className="button" disabled={saving}>{saving ? "创建中…" : "创建应用"}</button>
      </form>
      {formError && <div className="error">{formError}</div>}
      {channels.error && <div className="error">{channels.error}</div>}
      {!channels.loading && !channels.data?.some(assignable) && <p className="muted">请先在“插件与通道”中配置、启用并检测一个收款通道。</p>}
      {credentials && <CredentialBlock title="请立即保存以下凭证，关闭后无法再次查看。" items={[
        ["API Key", credentials.apiKey], ["Webhook Secret", credentials.webhookSecret], ["ePay PID", credentials.epayPid], ["ePay Key", credentials.epayKey],
      ]} />}
    </Section>

    <LoadingState loading={loading} error={error} empty={!data?.length}>
      <section className="card section">
        <div className="section-head"><h2>应用列表</h2><label className="toggle-inline"><input type="checkbox" checked={showArchived} onChange={event => setShowArchived(event.target.checked)} />显示已归档</label></div>
        <div className="table-wrap"><table>
        <thead><tr><th>应用</th><th>App ID / ePay PID</th><th>默认通道</th><th>Webhook</th><th>状态</th><th>创建时间</th><th>操作</th></tr></thead>
        <tbody>{data?.map(item => <tr key={item.id} className={item.archivedAt ? "row-archived" : undefined}>
          <td><strong>{item.name}</strong>{item.archivedAt && <div className="muted">已于 {time(item.archivedAt)} 归档</div>}</td>
          <td data-label="App ID"><div className="mono">{item.appId}</div><div className="mono muted">PID {item.epayPid}</div></td>
          <td data-label="默认通道">{channels.data?.find(channel => channel.id === item.defaultChannelId)?.name || channelLabel(item.defaultChannel)}</td>
          <td data-label="Webhook" className="mono">{item.webhookUrl || "—"}</td>
          <td data-label="状态"><Status value={item.status} /></td>
          <td data-label="创建时间">{time(item.createdAt)}</td>
          <td data-label="操作">
            {item.archivedAt ? <span className="muted">已归档，仅作追溯</span> : <>
              <div className="row-actions">
                <button className="button secondary" type="button" disabled={busy !== ""} onClick={() => { setRotated(null); setRotating(item); }}>重置凭证</button>
                <button className="button secondary" type="button" disabled={busy !== ""} onClick={() => void toggleStatus(item)}>{busy === item.id ? "处理中…" : item.status === "ACTIVE" ? "停用" : "启用"}</button>
                <button className="button danger" type="button" disabled={busy !== ""} title="删除该应用" onClick={() => { setConfirmName(""); setRemoveError(""); setRemoved(null); setRemoving(item); }}>删除</button>
              </div>
              <div className="muted">{businessTotal(item._count) > 0 ? `已有 ${businessSummary(item._count)}，删除后归档保留` : "尚无业务数据，可直接删除"}</div>
            </>}
          </td>
        </tr>)}</tbody>
      </table></div></section>
    </LoadingState>

    {rotating && <Modal title={rotated ? "新凭证（仅显示一次）" : "重置应用凭证"} onClose={closeRotate}>
      {rotated ? <>
        <p className="muted">旧凭证已立即失效，请把新凭证更新到业务侧配置。离开本窗口后无法再次查看。</p>
        <CredentialBlock title="请立即保存以下凭证。" items={[
          ["API Key", rotated.apiKey], ["Webhook Secret", rotated.webhookSecret], ["ePay Key", rotated.epayKey],
        ]} />
        <p className="muted">ePay PID 未变更：它是商户标识而不是密钥，轮换只会让业务侧已配置的商户号失效。</p>
        <div className="dialog-actions"><button className="button" type="button" onClick={closeRotate}>我已保存，关闭</button></div>
      </> : <>
        <p>即将重置「<strong>{rotating.name}</strong>」的三项凭证：接口鉴权 API Key、回调验签 Webhook Secret、ePay 商户密钥。</p>
        <ul className="dialog-list">
          <li>重置后旧凭证立即失效：业务侧未同步新凭证期间，新订单接口与回调验签都会失败。</li>
          <li>已存在的订单、退款与通知投递不受影响，仍按原流程继续处理。</li>
          <li>本次操作会记入管理操作审计。</li>
        </ul>
        {busy === rotating.id && <p className="muted">正在重置…</p>}
        <div className="dialog-actions">
          <button className="button danger" type="button" disabled={busy !== ""} onClick={() => void rotate(rotating)}>确认重置</button>
          <button className="button secondary" type="button" onClick={closeRotate}>取消</button>
        </div>
      </>}
    </Modal>}

    {removing && <Modal title="删除应用" onClose={closeRemove}>
      {removed ? <>
        <p>应用「<strong>{removed.name}</strong>」已删除。</p>
        <div className={`dialog-warning ${removed.archived ? "is-info" : ""}`}>
          {removed.archived
            ? `该应用承载过业务数据，已归档清理：${clearedSummary(removed.cleared)}。`
            : "该应用没有业务数据，记录已直接从库中删除。"}
        </div>
        {removed.archived && <ul className="dialog-list">
          <li>凭证已立即失效，该应用不能再创建新订单，业务接口也查不到它的任何订单。</li>
          <li>已成功的支付与已发起的退款记录保留在库里，对账与追溯不受影响，可在退款列表按「已归档」筛出。</li>
          <li>如需还原这批历史数据，请让 DBA 按 App ID <span className="mono">{removed.appId}</span> 从 orders.deletedWithApplicationId 反查。</li>
        </ul>}
        <div className="dialog-actions"><button className="button" type="button" onClick={closeRemove}>知道了</button></div>
      </> : <>
        <p>应用「<strong>{removing.name}</strong>」，App ID <span className="mono">{removing.appId}</span>。</p>
        {businessTotal(removing._count) > 0 ? <>
          <div className="dialog-warning">该应用已产生业务数据（{businessSummary(removing._count)}），删除后这些数据会一并从管理台移除。</div>
          <ul className="dialog-list">
            <li>删除立即生效且不可撤销：凭证失效、不能再创建新订单，订单、退款、对账、异常各页都不再显示它的数据。</li>
            <li>记录不是物理抹除：已成功的支付与已发起的退款会保留在库里以备追溯，随时可以由 DBA 还原。</li>
            <li>如果只是想停掉这个业务、又希望数据继续留在管理台，请改用「停用」。本次操作会记入管理操作审计。</li>
          </ul>
        </> : <>
          <ul className="dialog-list">
            <li>该应用目前没有订单、退款或通知投递记录，删除不会影响任何资金数据。</li>
            <li>删除后 API Key、Webhook 密钥与 ePay 凭证立即失效，且无法恢复。</li>
          </ul>
        </>}
        <label>输入应用名称以确认<input value={confirmName} onChange={event => setConfirmName(event.target.value)} placeholder={removing.name} autoComplete="off" /></label>
        {removeError && <div className="error">{removeError}</div>}
        <div className="dialog-actions">
          <button className="button danger" type="button" disabled={busy !== "" || confirmName.trim() !== removing.name} onClick={() => void remove(removing)}>{busy === removing.id ? "删除中…" : "确认删除"}</button>
          <button className="button secondary" type="button" onClick={closeRemove}>取消</button>
        </div>
      </>}
    </Modal>}
  </>;
}

function CredentialBlock({ title, items }: { title: string; items: Array<[string, string]> }) {
  return <div className="credentials"><strong>{title}</strong><div className="credentials-grid">
    {items.map(([label, value]) => <div className="secret-row" key={label}><span>{label}</span><code>{value}</code></div>)}
  </div></div>;
}
