"use client";

import { Button, Checkbox, Form, Input, InputNumber, Modal, Select, Switch, Table } from "@arco-design/web-react";
import type { ColumnProps } from "@arco-design/web-react/es/Table";
import { useEffect, useMemo, useState } from "react";
import { api, useApi } from "../lib/api";
import { notificationFieldErrors } from "../lib/settings-validation";
import { sortRows, type SortColumn } from "../lib/sort";
import { eventLabel, notificationChannelLabel } from "../lib/labels";
import { ConfirmModal, CopyValue, HoverDetail, LoadingState, RowAction, Status, Toast, sortValueProps, time } from "./common";
import { FilterCard, FilterInput, FilterItem, FilterSelect, ListCard, ListPage, Pager, ToolbarNote, ToolbarSpacer, sortHeader, useClientPager, useTableSort } from "./list";

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
// 事件选项带上说明文字：只写事件名的话，配置的人无法判断自己会不会收到不该收的通知。
const EVENT_OPTIONS = EVENTS.map(([value, label, description]) => ({ value, label: `${label} · ${description}` }));

const INSTANCE_STATUS_OPTIONS = [
  { label: "全部状态", value: "ALL" },
  { label: "已启用", value: "ENABLED" },
  { label: "已停用", value: "DISABLED" },
];

const DELIVERY_STATUS_OPTIONS = [
  { label: "全部状态", value: "ALL" },
  { label: "待发送", value: "PENDING" },
  { label: "发送中", value: "PROCESSING" },
  { label: "成功", value: "SUCCESS" },
  { label: "重试耗尽", value: "DEAD" },
  { label: "已取消", value: "CANCELLED" },
];

const DELIVERY_COLUMNS: SortColumn<Delivery>[] = [
  { key: "createdAt", label: "时间", type: "date" },
  { key: "instance", label: "实例", accessor: (row) => row.instance?.name ?? row.channel },
  { key: "eventType", label: "事件", accessor: (row) => row.eventType ?? "" },
  { key: "title", label: "标题" },
  { key: "status", label: "状态" },
  { key: "attempts", label: "尝试", type: "number" },
];

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

function reason(cause: unknown, fallback: string) { return cause instanceof Error ? cause.message : fallback; }


/** 插件配置字段：按插件声明的类型渲染成 Arco 控件，密钥一律走 Input.Password 且不回显已保存的值。 */
function ConfigFields({ plugin, config, onChange, secretValues, onSecretChange, clearSecrets, onClearSecret, disabled, errors = {} }: {
  plugin: Plugin; config: Record<string, unknown>; onChange: (key: string, value: unknown) => void;
  secretValues: Record<string, string>; onSecretChange: (key: string, value: string) => void;
  clearSecrets?: Set<string>; onClearSecret?: (key: string, clear: boolean) => void;
  disabled?: boolean;
  errors?: Record<string, string>;
}) {
  return <div className="settings-grid">{plugin.fields.map(field => {
    const configured = Boolean(config[`${field.key}Configured`]);
    const value = field.secret ? (secretValues[field.key] ?? "") : String(config[field.key] ?? "");
    const clearing = Boolean(field.secret && clearSecrets?.has(field.key));
    // 已保存过的密钥不必重填，只有"从未配置"的必填密钥才要求输入
    const required = Boolean(field.required && (!field.secret || !configured));
    const label = field.secret && configured ? `${field.label}（已配置，留空保留）` : field.label;

    return <Form.Item key={field.key} label={label} required={required}>
      {field.type === "select"
        ? <Select
          value={value || undefined}
          disabled={disabled}
          placeholder={field.placeholder}
          options={field.options?.map(option => ({ label: option.label, value: option.value })) ?? []}
          onChange={raw => onChange(field.key, formValue(field, String(raw ?? "")))}
        />
        : field.type === "number"
          ? <InputNumber
            value={value === "" ? undefined : Number(value)}
            disabled={disabled}
            placeholder={field.placeholder}
            onChange={raw => onChange(field.key, formValue(field, raw === null || raw === undefined ? "" : String(raw)))}
          />
          : field.secret
            ? <Input.Password
              value={value}
              disabled={disabled || clearing}
              placeholder={field.placeholder}
              autoComplete="new-password"
              onChange={raw => onSecretChange(field.key, raw)}
            />
            : <Input
              value={value}
              disabled={disabled}
              placeholder={field.placeholder}
              autoComplete="off"
              onChange={raw => onChange(field.key, formValue(field, raw))}
            />}
      {errors[field.key] && <p className="form-field-error" role="alert">{errors[field.key]}</p>}
      {field.secret && configured && !field.required && onClearSecret && <span className="field-clear">
        <Checkbox checked={clearSecrets?.has(field.key) ?? false} disabled={disabled} onChange={checked => onClearSecret(field.key, checked)}>清除已保存的值</Checkbox>
      </span>}
    </Form.Item>;
  })}</div>;
}

