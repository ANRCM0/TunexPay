"use client";

import { Button, Form, Input, Modal, Select, Switch, Table } from "@arco-design/web-react";
import type { ColumnProps } from "@arco-design/web-react/es/Table";
import { useMemo, useState } from "react";
import { api, useApi } from "../lib/api";
import { sortRows, type SortColumn } from "../lib/sort";
import { ConfirmModal, CopyValue, LoadingState, PageHead, Status, Toast, sortValueProps, time , RowAction } from "./common";
import { assignable, type Channel } from "./channels";
import { applicationRoutingTarget, assignPaymentRouting, routingCreateInput } from "./routing-target";
import { canAssignGroup, routingStrategyLabels, type RoutingGroup } from "../lib/routing-groups";
import { FilterCard, FilterInput, FilterItem, FilterSelect, ListCard, ListPage, Pager, ToolbarNote, ToolbarSpacer, sortHeader, useClientPager, useTableSort } from "./list";

type Counts = { orders: number; refunds: number; webhookDeliveries: number };
type Application = {
  id: string; appId: string; epayPid: string; name: string; status: string; webhookUrl: string | null;
  defaultChannel: string; defaultChannelId: string | null; routingGroupId: string | null;
  routingGroup: { id: string; name: string; enabled: boolean } | null; archivedAt: string | null; pausedAt: string | null;
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

const SORT_COLUMNS: SortColumn<Application>[] = [
  { key: "name", label: "应用" },
  { key: "appId", label: "App ID / ePay PID" },
  // 路由列显示的是"路由组名或默认通道名"，排序用同一份展示文本
  { key: "route", label: "收款路由", accessor: (row) => row.routingGroup?.name ?? row.defaultChannel },
  { key: "webhookUrl", label: "Webhook", accessor: (row) => row.webhookUrl ?? "" },
  { key: "status", label: "状态" },
  { key: "createdAt", label: "创建时间", type: "date" },
];

const STATUS_OPTIONS = [
  { label: "全部状态", value: "ALL" },
  { label: "启用", value: "ACTIVE" },
  { label: "停用", value: "DISABLED" },
];

/** 路由下拉的一项。取值前缀（group: / channel:）与 routing-target.tsx 保持一致，避免组 ID 与通道 ID 混淆。 */
type RoutingOption = { label: string; value: string; disabled?: boolean };

/**
 * 把轮询组与单通道拼成 Arco Select 的选项。
 *
 * 为什么在这里而不是改 routing-target.tsx：那个文件（及它的测试）描述的是"原生 select"的契约，
 * 不在本次迁移范围内；这里只是把同一套规则（前缀取值、可用性判定、原绑定占位）搬到 Arco Select 上，
 * 保证「哪些能选、哪些置灰」与通道页的分配入口完全一致。
 */
function routingOptions(groups: RoutingGroup[], channels: Channel[], currentTarget = ""): RoutingOption[] {
  const options: RoutingOption[] = [{ label: "未绑定收款路由", value: "" }];
  const found = !currentTarget
    || groups.some(group => `group:${group.id}` === currentTarget)
    || channels.some(channel => `channel:${channel.id}` === currentTarget);
  // 当前绑定指向已删除/未启用的目标时，保留一个显式选项，避免用户以为路由被悄悄清空了
  if (!found) options.push({ label: "原收款路由（不可用或待加载）", value: currentTarget, disabled: true });
  for (const group of groups) {
    options.push({
      label: `${group.name} · ${routingStrategyLabels[group.strategy]} · ${group.availableChannels} 个可用${group.enabled ? "" : " · 已停用"}`,
      value: `group:${group.id}`,
      disabled: !canAssignGroup(group),
    });
  }
  for (const channel of channels) {
    options.push({
      label: `${channel.name}${channel.enabled ? "" : " · 已停用"}`,
      value: `channel:${channel.id}`,
      disabled: !!channel.archivedAt || !channel.enabled || !["API_VERIFIED", "PAYMENT_VERIFIED", "SIMULATED"].includes(channel.checkStatus),
    });
  }
  return options;
}

export function Applications() {
  // 排序状态统一走共享层，三态循环与列头提示文案由 list.tsx 提供
  const { sort, onSort } = useTableSort<Application>();
  const [showArchived, setShowArchived] = useState(false);
  const { data, loading, error, reload } = useApi<Application[]>(`/applications${showArchived ? "?includeArchived=true" : ""}`);
  const channels = useApi<Channel[]>("/channel-instances");
  const groups = useApi<RoutingGroup[]>("/routing-groups");

  // 筛选是「草稿 + 已应用」两份状态：输入过程中每敲一个字都重算整张表在长列表上会明显卡顿，
  // 点「查询」才把草稿提交为生效条件；「重置」同时清空两者。
  const [draftKeyword, setDraftKeyword] = useState("");
  const [draftStatus, setDraftStatus] = useState("ALL");
  const [applied, setApplied] = useState({ keyword: "", status: "ALL" });

  const filtered = useMemo(() => (data ?? []).filter(item => {
    const matchesStatus = applied.status === "ALL" || item.status === applied.status;
    const needle = applied.keyword.trim().toLowerCase();
    const matchesKeyword = !needle || [item.name, item.appId, item.epayPid, item.webhookUrl ?? ""]
      .some(value => value.toLowerCase().includes(needle));
    return matchesStatus && matchesKeyword;
  }), [data, applied]);
  // 先筛选再排序：排序只作用于用户当前关心的子集（是否包含归档由 showArchived 决定服务端返回范围）
  const rows = useMemo(() => sortRows(filtered, SORT_COLUMNS, sort), [filtered, sort]);
  const pager = useClientPager(rows, 20);

  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ name: "", webhookUrl: "", routingTarget: "" });
  const [credentials, setCredentials] = useState<CreatedCredentials | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [editing, setEditing] = useState<Application | null>(null);
  const [editTarget, setEditTarget] = useState("");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<{ type: "ok" | "error"; text: string } | null>(null);
  const [rotating, setRotating] = useState<Application | null>(null);
  const [rotated, setRotated] = useState<RotatedCredentials | null>(null);
  const [removing, setRemoving] = useState<Application | null>(null);
  const [confirmName, setConfirmName] = useState("");
  const [removeError, setRemoveError] = useState("");
  const [removed, setRemoved] = useState<DeleteResult | null>(null);
  const [confirmDiscardCreate, setConfirmDiscardCreate] = useState(false);
  const [pendingDisable, setPendingDisable] = useState<Application | null>(null);

  const routingDisabled = groups.loading || channels.loading || !!groups.error || !!channels.error;
  const routingOptionsForCreate = useMemo(() => routingOptions(groups.data ?? [], channels.data ?? []).filter(option => option.value !== ""), [groups.data, channels.data]);

  function openCreate() {
    setDraft({ name: "", webhookUrl: "", routingTarget: "" });
    setFormError(""); setCredentials(null);
    setCreating(true);
  }

  const draftCreateDirty = Boolean(draft.name.trim() || draft.webhookUrl.trim() || draft.routingTarget);
  function closeCreate() {
    if (saving) return;
    if (!credentials && draftCreateDirty) { setConfirmDiscardCreate(true); return; }
    setCreating(false); setCredentials(null); setFormError("");
  }
  function discardCreate() {
    setConfirmDiscardCreate(false);
    setDraft({ name: "", webhookUrl: "", routingTarget: "" });
    setCreating(false); setCredentials(null); setFormError("");
  }

  function openEdit(application: Application) {
    setNotice(null);
    setEditTarget(applicationRoutingTarget(application));
    setEditing(application);
  }

  async function submitCreate() {
    // 名称与路由是创建时的必填项：原生表单靠 required 拦住，换成受控控件后在这里显式校验
    if (!draft.name.trim()) { setFormError("请填写应用名称"); return; }
    if (!draft.routingTarget) { setFormError("请选择收款路由（轮询组或单通道）"); return; }
    setSaving(true); setFormError(""); setCredentials(null);
    try {
      const response = await api<{ data: { credentials: CreatedCredentials } }>("/applications", {
        method: "POST",
        body: JSON.stringify({ name: draft.name, webhookUrl: draft.webhookUrl, ...routingCreateInput(draft.routingTarget) }),
      });
      setCredentials(response.data.credentials);
      setDraft({ name: "", webhookUrl: "", routingTarget: "" });
      try { await reload(); }
      catch { setFormError("应用创建成功，但列表刷新失败。请先保存已显示的凭证，不要重复创建。"); }
    } catch (cause) { setFormError(reason(cause, "创建失败")); }
    finally { setSaving(false); }
  }

  /** 改收款路由。返回是否成功，调用方据此决定要不要关闭弹窗。 */
  async function assignRouting(application: Application, target: string): Promise<boolean> {
    setBusy(application.id); setNotice(null);
    try {
      await assignPaymentRouting(application.id, target);
      setNotice({ type: "ok", text: target ? `「${application.name}」收款路由已更新，仅影响新支付。` : `「${application.name}」已解除收款绑定，无法发起新支付。` });
      await reload(); await groups.reload();
      return true;
    } catch (cause) { setNotice({ type: "error", text: reason(cause, "收款路由分配失败") }); return false; }
    finally { setBusy(""); }
  }

  async function submitEdit() {
    if (!editing) return;
    if (editTarget === applicationRoutingTarget(editing)) { setEditing(null); return; }
    // 路由没有变化就不打接口：这也让「打开弹窗后直接保存」变成一次无副作用的关闭
    if (await assignRouting(editing, editTarget)) setEditing(null);
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

  async function setStatus(application: Application, next: "ACTIVE" | "DISABLED") {
    setBusy(application.id); setNotice(null);
    try {
      await api(`/applications/${application.id}/status`, { method: "POST", body: JSON.stringify({ status: next }) });
      setNotice({ type: "ok", text: next === "DISABLED" ? `「${application.name}」已停用。` : `「${application.name}」已启用。` });
      await reload();
      return true;
    } catch (cause) {
      setNotice({ type: "error", text: reason(cause, next === "DISABLED" ? "停用失败" : "启用失败") });
      return false;
    } finally { setBusy(""); }
  }

  async function toggleStatus(application: Application) {
    if (application.status === "ACTIVE") {
      setPendingDisable(application);
      return;
    }
    await setStatus(application, "ACTIVE");
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

  const columns: ColumnProps<Application>[] = [
    {
      title: sortHeader(SORT_COLUMNS[0], sort, onSort),
      dataIndex: "name",
      render: (_: unknown, item: Application) => <span {...sortValueProps(item, SORT_COLUMNS[0])}>
        <strong>{item.name}</strong>{item.archivedAt && <span className="tag-archived">已归档</span>}
        {item.archivedAt && <div className="muted">已于 {time(item.archivedAt)} 归档</div>}
        {/* 业务数据说明放这里而不是操作列：操作列里四个动作已经占满宽度，再加一行文字会把它们挤成竖排 */}
        <div className="muted">{businessTotal(item._count) > 0 ? businessSummary(item._count) : "尚无业务数据"}</div>
      </span>,
    },
    {
      title: sortHeader(SORT_COLUMNS[1], sort, onSort),
      dataIndex: "appId",
      width: 220,
      render: (_: unknown, item: Application) => <span {...sortValueProps(item, SORT_COLUMNS[1])}>
        <div className="id-line"><span className="mono">{item.appId}</span><CopyValue value={item.appId} label="复制 App ID" /></div>
        <div className="id-line"><span className="mono muted">PID {item.epayPid}</span><CopyValue value={item.epayPid} label="复制 ePay PID" /></div>
      </span>,
    },
    {
      title: sortHeader(SORT_COLUMNS[2], sort, onSort),
      dataIndex: "route",
      width: 260,
      // 改收款路由是这一行最常用的操作，保留列表内联下拉：走「编辑」弹窗要三次点击，
      // 而绑定组/通道本来就是一次选择就能生效的动作。弹窗里同样保留这个入口。
      render: (_: unknown, item: Application) => {
        const current = applicationRoutingTarget(item);
        return <span {...sortValueProps(item, SORT_COLUMNS[2])}>
          <Select
            className="routing-binding"
            size="small"
            value={current}
            options={routingOptions(groups.data ?? [], channels.data ?? [], current)}
            disabled={busy !== "" || Boolean(item.archivedAt)}
            onChange={(value: string) => void assignRouting(item, value)}
            aria-label={`「${item.name}」的收款路由`}
          />
          {item.routingGroupId && !item.archivedAt && <div className="muted">轮询组 · 仅新支付按组内规则选路</div>}
        </span>;
      },
    },
    {
      title: sortHeader(SORT_COLUMNS[3], sort, onSort),
      dataIndex: "webhookUrl",
      width: 220,
      render: (_: unknown, item: Application) => <span {...sortValueProps(item, SORT_COLUMNS[3])}>{
        item.webhookUrl
          ? <div className="id-line"><span className="mono break-all">{item.webhookUrl}</span><CopyValue value={item.webhookUrl} label="复制 Webhook 地址" /></div>
          : "—"
      }</span>,
    },
    {
      title: sortHeader(SORT_COLUMNS[4], sort, onSort),
      dataIndex: "status",
      width: 110,
      render: (_: unknown, item: Application) => <span {...sortValueProps(item, SORT_COLUMNS[4])}><Status value={item.status} /></span>,
    },
    {
      title: sortHeader(SORT_COLUMNS[5], sort, onSort),
      dataIndex: "createdAt",
      width: 160,
      render: (_: unknown, item: Application) => <span {...sortValueProps(item, SORT_COLUMNS[5])}>{time(item.createdAt)}</span>,
    },
    {
      title: "操作",
      dataIndex: "actions",
      width: 250,
      render: (_: unknown, item: Application) => item.archivedAt
        ? <span className="muted">已归档，仅作追溯</span>
        : <>
          <div className="row-actions">
            <RowAction disabled={busy !== ""} onClick={() => openEdit(item)}>编辑</RowAction>
            <RowAction disabled={busy !== ""} onClick={() => { setRotated(null); setRotating(item); }}>重置凭证</RowAction>
            <RowAction disabled={busy !== ""} busy={busy === item.id} onClick={() => void toggleStatus(item)}>{busy === item.id ? "处理中…" : item.status === "ACTIVE" ? "停用" : "启用"}</RowAction>
            <RowAction danger disabled={busy !== ""} title="删除该应用" onClick={() => { setConfirmName(""); setRemoveError(""); setRemoved(null); setRemoving(item); }}>删除</RowAction>
          </div>
        </>,
    },
  ];

  return <>
    <PageHead
      eyebrow="Applications"
      title="业务应用"
      copy="每个自有业务使用独立 API Key、Webhook 密钥和 ePay 凭证；凭证可随时重置，不再使用的应用可停用或删除。"
      action={<div className="page-head-actions"><Button type="primary" onClick={openCreate}>新建应用</Button></div>}
    />
    {notice && <Toast type={notice.type} text={notice.text} onClose={() => setNotice(null)} />}
    <ListPage>
      <FilterCard
        onSearch={() => setApplied({ keyword: draftKeyword, status: draftStatus })}
        onReset={() => { setDraftKeyword(""); setDraftStatus("ALL"); setApplied({ keyword: "", status: "ALL" }); }}
      >
        <FilterItem label="关键字">
          <FilterInput value={draftKeyword} onChange={setDraftKeyword} placeholder="应用名称 / App ID / ePay PID / Webhook" />
        </FilterItem>
        <FilterItem label="状态">
          <FilterSelect value={draftStatus} onChange={setDraftStatus} options={STATUS_OPTIONS} />
        </FilterItem>
      </FilterCard>
      <LoadingState loading={loading} error={error} stale={Boolean(data)} empty={!data?.length} emptyText={showArchived ? "没有可显示的应用记录" : "还没有业务应用，点击右上角「新建应用」创建一个"}>
        <ListCard
          toolbar={<>
            <ToolbarNote>共 {rows.length} 个应用</ToolbarNote>
            <ToolbarSpacer />
            <span className="muted">显示已归档</span>
            {/* 它同时是接口参数（includeArchived），切换即重新拉取，因此不进草稿/已应用那一套 */}
            <Switch size="small" checked={showArchived} onChange={setShowArchived} />
            <Button size="small" onClick={() => void reload()}>刷新</Button>
          </>}
          pagination={<Pager total={pager.total} page={pager.page} pageSize={pager.pageSize} onChange={pager.setPage} onPageSizeChange={pager.setPageSize} />}
        >
          <Table<Application>
            className="list-table"
            columns={columns}
            data={pager.rows}
            rowKey="id"
            pagination={false}
            borderCell={false}
            loading={false}
            rowClassName={item => item.archivedAt ? "row-archived" : ""}
            noDataElement={<div className="empty compact">没有符合筛选条件的应用</div>}
          />
        </ListCard>
      </LoadingState>
    </ListPage>

    {/* 新建/编辑表单放在弹窗里，列表页因此只保留「查询 + 表格 + 分页」一张卡。
        凭证只显示一次：展示期间不允许点遮罩或按 Esc 顺手关掉，必须走「我已保存，关闭」。 */}
    {confirmDiscardCreate && <ConfirmModal title="放弃新建应用？" copy="应用名称、Webhook 地址和所选收款路由尚未保存。关闭后这些输入将丢失。" danger confirmLabel="放弃填写" onClose={() => setConfirmDiscardCreate(false)} onConfirm={discardCreate} />}
    {creating && <Modal
      className="app-modal"
      title={credentials ? "创建成功：请立即保存凭证" : "新建应用"}
      visible
      onCancel={closeCreate}
      footer={null}
      closable={!credentials && !saving}
      maskClosable={!credentials && !saving}
      escToExit={!credentials && !saving}
      autoFocus
      focusLock
      alignCenter
      unmountOnExit
    >
      {credentials ? <>
        <p className="muted">凭证只显示一次，关闭后无法再次查看；请把 API Key、Webhook Secret 与 ePay 凭证同步到业务侧配置。</p>
        {formError && <div className="operation-notice error" role="alert">{formError}</div>}
        <CredentialBlock title="请立即保存以下凭证。" items={[
          ["API Key", credentials.apiKey], ["Webhook Secret", credentials.webhookSecret], ["ePay PID", credentials.epayPid], ["ePay Key", credentials.epayKey],
        ]} />
        <div className="dialog-actions"><Button type="primary" onClick={closeCreate}>我已保存，关闭</Button></div>
      </> : <>
        <Form layout="vertical" onSubmit={() => void submitCreate()}>
          <Form.Item label="应用名称" required>
            <Input value={draft.name} onChange={value => setDraft(current => ({ ...current, name: value }))} placeholder="TUOXIN Matrix" maxLength={120} />
          </Form.Item>
          <Form.Item label="Webhook 地址">
            <Input value={draft.webhookUrl} onChange={value => setDraft(current => ({ ...current, webhookUrl: value }))} placeholder="https://example.com/webhook" />
          </Form.Item>
          <Form.Item label="收款路由" required>
            <Select
              value={draft.routingTarget || undefined}
              onChange={value => setDraft(current => ({ ...current, routingTarget: String(value ?? "") }))}
              options={routingOptionsForCreate}
              placeholder={routingDisabled ? "通道或轮询组尚未就绪" : "选择轮询组或单通道"}
              disabled={routingDisabled || routingOptionsForCreate.length === 0}
            />
          </Form.Item>
          {formError && <div className="error">{formError}</div>}
          {channels.error && <div className="error">{channels.error}</div>}
          {groups.error && <div className="error">{groups.error}</div>}
          {!channels.loading && !groups.loading && !channels.data?.some(assignable) && !groups.data?.some(canAssignGroup) && <p className="muted">请先配置、启用并检测收款通道，再创建轮询组。也可以保留单通道绑定。</p>}
          <div className="dialog-actions">
            <Button type="primary" htmlType="submit" loading={saving}>{saving ? "创建中…" : "创建应用"}</Button>
            <Button disabled={saving} onClick={closeCreate}>取消</Button>
          </div>
        </Form>
      </>}
    </Modal>}

    {/* 编辑：名称与 Webhook 由后端创建后即固定（没有对应的修改接口），所以这里只读展示，
        真正可改的是收款路由 —— 它本来就是这一行唯一能在列表里改的字段。 */}
    {editing && <Modal
      className="app-modal"
      title={`编辑应用 · ${editing.name}`}
      visible
      onCancel={() => setEditing(null)}
      footer={null}
      closable={busy !== editing.id}
      maskClosable={busy !== editing.id}
      escToExit={busy !== editing.id}
      autoFocus
      focusLock
      alignCenter
      unmountOnExit
    >
      <Form layout="vertical">
        <Form.Item label="收款路由">
          <Select
            value={editTarget}
            onChange={value => setEditTarget(String(value ?? ""))}
            options={routingOptions(groups.data ?? [], channels.data ?? [], applicationRoutingTarget(editing))}
            placeholder="选择轮询组或单通道"
            disabled={routingDisabled}
          />
        </Form.Item>
      </Form>
      <p className="muted">改为「未绑定收款路由」会解除绑定，之后该应用无法发起新支付；轮询组仅影响新支付的选路。</p>
      <div className="detail-list">
        <div className="detail-row"><span>应用名称</span><strong>{editing.name}</strong></div>
        <div className="detail-row"><span>App ID</span><strong className="mono">{editing.appId}</strong></div>
        <div className="detail-row"><span>ePay PID</span><strong className="mono">{editing.epayPid}</strong></div>
        <div className="detail-row"><span>Webhook</span><strong className="mono break-all">{editing.webhookUrl ?? "—"}</strong></div>
      </div>
      <div className="dialog-actions">
        <Button type="primary" loading={busy === editing.id} disabled={routingDisabled || busy !== ""} onClick={() => void submitEdit()}>{busy === editing.id ? "保存中…" : "保存"}</Button>
        <Button disabled={busy === editing.id} onClick={() => setEditing(null)}>取消</Button>
      </div>
    </Modal>}

    {pendingDisable && <ConfirmModal
      title="停用业务应用"
      copy={`停用「${pendingDisable.name}」后，该应用不能再创建新订单；已经存在的订单、退款和通知投递仍会继续处理。`}
      confirmLabel="确认停用"
      danger
      warning="停用会立即阻止该应用创建新订单；如果只是临时维护，请确认业务侧已做好相应处理。"
      working={busy === pendingDisable.id}
      onClose={() => setPendingDisable(null)}
      onConfirm={() => void setStatus(pendingDisable, "DISABLED").then(ok => { if (ok) setPendingDisable(null); })}
    />}

    {/* 重置凭证沿用原来的可关闭规则：展示新凭证或正在重置时，遮罩 / Esc / 关闭按钮都不可用 */}
    {rotating && <Modal title={rotated ? "新凭证（仅显示一次）" : "重置应用凭证"} visible onCancel={closeRotate} footer={null} closable={!rotated && busy !== rotating.id} maskClosable={!rotated && busy !== rotating.id} escToExit={!rotated && busy !== rotating.id} autoFocus focusLock alignCenter unmountOnExit>
      {rotated ? <>
        <p className="muted">旧凭证已立即失效，请把新凭证更新到业务侧配置。离开本窗口后无法再次查看。</p>
        <CredentialBlock title="请立即保存以下凭证。" items={[
          ["API Key", rotated.apiKey], ["Webhook Secret", rotated.webhookSecret], ["ePay Key", rotated.epayKey],
        ]} />
        <p className="muted">ePay PID 未变更：它是商户标识而不是密钥；本次轮换只会让旧 ePay Key 失效。</p>
        <div className="dialog-actions"><Button type="primary" onClick={closeRotate}>我已保存，关闭</Button></div>
      </> : <>
        <p>即将重置「<strong>{rotating.name}</strong>」的三项凭证：接口鉴权 API Key、回调验签 Webhook Secret、ePay 商户密钥。</p>
        <ul className="dialog-list">
          <li>重置后旧凭证立即失效：业务侧未同步新凭证期间，新订单接口与回调验签都会失败。</li>
          <li>已存在的订单、退款与通知投递不受影响，仍按原流程继续处理。</li>
          <li>本次操作会记入管理操作审计。</li>
        </ul>
        {busy === rotating.id && <p className="muted">正在重置…</p>}
        <div className="dialog-actions">
          <Button status="danger" disabled={busy !== ""} onClick={() => void rotate(rotating)}>确认重置</Button>
          <Button disabled={busy !== ""} onClick={closeRotate}>取消</Button>
        </div>
      </>}
    </Modal>}

    {/* 删除弹窗保持原来「随时可关闭」的手感（遮罩 / Esc / 关闭按钮都保留默认值） */}
    {removing && <Modal title="删除应用" visible onCancel={() => { if (busy !== removing.id) closeRemove(); }} closable={busy !== removing.id} maskClosable={busy !== removing.id} escToExit={busy !== removing.id} footer={null} autoFocus focusLock alignCenter unmountOnExit>
      {removed ? <>
        <p>应用「<strong>{removed.name}</strong>」已删除。</p>
        {removeError && <div className="operation-notice error" role="alert">{removeError}</div>}
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
        <div className="dialog-actions"><Button type="primary" onClick={closeRemove}>知道了</Button></div>
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
        <Form layout="vertical">
          <Form.Item label="输入应用名称以确认">
            <Input value={confirmName} onChange={setConfirmName} placeholder={removing.name} autoComplete="off" />
          </Form.Item>
        </Form>
        {removeError && <div className="error">{removeError}</div>}
        <div className="dialog-actions">
          <Button status="danger" loading={busy === removing.id} disabled={busy !== "" || confirmName.trim() !== removing.name} onClick={() => void remove(removing)}>{busy === removing.id ? "删除中…" : "确认删除"}</Button>
          <Button disabled={busy === removing.id} onClick={closeRemove}>取消</Button>
        </div>
      </>}
    </Modal>}
  </>;
}

/**
 * 凭证展示块。
 *
 * credentials / credentials-grid / credential-secret / copy-value 都是既有类名：
 * warning 底色提示"只显示一次"，其中的复制按钮会带上可见文字（`.credentials .copy-value span`）。
 */
function CredentialBlock({ title, items }: { title: string; items: Array<[string, string]> }) {
  return <div className="credentials"><strong>{title}</strong><div className="credentials-grid">
    {items.map(([label, value]) => <div className="credential-secret" key={label}>
      <span className="muted">{label}</span>
      <span className="id-line"><code>{value}</code><CopyValue value={value} label={`复制${label}`} /></span>
    </div>)}
  </div></div>;
}
