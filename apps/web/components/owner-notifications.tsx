"use client";

import { useEffect, useMemo, useState } from "react";
import { api, useApi } from "../lib/api";
import { eventLabel, notificationChannelLabel } from "../lib/labels";
import { HoverDetail, LoadingState, Section, Status, Toast, Toggle, time } from "./common";

type Field = {
  key: string;
  label: string;
  type: "text" | "password" | "number" | "select";
  required?: boolean;
  secret?: boolean;
  placeholder?: string;
  options?: Array<{ value: string; label: string }>;
};
type Plugin = { code: string; name: string; description: string; capabilities: string[]; fields: Field[] };
type Instance = {
  id: string; plugin: string; name: string; enabled: boolean; revision: number;
  config: Record<string, unknown>; events: string[]; archivedAt: string | null; createdAt: string; updatedAt: string;
};
type Delivery = {
  id: string; channel: string; eventType: string | null; title: string; status: string; attempts: number;
  lastError: string | null; createdAt: string; instance: { id: string; name: string; plugin: string } | null;
};

const EVENTS = [
  ["ORDER_SUCCEEDED", "收款成功", "业务订单确认到账"],
  ["PAYMENT_LATE_DUPLICATE", "晚到重复支付", "同一订单出现第二笔可信到账"],
  ["RECEIPT_MISMATCH", "流水差错", "账单标识或金额存在冲突"],
  ["BUSINESS_WEBHOOK_DEAD", "业务回调耗尽", "业务系统可能尚未完成入账"],
  ["COLLECTOR_FAILURE", "采集连续失败", "账单采集连续失败至少三次"],
] as const;
const ALL_EVENTS = EVENTS.map(([value]) => value);

function defaultsFor(plugin: Plugin | undefined): Record<string, unknown> {
  if (!plugin) return {};
  const value: Record<string, unknown> = {};
  for (const field of plugin.fields) {
    if (field.key === "port") value[field.key] = 465;
    else if (field.type === "select") value[field.key] = field.options?.[0]?.value ?? "";
    else value[field.key] = "";
  }
  return value;
}

function formValue(field: Field, raw: string): unknown {
  if (!raw && !field.required) return undefined;
  if (field.type === "number" || (field.type === "select" && field.options?.every(option => /^\d+$/.test(option.value)))) {
    return raw ? Number(raw) : undefined;
  }
  return raw;
}

function ConfigFields({ plugin, config, onChange, secretValues, onSecretChange, clearSecrets, onClearSecret }: {
  plugin: Plugin; config: Record<string, unknown>; onChange: (key: string, value: unknown) => void;
  secretValues: Record<string, string>; onSecretChange: (key: string, value: string) => void;
  clearSecrets?: Set<string>; onClearSecret?: (key: string, clear: boolean) => void;
}) {
  return <div className="settings-grid">{plugin.fields.map(field => {
    const configured = Boolean(config[`${field.key}Configured`]);
    const value = field.secret ? (secretValues[field.key] ?? "") : String(config[field.key] ?? "");
    const clearing = Boolean(field.secret && clearSecrets?.has(field.key));
    const required = Boolean(field.required && (!field.secret || !configured));
    const control = field.type === "select"
      ? <select required={required} value={value} onChange={event => onChange(field.key, formValue(field, event.target.value))}>{field.options?.map(option => <option value={option.value} key={option.value}>{option.label}</option>)}</select>
      : <input required={required} disabled={clearing} type={field.secret ? "password" : field.type === "number" ? "number" : "text"} value={value} placeholder={field.placeholder} autoComplete={field.secret ? "new-password" : "off"} onChange={event => field.secret ? onSecretChange(field.key, event.target.value) : onChange(field.key, formValue(field, event.target.value))} />;
    return <label key={field.key}>
      {field.label}{field.secret && configured ? "（已配置，留空保留）" : ""}
      {control}
      {field.secret && configured && !field.required && onClearSecret && <span className="field-clear"><input type="checkbox" checked={clearSecrets?.has(field.key) ?? false} onChange={event => onClearSecret(field.key, event.target.checked)} />清除已保存的值</span>}
    </label>;
  })}</div>;
}

