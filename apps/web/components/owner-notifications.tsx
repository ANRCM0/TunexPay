"use client";

import { useEffect, useState } from "react";
import { api, useApi } from "../lib/api";
import { LoadingState, Section, Status, Toggle, time } from "./common";
import { notificationChannelLabel } from "../lib/labels";

type Draft = { revision: number; emailEnabled: boolean; feishuEnabled: boolean; smtpHost: string; smtpPort: 465 | 587; smtpUser: string; from: string; to: string; paymentSuccess: boolean; anomalies: boolean; webhookFailure: boolean; collectorFailure: boolean };
type View = Draft & { smtpPasswordConfigured: boolean; feishuWebhookConfigured: boolean; feishuSecretConfigured: boolean };
type Delivery = { id: string; channel: string; title: string; status: string; attempts: number; lastError: string | null; createdAt: string };

const empty = { smtpPassword: "", feishuWebhook: "", feishuSecret: "" };

const EVENTS = [
  ["paymentSuccess", "收款成功", "订单确认到账时提醒"],
  ["anomalies", "支付 / 流水异常", "晚到重复、多候选、状态冲突"],
  ["webhookFailure", "业务回调重试耗尽", "通知投递进入 DEAD 时提醒"],
  ["collectorFailure", "采集连续失败", "相同故障每 15 分钟最多一次"],
] as const;

