"use client";

import { FormEvent, useState } from "react";
import { api, useApi } from "../lib/api";
import { LoadingState, PageHead, Status, time } from "./common";

type Application = { id: string; appId: string; epayPid: string; name: string; status: string; webhookUrl: string | null; defaultChannel: string; createdAt: string };
type Credentials = { apiKey: string; webhookSecret: string; epayPid: string; epayKey: string };

export function Applications() {
  const { data, loading, error, reload } = useApi<Application[]>("/applications");
  const [credentials, setCredentials] = useState<Credentials | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true); setFormError(""); setCredentials(null);
    const form = new FormData(event.currentTarget);
    try {
      const response = await api<{ data: { credentials: Credentials } }>("/applications", {
        method: "POST",
        body: JSON.stringify({ name: form.get("name"), webhookUrl: form.get("webhookUrl"), defaultChannel: form.get("defaultChannel") }),
      });
      setCredentials(response.data.credentials);
      event.currentTarget.reset();
      await reload();
    } catch (cause) { setFormError(cause instanceof Error ? cause.message : "创建失败"); }
    finally { setSaving(false); }
  }

  return <>
    <PageHead eyebrow="Applications" title="业务应用" copy="每个自有业务使用独立 API Key、Webhook 密钥和 ePay 凭证。" />
    <section className="card section" style={{ marginBottom: 22 }}>
      <div className="section-title"><h2>创建应用</h2><span className="muted">凭证只显示一次</span></div>
      <form className="form-grid" onSubmit={submit}>
        <label>应用名称<input name="name" required placeholder="TUOXIN Matrix" /></label>
        <label>Webhook 地址<input name="webhookUrl" type="url" placeholder="https://example.com/webhook" /></label>
        <label>默认通道<select name="defaultChannel" defaultValue="MOCK"><option value="MOCK">Mock（开发）</option><option value="ALIPAY">支付宝当面付</option><option value="ALIPAY_BILL">支付宝账单收款</option></select></label>
        <button className="button" disabled={saving}>{saving ? "创建中…" : "创建应用"}</button>
      </form>
      {formError && <div className="error">{formError}</div>}
      {credentials && <div className="credentials"><strong>请立即保存以下凭证，关闭后无法再次查看。</strong><div className="credentials-grid">
        <Secret label="API Key" value={credentials.apiKey} /><Secret label="Webhook Secret" value={credentials.webhookSecret} /><Secret label="ePay PID" value={credentials.epayPid} /><Secret label="ePay Key" value={credentials.epayKey} />
      </div></div>}
    </section>
    <LoadingState loading={loading} error={error} empty={!data?.length}>
      <section className="card section"><div className="table-wrap"><table><thead><tr><th>应用</th><th>App ID / ePay PID</th><th>默认通道</th><th>Webhook</th><th>状态</th><th>创建时间</th></tr></thead>
        <tbody>{data?.map(item => <tr key={item.id}><td><strong>{item.name}</strong></td><td><div className="mono">{item.appId}</div><div className="mono muted">PID {item.epayPid}</div></td><td>{item.defaultChannel}</td><td className="mono">{item.webhookUrl || "—"}</td><td><Status value={item.status} /></td><td>{time(item.createdAt)}</td></tr>)}</tbody>
      </table></div></section>
    </LoadingState>
  </>;
}

function Secret({ label, value }: { label: string; value: string }) {
  return <div className="secret-row"><span>{label}</span><code>{value}</code></div>;
}