function EventPicker({ selected, onChange, disabled }: { selected: string[]; onChange: (events: string[]) => void; disabled?: boolean }) {
  const set = new Set(selected);
  return <div className="settings-events">{EVENTS.map(([value, label, description]) => <label className="event-option" key={value}>
    <input type="checkbox" disabled={disabled} checked={set.has(value)} onChange={event => {
      const next = new Set(selected); if (event.target.checked) next.add(value); else next.delete(value); onChange([...next]);
    }} />
    <span><strong>{label}</strong><em>{description}</em></span>
  </label>)}</div>;
}

function InstanceCard({ instance, plugin, busy, onBusy, onNotice, reload, reloadDeliveries }: {
  instance: Instance; plugin: Plugin; busy: boolean; onBusy: (busy: boolean) => void;
  onNotice: (notice: { type: "ok" | "error"; text: string } | null) => void;
  reload: () => Promise<void>; reloadDeliveries: () => Promise<void>;
}) {
  const [name, setName] = useState(instance.name);
  const [enabled, setEnabled] = useState(instance.enabled);
  const [config, setConfig] = useState<Record<string, unknown>>(instance.config);
  const [events, setEvents] = useState(instance.events);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [clearSecrets, setClearSecrets] = useState<Set<string>>(new Set());

  useEffect(() => {
    setName(instance.name); setEnabled(instance.enabled); setConfig(instance.config); setEvents(instance.events);
    setSecrets({}); setClearSecrets(new Set());
  }, [instance]);

  function payloadConfig() {
    const value: Record<string, unknown> = {};
    for (const field of plugin.fields) {
      if (field.secret) {
        if (clearSecrets.has(field.key)) value[field.key] = null;
        else if (secrets[field.key]) value[field.key] = secrets[field.key];
      } else if (config[field.key] !== undefined) value[field.key] = config[field.key];
    }
    return value;
  }

  async function save() {
    onBusy(true); onNotice(null);
    try {
      await api(`/notification-instances/${instance.id}`, { method: "POST", body: JSON.stringify({ name, plugin: instance.plugin, enabled, revision: instance.revision, config: payloadConfig(), events }) });
      await reload();
      onNotice({ type: "ok", text: `${name} 已保存。` });
    } catch (cause) { onNotice({ type: "error", text: cause instanceof Error ? cause.message : "保存失败" }); }
    finally { onBusy(false); }
  }

  async function test() {
    onBusy(true); onNotice(null);
    try {
      await api(`/notification-instances/${instance.id}/test`, { method: "POST", body: "{}" });
      await reloadDeliveries();
      onNotice({ type: "ok", text: "测试任务已排队；SUCCESS 才表示上游已接受。" });
    } catch (cause) { onNotice({ type: "error", text: cause instanceof Error ? cause.message : "测试失败" }); }
    finally { onBusy(false); }
  }

  async function remove() {
    if (!window.confirm(`删除通知实例「${instance.name}」？有历史投递时会归档并停止未发送任务。`)) return;
    onBusy(true); onNotice(null);
    try {
      await api(`/notification-instances/${instance.id}/delete`, { method: "POST", body: "{}" });
      await reload();
      onNotice({ type: "ok", text: "通知实例已删除或归档。" });
    } catch (cause) { onNotice({ type: "error", text: cause instanceof Error ? cause.message : "删除失败" }); }
    finally { onBusy(false); }
  }

  return <form onSubmit={event => { event.preventDefault(); void save(); }}><fieldset className="settings-group" disabled={busy}>
    <div className="settings-group-head">
      <div><h3>{instance.name}</h3><p>{plugin.name} · {instance.id} · {plugin.description}</p></div>
      <Toggle checked={enabled} onChange={setEnabled} label="启用通知实例" />
    </div>
    <div className="settings-grid"><label>实例名称<input required value={name} maxLength={120} onChange={event => setName(event.target.value)} /></label></div>
    <ConfigFields plugin={plugin} config={config} onChange={(key, value) => setConfig(current => ({ ...current, [key]: value }))} secretValues={secrets} onSecretChange={(key, value) => setSecrets(current => ({ ...current, [key]: value }))} clearSecrets={clearSecrets} onClearSecret={(key, clear) => setClearSecrets(current => { const next = new Set(current); if (clear) next.add(key); else next.delete(key); return next; })} />
    <div className="settings-group-head"><div><h3>事件订阅</h3><p>同一个事件可以同时投递到多个通知实例。</p></div></div>
    <EventPicker selected={events} onChange={setEvents} />
    <div className="settings-actions">
      <button className="button" type="submit">保存</button>
      <button className="button secondary" type="button" disabled={!instance.enabled} onClick={() => void test()}>发送测试</button>
      <button className="link-button" type="button" onClick={() => void remove()}>删除</button>
    </div>
  </fieldset></form>;
}