/** 事件订阅多选：用 Checkbox.Group 而不是手写复选框，全选/受控/禁用由组件统一处理。 */
function EventPicker({ selected, onChange, disabled }: { selected: string[]; onChange: (events: string[]) => void; disabled?: boolean }) {
  return <Checkbox.Group
    className="settings-events"
    value={selected}
    options={EVENT_OPTIONS}
    disabled={disabled}
    onChange={values => onChange(values as string[])}
  />;
}

/** 创建段：插件选择在前，字段随插件切换而整套重置。 */
function CreateInstancePanel({ plugins, busy, onBusy, onNotice, onCreated }: {
  plugins: Plugin[];
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onNotice: (notice: { type: "ok" | "error"; text: string } | null) => void;
  onCreated: () => Promise<void>;
}) {
  const [pluginCode, setPluginCode] = useState("");
  const selectedPlugin = useMemo(() => plugins.find(plugin => plugin.code === pluginCode) ?? plugins[0], [plugins, pluginCode]);
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [events, setEvents] = useState<string[]>(ALL_EVENTS);
  const [error, setError] = useState("");
  const [pendingPlugin, setPendingPlugin] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const dirty = Boolean(selectedPlugin && (
    name !== selectedPlugin.name || id !== "" || enabled ||
    JSON.stringify(config) !== JSON.stringify(defaultsFor(selectedPlugin)) ||
    Object.values(secrets).some(Boolean) ||
    JSON.stringify(events) !== JSON.stringify(ALL_EVENTS)
  ));
  const selectPlugin = (next: string) => {
    if (next === selectedPlugin?.code) return;
    if (dirty) setPendingPlugin(next);
    else setPluginCode(next);
  };

  // 换插件等于换一整套配置字段：重置成新插件的默认值，免得上一个插件的键被带过去。
  useEffect(() => {
    if (!selectedPlugin) return;
    setPluginCode(selectedPlugin.code);
    setName(selectedPlugin.name);
    setConfig(defaultsFor(selectedPlugin));
    setSecrets({});
    setEvents(ALL_EVENTS);
    setError(""); setFieldErrors({});
  }, [selectedPlugin?.code]);

  async function create() {
    if (busy || !selectedPlugin) return;
    if (!name.trim()) { setError("请填写通知实例名称"); return; }
    const issues = notificationFieldErrors(selectedPlugin.fields, config, secrets);
    setFieldErrors(issues);
    if (Object.keys(issues).length) { setError("请检查标红的必填项或无效配置"); return; }
    onBusy(true); onNotice(null); setError("");
    try {
      const payload: Record<string, unknown> = {};
      for (const field of selectedPlugin.fields) {
        const value = field.secret ? secrets[field.key] : config[field.key];
        if (value !== undefined && value !== "") payload[field.key] = value;
      }
      await api("/notification-instances", { method: "POST", body: JSON.stringify({ ...(id ? { id } : {}), name, plugin: selectedPlugin.code, enabled, config: payload, events }) });
      setId(""); setEnabled(false); setConfig(defaultsFor(selectedPlugin)); setSecrets({}); setFieldErrors({});
      onNotice({ type: "ok", text: "通知实例已创建。" });
      try { await onCreated(); }
      catch { onNotice({ type: "error", text: "通知实例已经创建成功，但列表刷新失败。请手动刷新，不要重复创建。" }); }
    } catch (cause) { onNotice({ type: "error", text: reason(cause, "创建失败") }); }
    finally { onBusy(false); }
  }

  if (!selectedPlugin) return null;

  return <>
    <Form layout="vertical" onSubmit={() => void create()}>
    <div className="settings-grid">
      <Form.Item label="插件" required>
        <Select
          value={selectedPlugin.code}
          disabled={busy}
          options={plugins.map(plugin => ({ label: plugin.name, value: plugin.code }))}
          onChange={value => selectPlugin(String(value))}
        />
      </Form.Item>
      <Form.Item label="实例名称" required>
        <Input value={name} maxLength={120} disabled={busy} onChange={value => { setName(value); setError(""); }} />
      </Form.Item>
      <Form.Item label="实例 ID（可留空自动生成）">
        <Input value={id} maxLength={60} placeholder="notify-ops-tg" disabled={busy} onChange={value => setId(value.toLowerCase())} />
      </Form.Item>
    </div>
    <ConfigFields
      plugin={selectedPlugin}
      config={config}
      disabled={busy}
      secretValues={secrets}
      onChange={(key, value) => { setConfig(current => ({ ...current, [key]: value })); setFieldErrors(current => { const next = { ...current }; delete next[key]; return next; }); }}
      onSecretChange={(key, value) => { setSecrets(current => ({ ...current, [key]: value })); setFieldErrors(current => { const next = { ...current }; delete next[key]; return next; }); }}
      errors={fieldErrors}
    />
    <div className="settings-group-head">
      <div><h3>默认订阅</h3><p>创建后仍可逐实例调整。</p></div>
      <span className="field-clear">
        <Switch size="small" checked={enabled} disabled={busy} onChange={setEnabled} aria-label="创建后立即启用" />
        <span>创建后立即启用</span>
      </span>
    </div>
    <EventPicker selected={events} onChange={setEvents} disabled={busy} />
    {error && <div className="error">{error}</div>}
    <div className="settings-actions">
      <Button type="primary" htmlType="submit" loading={busy}>{busy ? "创建中…" : "创建通知实例"}</Button>
    </div>
  </Form>
    {pendingPlugin !== null && <ConfirmModal title="切换通知插件？" copy="切换后会重置当前填写的插件配置、密钥和事件订阅，尚未保存的内容会丢失。" confirmLabel="放弃并切换" danger onClose={() => setPendingPlugin(null)} onConfirm={() => { setPluginCode(pendingPlugin); setPendingPlugin(null); }} />}
  </>;
}