export function OwnerNotificationsPanel() {
  const { data, loading, error, reload } = useApi<View>("/owner-notifications/settings");
  const { data: deliveries, loading: deliveriesLoading, error: deliveriesError, reload: reloadDeliveries } = useApi<Delivery[]>("/owner-notifications/deliveries", 10000);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [secrets, setSecrets] = useState(empty);
  const [clear, setClear] = useState({ smtpPassword: false, feishuWebhook: false, feishuSecret: false });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (!data) return;
    const { smtpPasswordConfigured: _p, feishuWebhookConfigured: _w, feishuSecretConfigured: _s, ...rest } = data;
    setDraft(rest);
    setSecrets(empty);
    setClear({ smtpPassword: false, feishuWebhook: false, feishuSecret: false });
  }, [data]);

  function update<K extends keyof Draft>(key: K, value: Draft[K]) { setDraft(v => v ? { ...v, [key]: value } : v); }

  async function save(event: React.FormEvent) {
    event.preventDefault(); if (!draft) return;
    setBusy(true); setNotice("");
    try {
      await api("/owner-notifications/settings", { method: "POST", body: JSON.stringify({ ...draft, ...Object.fromEntries(Object.entries(secrets).map(([k, v]) => [k, clear[k as keyof typeof clear] ? null : v])) }) });
      setSecrets(empty);
      await reload();
      setNotice("已保存，后续通知动态使用新配置。");
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : "保存失败"); }
    finally { setBusy(false); }
  }

  async function test(channel: "EMAIL" | "FEISHU") {
    setBusy(true);
    try {
      await api("/owner-notifications/test", { method: "POST", body: JSON.stringify({ channel }) });
      setNotice("测试任务已排队，请查看下方投递状态（SUCCESS 才代表发送成功）。");
      await reloadDeliveries();
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : "测试失败"); }
    finally { setBusy(false); }
  }

  function secretField(key: keyof typeof empty, label: string, configured: boolean) {
    return <label key={key}>{label}（{configured ? "已配置，留空保留" : "未配置"}）
      <input type="password" value={secrets[key]} autoComplete="new-password" onChange={event => setSecrets(current => ({ ...current, [key]: event.target.value }))} />
      {configured && <span className="field-clear"><input type="checkbox" checked={clear[key]} onChange={event => setClear(current => ({ ...current, [key]: event.target.checked }))} />清除已保存的值</span>}
    </label>;
  }

  return <>
    <Section title="通知渠道与事件" action={<button className="link-button" type="button" disabled={busy} onClick={() => void reload()}>重新加载</button>}>
      {notice && <div className="operation-notice" aria-live="polite">{notice}</div>}
      <LoadingState loading={loading} error={error}>{draft && data && <form onSubmit={event => void save(event)}>
        <fieldset className="settings-group" disabled={busy}>
          <div className="settings-group-head">
            <div><h3>邮箱通知</h3><p>通过 SMTP 发送，只允许公网主机与安全 TLS。</p></div>
            <Toggle checked={draft.emailEnabled} onChange={value => update("emailEnabled", value)} label="启用邮箱通知" />
          </div>
          <div className="settings-grid">
            <label>SMTP 主机<input value={draft.smtpHost} onChange={event => update("smtpHost", event.target.value)} autoComplete="off" placeholder="smtp.example.com" /></label>
            <label>SMTP 加密方式<select value={draft.smtpPort} onChange={event => update("smtpPort", Number(event.target.value) as 465 | 587)}><option value={465}>465 · TLS</option><option value={587}>587 · 强制 STARTTLS</option></select></label>
            <label>SMTP 登录账号<input value={draft.smtpUser} onChange={event => update("smtpUser", event.target.value)} autoComplete="off" /></label>
            {secretField("smtpPassword", "SMTP 密码 / 授权码", data.smtpPasswordConfigured)}
            <label>发件邮箱<input value={draft.from} onChange={event => update("from", event.target.value)} autoComplete="off" /></label>
            <label>收件邮箱<input value={draft.to} onChange={event => update("to", event.target.value)} autoComplete="off" /></label>
          </div>
        </fieldset>

        <fieldset className="settings-group" disabled={busy}>
          <div className="settings-group-head">
            <div><h3>飞书通知</h3><p>只允许官方自定义机器人地址，建议使用私密群。</p></div>
            <Toggle checked={draft.feishuEnabled} onChange={value => update("feishuEnabled", value)} label="启用飞书机器人通知" />
          </div>
          <div className="settings-grid">
            {secretField("feishuWebhook", "飞书 Webhook", data.feishuWebhookConfigured)}
            {secretField("feishuSecret", "飞书签名校验密钥（选填）", data.feishuSecretConfigured)}
          </div>
        </fieldset>

        <fieldset className="settings-group" disabled={busy}>
          <div className="settings-group-head">
            <div><h3>通知事件</h3><p>Mock 收款不发送本人通知。</p></div>
          </div>
          <div className="settings-events">{EVENTS.map(([key, label, description]) => <label className="event-option" key={key}>
            <input type="checkbox" checked={draft[key]} onChange={event => update(key, event.target.checked)} />
            <span><strong>{label}</strong><em>{description}</em></span>
          </label>)}</div>
        </fieldset>

        <div className="settings-actions">
          <button className="button" type="submit" disabled={busy}>{busy ? "保存中…" : "保存通知配置"}</button>
          <button className="button secondary" type="button" disabled={busy || !data.emailEnabled} onClick={() => void test("EMAIL")}>发送测试邮件</button>
          <button className="button secondary" type="button" disabled={busy || !data.feishuEnabled} onClick={() => void test("FEISHU")}>发送飞书测试</button>
          <span className="muted">配置需先保存，发送结果见下方投递记录</span>
        </div>
      </form>}</LoadingState>
    </Section>

    <Section title="投递记录" action={<span className="muted">最近 50 条 · 自动刷新</span>} className="detail-section">
      <LoadingState loading={deliveriesLoading} error={deliveriesError} empty={!deliveries?.length}>
        <div className="table-wrap"><table>
          <thead><tr><th>时间</th><th>渠道</th><th>标题</th><th>状态</th><th>尝试</th></tr></thead>
          <tbody>{deliveries?.map(row => <tr key={row.id}>
            <td>{time(row.createdAt)}</td>
            <td data-label="渠道">{notificationChannelLabel(row.channel)}</td>
            <td data-label="标题"><strong>{row.title}</strong>{row.lastError && <div className="row-error">{row.lastError}</div>}</td>
            <td data-label="状态"><Status value={row.status} /></td>
            <td data-label="尝试">{row.attempts}</td>
          </tr>)}</tbody>
        </table></div>
      </LoadingState>
    </Section>
  </>;
}