export function OwnerNotificationsPanel() {
  const { data: plugins, loading: pluginsLoading, error: pluginsError } = useApi<Plugin[]>("/notification-plugins");
  const { data: instances, loading, error, reload } = useApi<Instance[]>("/notification-instances");
  const { data: deliveries, loading: deliveriesLoading, error: deliveriesError, reload: reloadDeliveries } = useApi<Delivery[]>("/notification-deliveries", 10000);
  const [pluginCode, setPluginCode] = useState("");
  const selectedPlugin = useMemo(() => plugins?.find(plugin => plugin.code === pluginCode) ?? plugins?.[0], [plugins, pluginCode]);
  const [newId, setNewId] = useState("");
  const [newName, setNewName] = useState("");
  const [newEnabled, setNewEnabled] = useState(false);
  const [newConfig, setNewConfig] = useState<Record<string, unknown>>({});
  const [newSecrets, setNewSecrets] = useState<Record<string, string>>({});
  const [newEvents, setNewEvents] = useState<string[]>(ALL_EVENTS);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ type: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    if (!selectedPlugin) return;
    setPluginCode(selectedPlugin.code);
    setNewName(selectedPlugin.name);
    setNewConfig(defaultsFor(selectedPlugin));
    setNewSecrets({});
    setNewEvents(ALL_EVENTS);
  }, [selectedPlugin?.code]);

  async function create(event: React.FormEvent) {
    event.preventDefault(); if (!selectedPlugin) return;
    setBusy(true); setNotice(null);
    try {
      const config: Record<string, unknown> = {};
      for (const field of selectedPlugin.fields) {
        const value = field.secret ? newSecrets[field.key] : newConfig[field.key];
        if (value !== undefined && value !== "") config[field.key] = value;
      }
      await api("/notification-instances", { method: "POST", body: JSON.stringify({ ...(newId ? { id: newId } : {}), name: newName, plugin: selectedPlugin.code, enabled: newEnabled, config, events: newEvents }) });
      setNewId(""); setNewEnabled(false); setNewConfig(defaultsFor(selectedPlugin)); setNewSecrets({});
      await reload();
      setNotice({ type: "ok", text: "通知实例已创建。" });
    } catch (cause) { setNotice({ type: "error", text: cause instanceof Error ? cause.message : "创建失败" }); }
    finally { setBusy(false); }
  }

  async function retry(id: string) {
    setBusy(true); setNotice(null);
    try {
      await api(`/notification-deliveries/${id}/retry`, { method: "POST", body: "{}" });
      await reloadDeliveries();
      setNotice({ type: "ok", text: "通知已重新进入待发送队列。" });
    } catch (cause) { setNotice({ type: "error", text: cause instanceof Error ? cause.message : "重试失败" }); }
    finally { setBusy(false); }
  }

  return <>
    {notice && <Toast type={notice.type} text={notice.text} onClose={() => setNotice(null)} />}
    <Section title="通知插件" action={<span className="muted">业务 Webhook 不在这里配置</span>}>
      <LoadingState loading={pluginsLoading} error={pluginsError} empty={!plugins?.length} emptyText="没有可用的通知插件">
        <form onSubmit={event => void create(event)}>
          <fieldset className="settings-group" disabled={busy || !selectedPlugin}>
            <div className="settings-group-head">
              <div><h3>创建通知实例</h3><p>一个插件可以创建多个独立实例，例如不同 TG 群或飞书应用。</p></div>
              <Toggle checked={newEnabled} onChange={setNewEnabled} label="创建后立即启用" />
            </div>
            <div className="settings-grid">
              <label>插件<select required value={selectedPlugin?.code ?? ""} onChange={event => setPluginCode(event.target.value)}>{plugins?.map(plugin => <option value={plugin.code} key={plugin.code}>{plugin.name}</option>)}</select></label>
              <label>实例名称<input required value={newName} maxLength={120} onChange={event => setNewName(event.target.value)} /></label>
              <label>实例 ID（可留空自动生成）<input value={newId} maxLength={60} placeholder="notify-ops-tg" onChange={event => setNewId(event.target.value.toLowerCase())} /></label>
            </div>
            {selectedPlugin && <ConfigFields plugin={selectedPlugin} config={newConfig} onChange={(key, value) => setNewConfig(current => ({ ...current, [key]: value }))} secretValues={newSecrets} onSecretChange={(key, value) => setNewSecrets(current => ({ ...current, [key]: value }))} />}
            <div className="settings-group-head"><div><h3>默认订阅</h3><p>创建后仍可逐实例调整。</p></div></div>
            <EventPicker selected={newEvents} onChange={setNewEvents} />
            <div className="settings-actions"><button className="button" type="submit" disabled={busy || !selectedPlugin}>{busy ? "创建中…" : "创建通知实例"}</button></div>
          </fieldset>
        </form>
      </LoadingState>
    </Section>

    <Section title="通知实例" action={<button className="link-button" type="button" disabled={busy} onClick={() => void reload()}>重新加载</button>}>
      <LoadingState loading={loading} error={error} empty={!instances?.length} emptyText="还没有通知实例；先从上方选择一个插件创建">
        {instances?.map(instance => {
          const plugin = plugins?.find(item => item.code === instance.plugin);
          return plugin ? <InstanceCard key={instance.id} instance={instance} plugin={plugin} busy={busy} onBusy={setBusy} onNotice={setNotice} reload={reload} reloadDeliveries={reloadDeliveries} /> : null;
        })}
      </LoadingState>
    </Section>

    <Section title="通知投递" action={<span className="muted">最近 50 条 · 自动刷新</span>} className="detail-section">
      <LoadingState loading={deliveriesLoading} error={deliveriesError} empty={!deliveries?.length} emptyText="还没有通知投递记录">
        <div className="table-wrap"><table>
          <thead><tr><th>时间</th><th>实例</th><th>事件</th><th>标题</th><th>状态</th><th>尝试</th><th></th></tr></thead>
          <tbody>{deliveries?.map(row => <tr key={row.id}>
            <td>{time(row.createdAt)}</td>
            <td data-label="实例"><strong>{row.instance?.name ?? notificationChannelLabel(row.channel)}</strong><div className="muted">{notificationChannelLabel(row.instance?.plugin ?? row.channel)}</div></td>
            <td data-label="事件">{eventLabel(row.eventType ?? "—")}</td>
            <td data-label="标题">{row.title}</td>
            <td data-label="状态"><HoverDetail text={row.lastError} tone="danger"><Status value={row.status} /></HoverDetail></td>
            <td data-label="尝试">{row.attempts}</td>
            <td data-label="操作">{row.status === "DEAD" && row.instance && <button className="link-button" type="button" disabled={busy} onClick={() => void retry(row.id)}>重试</button>}</td>
          </tr>)}</tbody>
        </table></div>
      </LoadingState>
    </Section>
  </>;
}