/** 实例编辑：弹窗内的表单，保存/测试/删除都与列表共用父级的同一套动作。 */
function InstanceEditor({ instance, plugin, busy, onBusy, onDirtyChange, onNotice, onSaved, onTest, onRemove, onClose }: {
  instance: Instance; plugin: Plugin; busy: boolean;
  onBusy: (busy: boolean) => void;
  onDirtyChange: (dirty: boolean) => void;
  onNotice: (notice: { type: "ok" | "error"; text: string } | null) => void;
  onSaved: () => Promise<void>;
  onTest: () => Promise<void>;
  onRemove: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(instance.name);
  const [enabled, setEnabled] = useState(instance.enabled);
  const [config, setConfig] = useState<Record<string, unknown>>(instance.config);
  const [events, setEvents] = useState<string[]>(instance.events);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [clearSecrets, setClearSecrets] = useState<Set<string>>(new Set());
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const dirty = name !== instance.name || enabled !== instance.enabled ||
    JSON.stringify(config) !== JSON.stringify(instance.config) ||
    JSON.stringify(events) !== JSON.stringify(instance.events) ||
    Object.values(secrets).some(Boolean) || clearSecrets.size > 0;
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);

  // 只回传"本次要改动的配置"：密钥留空表示保留原值，勾选清除才显式送 null。
  // 把已保存的密钥原样回传既做不到（后端不解密回显），也没必要。
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
    if (busy) return;
    if (!name.trim()) { setError("请填写通知实例名称"); return; }
    const issues = notificationFieldErrors(plugin.fields, config, secrets);
    setFieldErrors(issues);
    if (Object.keys(issues).length) { setError("请检查标红的必填项或无效配置"); return; }
    onBusy(true); onNotice(null); setError("");
    try {
      await api(`/notification-instances/${instance.id}`, { method: "POST", body: JSON.stringify({ name, plugin: instance.plugin, enabled, revision: instance.revision, config: payloadConfig(), events }) });
      onNotice({ type: "ok", text: `${name} 的配置已保存。` });
      // 保存成功后 revision 已经更新；先关弹窗，再刷新列表，避免刷新失败导致用户重复保存。
      onClose();
      void onSaved().catch(() => onNotice({ type: "error", text: "配置已保存，但列表刷新失败，请手动刷新。" }));
    } catch (cause) { setError(reason(cause, "保存失败")); onNotice({ type: "error", text: reason(cause, "保存失败") }); }
    finally { onBusy(false); }
  }

  return <Form layout="vertical" onSubmit={() => void save()}>
    <div className="settings-grid">
      <Form.Item label="实例名称" required>
        <Input value={name} maxLength={120} disabled={busy} onChange={value => { setName(value); setError(""); }} />
      </Form.Item>
      <Form.Item label="启用状态">
        <span className="field-clear">
          <Switch checked={enabled} disabled={busy} onChange={setEnabled} aria-label="启用通知实例" />
          <span>{enabled ? "启用通知实例" : "已停用，不会投递通知"}</span>
        </span>
      </Form.Item>
    </div>
    <ConfigFields
      plugin={plugin}
      config={config}
      disabled={busy}
      secretValues={secrets}
      onSecretChange={(key, value) => { setSecrets(current => ({ ...current, [key]: value })); setFieldErrors(current => { const next = { ...current }; delete next[key]; return next; }); }}
      onChange={(key, value) => { setConfig(current => ({ ...current, [key]: value })); setFieldErrors(current => { const next = { ...current }; delete next[key]; return next; }); }}
      errors={fieldErrors}
      clearSecrets={clearSecrets}
      onClearSecret={(key, clear) => setClearSecrets(current => { const next = new Set(current); if (clear) next.add(key); else next.delete(key); return next; })}
    />
    {clearSecrets.size > 0 && <div className="dialog-warning" role="status">保存将清除 {clearSecrets.size} 项已存储的可选密钥；请检查对应通知插件是否仍能工作。</div>}
    <div className="settings-group-head">
      <div><h3>事件订阅</h3><p>同一个事件可以同时投递到多个通知实例。</p></div>
    </div>
    <EventPicker selected={events} onChange={setEvents} disabled={busy} />
    {error && <div className="error" role="alert">{error}</div>}
    <p className="muted" role="status">{dirty ? "有未保存的修改。" : "当前配置没有修改。"}</p>
    <div className="settings-actions">
      <Button type="primary" htmlType="submit" loading={busy} disabled={!dirty || busy}>{busy ? "保存中…" : dirty ? "保存修改" : "尚无修改"}</Button>
      {/* 停用的实例发不出测试消息，这个禁用条件沿用原来的判断 */}
      <Button disabled={!instance.enabled || busy} onClick={() => void onTest()}>用已保存配置发送测试</Button>
      <RowAction danger disabled={busy} onClick={onRemove}>删除</RowAction>
    </div>
  </Form>;
}

export function OwnerNotificationsPanel() {
  const { data: plugins, loading: pluginsLoading, error: pluginsError } = useApi<Plugin[]>("/notification-plugins");
  const { data: instances, loading, error, reload } = useApi<Instance[]>("/notification-instances");
  const { data: deliveries, loading: deliveriesLoading, error: deliveriesError, reload: reloadDeliveries } = useApi<Delivery[]>("/notification-deliveries", 10000);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ type: "ok" | "error"; text: string } | null>(null);
  const [editor, setEditor] = useState<Instance | null>(null);
  const [editorDirty, setEditorDirty] = useState(false);
  const [confirmDiscardEditor, setConfirmDiscardEditor] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<Instance | null>(null);
  const requestEditorClose = () => {
    if (busy) return;
    if (editorDirty) setConfirmDiscardEditor(true);
    else setEditor(null);
  };

  // 实例筛选：草稿 + 已应用两份状态，点「查询」才生效（输入即过滤在长列表上会明显卡顿）
  const [draftInstance, setDraftInstance] = useState({ plugin: "ALL", keyword: "", status: "ALL" });
  const [appliedInstance, setAppliedInstance] = useState({ plugin: "ALL", keyword: "", status: "ALL" });
  const { sort: instanceSort, onSort: onInstanceSort } = useTableSort<Instance>();
  // 插件列的展示名与排序列用同一份文本，否则用户看到的顺序会和列头语义对不上
  const instanceColumns = useMemo<SortColumn<Instance>[]>(() => [
    { key: "name", label: "实例" },
    { key: "plugin", label: "插件", accessor: row => plugins?.find(plugin => plugin.code === row.plugin)?.name ?? row.plugin },
    { key: "status", label: "状态", accessor: row => row.enabled ? "已启用" : "已停用" },
    { key: "updatedAt", label: "更新时间", type: "date" },
  ], [plugins]);
  const instanceRows = useMemo(() => sortRows((instances ?? []).filter(item => {
    const matchesPlugin = appliedInstance.plugin === "ALL" || item.plugin === appliedInstance.plugin;
    const matchesStatus = appliedInstance.status === "ALL" || (appliedInstance.status === "ENABLED" ? item.enabled : !item.enabled);
    const needle = appliedInstance.keyword.trim().toLowerCase();
    const matchesKeyword = !needle || [item.name, item.id].some(value => value.toLowerCase().includes(needle));
    return matchesPlugin && matchesStatus && matchesKeyword;
  }), instanceColumns, instanceSort), [instances, appliedInstance, instanceColumns, instanceSort]);
  const instancePager = useClientPager(instanceRows, 20);

  const [draftDelivery, setDraftDelivery] = useState({ instance: "ALL", keyword: "", status: "ALL" });
  const [appliedDelivery, setAppliedDelivery] = useState({ instance: "ALL", keyword: "", status: "ALL" });
  const { sort: deliverySort, onSort: onDeliverySort } = useTableSort<Delivery>();
  const deliveryRows = useMemo(() => sortRows((deliveries ?? []).filter(row => {
    const matchesInstance = appliedDelivery.instance === "ALL"
      || (appliedDelivery.instance === "LEGACY" ? !row.instance : row.instance?.id === appliedDelivery.instance);
    const matchesStatus = appliedDelivery.status === "ALL" || row.status === appliedDelivery.status;
    const needle = appliedDelivery.keyword.trim().toLowerCase();
    const matchesKeyword = !needle || [row.title, row.eventType ?? "", row.instance?.name ?? ""].some(value => value.toLowerCase().includes(needle));
    return matchesInstance && matchesStatus && matchesKeyword;
  }), DELIVERY_COLUMNS, deliverySort), [deliveries, appliedDelivery, deliverySort]);
  const deliveryPager = useClientPager(deliveryRows, 20);

  const editorPlugin = editor ? plugins?.find(plugin => plugin.code === editor.plugin) : undefined;
  const pluginOptions = [{ label: "全部插件", value: "ALL" }, ...(plugins ?? []).map(plugin => ({ label: plugin.name, value: plugin.code }))];
  const deliveryInstanceOptions = [
    { label: "全部实例", value: "ALL" },
    ...(instances ?? []).map(item => ({ label: item.name, value: item.id })),
    { label: "旧版渠道（无实例）", value: "LEGACY" },
  ];

  async function testInstance(instance: Instance) {
    setBusy(true); setNotice(null);
    try {
      await api(`/notification-instances/${instance.id}/test`, { method: "POST", body: "{}" });
      setNotice({ type: "ok", text: "测试任务已排队；SUCCESS 才表示上游已接受。" });
      void reloadDeliveries().catch(() => setNotice({ type: "error", text: "测试任务已排队，但投递列表刷新失败，请手动刷新。" }));
    } catch (cause) { setNotice({ type: "error", text: reason(cause, "测试失败") }); }
    finally { setBusy(false); }
  }

  /** 删除实例。返回是否真的删了，调用方据此决定要不要关闭弹窗。 */
  async function removeInstance(instance: Instance): Promise<boolean> {
    if (busy) return false;
    setBusy(true); setNotice(null);
    try {
      await api(`/notification-instances/${instance.id}/delete`, { method: "POST", body: "{}" });
      setNotice({ type: "ok", text: "通知实例已删除或归档。" });
      void reload().catch(() => setNotice({ type: "error", text: "通知实例已删除或归档，但列表刷新失败，请手动刷新。" }));
      return true;
    } catch (cause) { setNotice({ type: "error", text: reason(cause, "删除失败") }); return false; }
    finally { setBusy(false); }
  }

  async function retry(id: string) {
    setBusy(true); setNotice(null);
    try {
      await api(`/notification-deliveries/${id}/retry`, { method: "POST", body: "{}" });
      setNotice({ type: "ok", text: "通知已重新进入待发送队列。" });
      void reloadDeliveries().catch(() => setNotice({ type: "error", text: "通知重试已提交，但投递列表刷新失败，请勿重复重试。" }));
    } catch (cause) { setNotice({ type: "error", text: reason(cause, "重试失败") }); }
    finally { setBusy(false); }
  }

  const instanceTableColumns: ColumnProps<Instance>[] = [
    {
      title: sortHeader(instanceColumns[0], instanceSort, onInstanceSort),
      dataIndex: "name",
      render: (_: unknown, item: Instance) => <span {...sortValueProps(item, instanceColumns[0])}>
        <strong>{item.name}</strong>{item.archivedAt && <span className="tag-archived">已归档</span>}
        <div className="id-line"><span className="mono muted">{item.id}</span><CopyValue value={item.id} label="复制实例 ID" /></div>
      </span>,
    },
    {
      title: sortHeader(instanceColumns[1], instanceSort, onInstanceSort),
      dataIndex: "plugin",
      width: 220,
      render: (_: unknown, item: Instance) => {
        const plugin = plugins?.find(candidate => candidate.code === item.plugin);
        return <span {...sortValueProps(item, instanceColumns[1])}>
          {plugin?.name ?? item.plugin}
          <div className="muted">{plugin ? plugin.description : "插件不可用，无法在此编辑"}</div>
        </span>;
      },
    },
    {
      // 事件订阅是一组多选值，没有单一可比较的排序键，因此不参与排序也不标注 data-sort-value
      title: "事件订阅",
      dataIndex: "events",
      render: (_: unknown, item: Instance) => <div className="muted">{item.events.length ? item.events.map(eventLabel).join("、") : "未订阅事件"}</div>,
    },
    {
      title: sortHeader(instanceColumns[2], instanceSort, onInstanceSort),
      dataIndex: "status",
      width: 110,
      render: (_: unknown, item: Instance) => <span {...sortValueProps(item, instanceColumns[2])}><Status value={item.enabled ? "ACTIVE" : "DISABLED"} /></span>,
    },
    {
      title: sortHeader(instanceColumns[3], instanceSort, onInstanceSort),
      dataIndex: "updatedAt",
      width: 180,
      render: (_: unknown, item: Instance) => <span {...sortValueProps(item, instanceColumns[3])}>{time(item.updatedAt)}</span>,
    },
    {
      title: "操作",
      dataIndex: "actions",
      width: 220,
      render: (_: unknown, item: Instance) => {
        if (item.archivedAt) return <span className="muted">已归档，仅作追溯</span>;
        // 插件缺失（例如插件被下线）时连配置字段都渲染不出来，编辑入口直接禁用更诚实
        const editable = Boolean(plugins?.some(plugin => plugin.code === item.plugin));
        return <div className="row-actions">
          <RowAction disabled={busy || !editable} title={!editable ? "原通知插件已下线，无法编辑配置" : undefined} onClick={() => { setEditorDirty(false); setEditor(item); }}>编辑</RowAction>
          <RowAction disabled={busy || !editable || !item.enabled} title={!editable ? "原通知插件不可用" : !item.enabled ? "请先启用该通知实例" : undefined} onClick={() => void testInstance(item)}>发送测试</RowAction>
          <RowAction danger disabled={busy} onClick={() => setPendingRemove(item)}>删除</RowAction>
        </div>;
      },
    },
  ];

  const deliveryTableColumns: ColumnProps<Delivery>[] = [
    {
      title: sortHeader(DELIVERY_COLUMNS[0], deliverySort, onDeliverySort),
      dataIndex: "createdAt",
      width: 180,
      render: (_: unknown, row: Delivery) => <span {...sortValueProps(row, DELIVERY_COLUMNS[0])}>{time(row.createdAt)}</span>,
    },
    {
      title: sortHeader(DELIVERY_COLUMNS[1], deliverySort, onDeliverySort),
      dataIndex: "instance",
      width: 200,
      render: (_: unknown, row: Delivery) => <span {...sortValueProps(row, DELIVERY_COLUMNS[1])}>
        <strong>{row.instance?.name ?? notificationChannelLabel(row.channel)}</strong>
        <div className="muted">{notificationChannelLabel(row.instance?.plugin ?? row.channel)}</div>
      </span>,
    },
    {
      title: sortHeader(DELIVERY_COLUMNS[2], deliverySort, onDeliverySort),
      dataIndex: "eventType",
      width: 160,
      render: (_: unknown, row: Delivery) => <span {...sortValueProps(row, DELIVERY_COLUMNS[2])}>{eventLabel(row.eventType ?? "—")}</span>,
    },
    {
      title: sortHeader(DELIVERY_COLUMNS[3], deliverySort, onDeliverySort),
      dataIndex: "title",
      render: (_: unknown, row: Delivery) => <span {...sortValueProps(row, DELIVERY_COLUMNS[3])}>{row.title}</span>,
    },
    {
      title: sortHeader(DELIVERY_COLUMNS[4], deliverySort, onDeliverySort),
      dataIndex: "status",
      width: 120,
      render: (_: unknown, row: Delivery) => <span {...sortValueProps(row, DELIVERY_COLUMNS[4])}>
        {/* 失败原因默认收起，悬浮或聚焦徽章才展开 —— 与订单、通道列表保持同一套交互 */}
        <HoverDetail text={row.lastError} tone="danger"><Status value={row.status} /></HoverDetail>
      </span>,
    },
    {
      title: sortHeader(DELIVERY_COLUMNS[5], deliverySort, onDeliverySort),
      dataIndex: "attempts",
      width: 90,
      align: "right",
      render: (_: unknown, row: Delivery) => <span {...sortValueProps(row, DELIVERY_COLUMNS[5])}>{row.attempts}</span>,
    },
    {
      title: "操作",
      dataIndex: "actions",
      width: 90,
      render: (_: unknown, row: Delivery) => row.status === "DEAD" && row.instance
        ? <RowAction disabled={busy} onClick={() => void retry(row.id)}>重试</RowAction>
        : null,
    },
  ];

  return <>
    {notice && <Toast type={notice.type} text={notice.text} onClose={() => setNotice(null)} />}
    {confirmDiscardEditor && <ConfirmModal title="放弃通知实例的配置修改？" copy="未保存的插件字段、密钥输入和事件订阅将丢失。" danger confirmLabel="放弃修改" onClose={() => setConfirmDiscardEditor(false)} onConfirm={() => { setConfirmDiscardEditor(false); setEditorDirty(false); setEditor(null); }} />}
    {pendingRemove && <ConfirmModal title={`删除通知实例 · ${pendingRemove.name}`} copy="有历史通知投递时将归档该实例并停止尚未发送的任务；新通知将不再投递到它。" warning="如果只是临时停止通知，建议在编辑表单中选择停用，而不是删除。" danger confirmLabel="确认删除实例" working={busy} onClose={() => { if (!busy) setPendingRemove(null); }} onConfirm={() => void removeInstance(pendingRemove).then(ok => { if (ok) { if (editor?.id === pendingRemove.id) { setEditor(null); setEditorDirty(false); } setPendingRemove(null); } })} />}

    {/* 一、插件选择与创建：仍然是 ListCard，但控件全部换成 Arco（Select / Input / Switch / Checkbox.Group） */}
    <ListPage>
      <ListCard toolbar={<><strong>通知插件</strong><ToolbarNote>业务 Webhook 不在这里配置</ToolbarNote></>}>
        <LoadingState loading={pluginsLoading} error={pluginsError} stale={Boolean(plugins)} empty={!plugins?.length} emptyText="没有可用的通知插件">
          <CreateInstancePanel
            plugins={plugins ?? []}
            busy={busy}
            onBusy={setBusy}
            onNotice={setNotice}
            onCreated={async () => { await reload(); }}
          />
        </LoadingState>
      </ListCard>
    </ListPage>

    {/* ListPage 是一张卡：相邻两张卡之间没有现成的间距规则（admin.css 已冻结），
        因此这里显式给后续两张卡补上外边距，避免三张卡贴在一起。 */}
    <div>
      <ListPage>
        <FilterCard
          onSearch={() => setAppliedInstance(draftInstance)}
          onReset={() => { const empty = { plugin: "ALL", keyword: "", status: "ALL" }; setDraftInstance(empty); setAppliedInstance(empty); }}
        >
          <FilterItem label="插件"><FilterSelect value={draftInstance.plugin} onChange={plugin => setDraftInstance(current => ({ ...current, plugin }))} options={pluginOptions} /></FilterItem>
          <FilterItem label="关键字"><FilterInput value={draftInstance.keyword} onChange={keyword => setDraftInstance(current => ({ ...current, keyword }))} placeholder="实例名称 / 实例 ID" /></FilterItem>
          <FilterItem label="状态"><FilterSelect value={draftInstance.status} onChange={status => setDraftInstance(current => ({ ...current, status }))} options={INSTANCE_STATUS_OPTIONS} /></FilterItem>
        </FilterCard>
        <LoadingState loading={loading} error={error} stale={Boolean(instances)} empty={!instances?.length} emptyText="还没有通知实例；先从上方选择一个插件创建">
          <ListCard
            toolbar={<>
              <strong>通知实例</strong>
              <ToolbarNote>共 {instanceRows.length} 个</ToolbarNote>
              <ToolbarSpacer />
              <Button size="small" disabled={busy} onClick={() => void reload()}>刷新</Button>
            </>}
            pagination={<Pager total={instancePager.total} page={instancePager.page} pageSize={instancePager.pageSize} onChange={instancePager.setPage} onPageSizeChange={instancePager.setPageSize} />}
          >
            <Table<Instance>
              className="list-table"
              columns={instanceTableColumns}
              data={instancePager.rows}
              rowKey="id"
              pagination={false}
              borderCell={false}
              loading={false}
              rowClassName={item => item.archivedAt ? "row-archived" : ""}
              noDataElement={<div className="empty compact">没有符合筛选条件的通知实例</div>}
            />
          </ListCard>
        </LoadingState>
      </ListPage>
    </div>

    <div>
      <ListPage>
        <FilterCard
          onSearch={() => setAppliedDelivery(draftDelivery)}
          onReset={() => { const empty = { instance: "ALL", keyword: "", status: "ALL" }; setDraftDelivery(empty); setAppliedDelivery(empty); }}
        >
          <FilterItem label="实例"><FilterSelect value={draftDelivery.instance} onChange={instance => setDraftDelivery(current => ({ ...current, instance }))} options={deliveryInstanceOptions} /></FilterItem>
          <FilterItem label="状态"><FilterSelect value={draftDelivery.status} onChange={status => setDraftDelivery(current => ({ ...current, status }))} options={DELIVERY_STATUS_OPTIONS} /></FilterItem>
          <FilterItem label="关键字"><FilterInput value={draftDelivery.keyword} onChange={keyword => setDraftDelivery(current => ({ ...current, keyword }))} placeholder="标题 / 事件 / 实例" /></FilterItem>
        </FilterCard>
        <LoadingState loading={deliveriesLoading} error={deliveriesError} stale={Boolean(deliveries)} empty={!deliveries?.length} emptyText="还没有通知投递记录">
          <ListCard
            toolbar={<>
              <strong>通知投递</strong>
              <ToolbarNote>共 {deliveryRows.length} 条 · 接口固定返回最近 50 条 · 自动刷新</ToolbarNote>
              <ToolbarSpacer />
              <Button size="small" onClick={() => void reloadDeliveries()}>刷新</Button>
            </>}
            pagination={<Pager total={deliveryPager.total} page={deliveryPager.page} pageSize={deliveryPager.pageSize} onChange={deliveryPager.setPage} onPageSizeChange={deliveryPager.setPageSize} />}
          >
            <Table<Delivery>
              className="list-table"
              columns={deliveryTableColumns}
              data={deliveryPager.rows}
              rowKey="id"
              pagination={false}
              borderCell={false}
              loading={false}
              noDataElement={<div className="empty compact">没有符合筛选条件的投递记录</div>}
            />
          </ListCard>
        </LoadingState>
      </ListPage>
    </div>

    {/* 实例编辑放在弹窗里：表格负责"看"，改动集中在一处提交，和应用的编辑入口保持一致 */}
    {editor && editorPlugin && <Modal
      className="app-modal"
      title={`编辑通知实例 · ${editor.name}`}
      visible
      onCancel={requestEditorClose}
      footer={null}
      closable={!busy}
      maskClosable={!busy}
      escToExit={!busy}
      autoFocus
      focusLock
      alignCenter
      unmountOnExit
    >
      <InstanceEditor
        key={editor.id}
        instance={editor}
        plugin={editorPlugin}
        busy={busy}
        onBusy={setBusy}
        onDirtyChange={setEditorDirty}
        onNotice={setNotice}
        onSaved={async () => { await reload(); }}
        onTest={() => testInstance(editor)}
        onRemove={() => setPendingRemove(editor)}
        onClose={() => { setEditor(null); setEditorDirty(false); }}
      />
    </Modal>}
  </>;
}
