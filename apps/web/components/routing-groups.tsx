"use client";
import { Button, Checkbox, Form, Input, InputNumber, Select, Switch, Table } from "@arco-design/web-react";
import type { ColumnProps } from "@arco-design/web-react/es/Table";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { api, useApi } from "../lib/api";
import { channelLabel } from "../lib/labels";
import { routingStrategyLabels, type RoutingGroup, type RoutingStrategy } from "../lib/routing-groups";
import { sortRows, type SortColumn } from "../lib/sort";
import { checkLabels, type Channel } from "./channels";
import { ConfirmModal, LoadingState, Modal, PageHead, Status, Toast, sortValueProps } from "./common";
import { FilterCard, FilterInput, FilterItem, FilterSelect, ListCard, ListPage, Pager, ToolbarNote, ToolbarSpacer, sortHeader, useClientPager, useTableSort } from "./list";

type MemberInput = { channelId: string; weight: number; enabled: boolean };

const SORT_COLUMNS: SortColumn<RoutingGroup>[] = [
  { key: "name", label: "轮询组" },
  { key: "strategy", label: "选路规则" },
  // 单元格显示"可用 / 总数"，排序取可用数（能不能真正承载流量）
  { key: "availableChannels", label: "成员通道", type: "number" },
  { key: "enabled", label: "状态", accessor: (row) => (row.enabled ? 1 : 0), type: "number" },
  { key: "applicationCount", label: "绑定应用", type: "number" },
];

const STRATEGY_OPTIONS = (Object.keys(routingStrategyLabels) as RoutingStrategy[]).map(value => ({ label: routingStrategyLabels[value], value }));
const ENABLED_OPTIONS = [
  { label: "全部", value: "ALL" },
  { label: "仅启用", value: "ON" },
  { label: "仅停用", value: "OFF" },
];

// 权重是提交给后端的整数，编辑期允许为空/越界，但保存前必须拦住——
// 原来是靠原生 number 输入的 min/max 校验，换成 Arco 控件后需要显式说清楚。
const WEIGHT_MIN = 1;
const WEIGHT_MAX = 10000;

export function RoutingGroups() {
  const groups = useApi<RoutingGroup[]>("/routing-groups", 10_000);
  const channels = useApi<Channel[]>("/channel-instances", 10_000);
  const { sort, onSort } = useTableSort<RoutingGroup>();
  const [draft, setDraft] = useState({ query: "", strategy: "ALL", enabled: "ALL" });
  const [applied, setApplied] = useState({ query: "", strategy: "ALL", enabled: "ALL" });
  const [editing, setEditing] = useState<RoutingGroup | "new" | null>(null);
  const [removing, setRemoving] = useState<RoutingGroup | null>(null);
  const [busy, setBusy] = useState(false);
  const [editorDirty, setEditorDirty] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const requestCloseEditor = () => {
    if (busy) return;
    if (editorDirty) setConfirmDiscard(true);
    else setEditing(null);
  };
  const startEditing = (item: RoutingGroup | "new") => { setEditorDirty(false); setEditing(item); };
  const [notice, setNotice] = useState<{ type: "ok" | "error"; text: string } | null>(null);
  const filtered = useMemo(() => (groups.data ?? []).filter(group => {
    const needle = applied.query.trim().toLowerCase();
    const matchesQuery = !needle || [group.name, group.id].some(value => value.toLowerCase().includes(needle));
    const matchesStrategy = applied.strategy === "ALL" || group.strategy === applied.strategy;
    const matchesEnabled = applied.enabled === "ALL" || (applied.enabled === "ON") === group.enabled;
    return matchesQuery && matchesStrategy && matchesEnabled;
  }), [groups.data, applied]);
  // 先筛选再排序：筛选是用户当前关心的子集，排序只作用于这个子集
  const rows = useMemo(() => sortRows(filtered, SORT_COLUMNS, sort), [filtered, sort]);
  const pager = useClientPager(rows, 20);

  async function remove(group: RoutingGroup) {
    setBusy(true);
    try {
      await api(`/routing-groups/${group.id}/delete`, { method: "POST", body: JSON.stringify({ revision: group.revision }) });
      setRemoving(null); setNotice({ type: "ok", text: `轮询组「${group.name}」已删除，历史支付仍使用原通道。` });
      await groups.reload();
    } catch (error) { setNotice({ type: "error", text: error instanceof Error ? error.message : "删除失败" }); }
    finally { setBusy(false); }
  }

  const columns: ColumnProps<RoutingGroup>[] = [
    {
      title: sortHeader(SORT_COLUMNS[0], sort, onSort),
      dataIndex: "name",
      render: (_: unknown, group: RoutingGroup) => <div {...sortValueProps(group, SORT_COLUMNS[0])}>
        <strong>{group.name}</strong>
        <div className="muted mono">{group.id}</div>
      </div>,
    },
    {
      title: sortHeader(SORT_COLUMNS[1], sort, onSort),
      dataIndex: "strategy",
      width: 140,
      render: (_: unknown, group: RoutingGroup) => <span {...sortValueProps(group, SORT_COLUMNS[1])}>{routingStrategyLabels[group.strategy]}</span>,
    },
    {
      title: sortHeader(SORT_COLUMNS[2], sort, onSort),
      dataIndex: "availableChannels",
      render: (_: unknown, group: RoutingGroup) => <div {...sortValueProps(group, SORT_COLUMNS[2])}>
        <div>{group.availableChannels} / {group.members.length} 个可用</div>
        <div className="muted routing-member-summary">{group.members.map(member => `${member.channel.name}${group.strategy === "WEIGHTED_RANDOM" ? `（权重 ${member.weight}）` : ""}${!member.eligible ? " · 不参与" : ""}`).join("、") || "成员已移除，请重新配置"}</div>
      </div>,
    },
    {
      title: sortHeader(SORT_COLUMNS[3], sort, onSort),
      dataIndex: "enabled",
      width: 140,
      render: (_: unknown, group: RoutingGroup) => <div {...sortValueProps(group, SORT_COLUMNS[3])}>
        <Status value={group.enabled ? "ACTIVE" : "DISABLED"} />
        {group.enabled && !group.availableChannels && <div className="error">无可用通道</div>}
      </div>,
    },
    {
      title: sortHeader(SORT_COLUMNS[4], sort, onSort),
      dataIndex: "applicationCount",
      width: 120,
      render: (_: unknown, group: RoutingGroup) => <span {...sortValueProps(group, SORT_COLUMNS[4])}>{group.applicationCount} 个</span>,
    },
    {
      title: "操作",
      dataIndex: "actions",
      width: 140,
      render: (_: unknown, group: RoutingGroup) => <div className="row-actions">
        <button type="button" className="link-button" onClick={() => startEditing(group)}>配置</button>
        <button type="button" className="link-button danger-link" disabled={busy || group.applicationCount > 0} title={group.applicationCount ? "请先解除应用绑定" : "删除轮询组"} onClick={() => setRemoving(group)}>删除</button>
      </div>,
    },
  ];

  return <>
    <PageHead eyebrow="Routing groups" title="轮询组" copy="将多个通道组成收款路由，应用绑定组后，每次新支付按规则随机选择一个可用通道。" action={<div className="page-head-actions">
      <Link className="button secondary" href="/applications">绑定业务应用</Link>
      <Button type="primary" onClick={() => startEditing("new")}>创建轮询组</Button>
    </div>} />
    {notice && <Toast type={notice.type} text={notice.text} onClose={() => setNotice(null)} />}
    <ListPage>
      <FilterCard
        onSearch={() => setApplied(draft)}
        onReset={() => { const empty = { query: "", strategy: "ALL", enabled: "ALL" }; setDraft(empty); setApplied(empty); }}
      >
        <FilterItem label="关键字">
          <FilterInput value={draft.query} onChange={value => setDraft({ ...draft, query: value })} placeholder="轮询组名称 / ID" />
        </FilterItem>
        <FilterItem label="选路规则">
          <FilterSelect value={draft.strategy} onChange={value => setDraft({ ...draft, strategy: value })} options={[{ label: "全部规则", value: "ALL" }, ...STRATEGY_OPTIONS]} />
        </FilterItem>
        <FilterItem label="状态">
          <FilterSelect value={draft.enabled} onChange={value => setDraft({ ...draft, enabled: value })} options={ENABLED_OPTIONS} />
        </FilterItem>
      </FilterCard>
      <LoadingState loading={groups.loading} error={groups.error} stale={Boolean(groups.data)} empty={!groups.data?.length} emptyText="还没有轮询组。先创建轮询组、添加通道，再到业务应用中绑定。">
        <ListCard
          toolbar={<><ToolbarNote>共 {rows.length} 个轮询组</ToolbarNote><ToolbarSpacer /><Button size="small" onClick={() => { void groups.reload(); void channels.reload(); }}>刷新状态</Button></>}
          pagination={<Pager total={pager.total} page={pager.page} pageSize={pager.pageSize} onChange={pager.setPage} onPageSizeChange={pager.setPageSize} />}
        >
          <Table<RoutingGroup>
            className="list-table"
            columns={columns}
            data={pager.rows}
            rowKey="id"
            pagination={false}
            borderCell={false}
            loading={false}
            noDataElement={<div className="empty compact">没有符合筛选条件的轮询组</div>}
          />
        </ListCard>
      </LoadingState>
    </ListPage>
    <p className="muted routing-help">停用、归档、暂停参与或当前配置未通过检测的通道会被跳过。没有可用通道时拒绝新支付，不回退到组外账号。请求结果不确定时不会自动换通道。</p>
    {confirmDiscard && <ConfirmModal title="放弃轮询组修改？" copy="轮询规则、权重和成员状态尚未保存，关闭后会丢失本次修改。" danger confirmLabel="放弃修改" onConfirm={() => { setConfirmDiscard(false); setEditorDirty(false); setEditing(null); }} onClose={() => setConfirmDiscard(false)} />}
    {editing && <Modal title={editing === "new" ? "创建轮询组" : `配置轮询组 · ${editing.name}`} onClose={requestCloseEditor} dismissible={!busy}>
      <LoadingState loading={channels.loading} error={channels.error} empty={false}>
        <RoutingGroupEditor group={editing === "new" ? null : editing} channels={channels.data ?? []} onBusy={setBusy} onDirtyChange={setEditorDirty} onClose={requestCloseEditor} onSaved={async () => {
          setEditing(null); setEditorDirty(false); setNotice({ type: "ok", text: "轮询组已保存，新的支付尝试将使用最新规则。" }); await groups.reload();
        }} />
      </LoadingState>
    </Modal>}
    {removing && <ConfirmModal title={`删除轮询组 · ${removing.name}`} copy="删除后不能再绑定此组。历史支付的通道绑定、查单和退款不受影响。" warning="删除后无法再绑定此组，请先确认所有应用已改派或解除绑定。" danger confirmLabel="确认删除" working={busy} onClose={() => { if (!busy) setRemoving(null); }} onConfirm={() => void remove(removing)} />}
  </>;
}

function RoutingGroupEditor({ group, channels, onBusy, onDirtyChange, onClose, onSaved }: {
  group: RoutingGroup | null; channels: Channel[]; onBusy: (busy: boolean) => void; onDirtyChange: (dirty: boolean) => void; onClose: () => void; onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState(group?.name ?? "");
  const [strategy, setStrategy] = useState<RoutingStrategy>(group?.strategy ?? "RANDOM");
  const [enabled, setEnabled] = useState(group?.enabled ?? true);
  const [members, setMembers] = useState<MemberInput[]>(group?.members.map(({ channelId, weight, enabled }) => ({ channelId, weight, enabled })) ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const baseMembers = group?.members.map(({ channelId, weight, enabled }) => ({ channelId, weight, enabled })) ?? [];
  const dirty = name !== (group?.name ?? "") || strategy !== (group?.strategy ?? "RANDOM") ||
    enabled !== (group?.enabled ?? true) || JSON.stringify(members) !== JSON.stringify(baseMembers);
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  const options = [...channels, ...(group?.members.filter(member => !channels.some(channel => channel.id === member.channelId)).map(member => member.channel) ?? [])];
  const activeMembers = members.filter(member => member.enabled);
  const availableMembers = activeMembers.filter(member => options.some(channel => channel.id === member.channelId && channel.enabled && !channel.archivedAt && ["API_VERIFIED", "PAYMENT_VERIFIED", "SIMULATED"].includes(channel.checkStatus)));
  const totalWeight = availableMembers.reduce((total, member) => total + member.weight, 0);

  function changeMember(channelId: string, patch: Partial<MemberInput>) {
    setMembers(current => current.map(member => member.channelId === channelId ? { ...member, ...patch } : member));
  }
  // 表单值仍由本地状态持有：成员列表是"通道 × 成员"的合并视图，做成 Form 的字段集合会更难读懂，
  // 因此 Form 只承担提交语义与版式，校验在提交时显式完成。
  async function submit() {
    if (saving) return;
    setError("");
    if (!name.trim()) { setError("请填写轮询组名称。"); return; }
    if (!members.length) { setError("请至少添加一个通道。"); return; }
    if (members.length > 100) { setError("一个轮询组最多添加 100 个通道。"); return; }
    if (strategy === "WEIGHTED_RANDOM" && members.some(member => !Number.isInteger(member.weight) || member.weight < WEIGHT_MIN || member.weight > WEIGHT_MAX)) {
      setError(`权重需为 ${WEIGHT_MIN} 到 ${WEIGHT_MAX} 之间的整数。`); return;
    }
    setSaving(true); onBusy(true);
    try {
      await api(group ? `/routing-groups/${group.id}` : "/routing-groups", { method: "POST", body: JSON.stringify({ name, strategy, enabled, ...(group ? { revision: group.revision } : {}), members }) });
      await onSaved();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "保存失败"); }
    finally { setSaving(false); onBusy(false); }
  }
  return <Form layout="vertical" onSubmit={() => void submit()}>
    <fieldset className="routing-editor-fields" disabled={saving}>
      <Form.Item label="轮询组名称" required>
        <Input aria-label="轮询组名称" value={name} disabled={saving} required maxLength={120} autoFocus onChange={(value) => setName(value)} />
      </Form.Item>
      <Form.Item label="选路规则">
        <Select aria-label="选路规则" value={strategy} disabled={saving} options={STRATEGY_OPTIONS} onChange={(value) => setStrategy(value as RoutingStrategy)} />
      </Form.Item>
      <p className="muted">{strategy === "RANDOM" ? "每个可用成员被选中的机会相同；不是按顺序轮流。" : "按可用成员的相对权重抽取。例如权重 1 和 3，概率分别约为 25% 和 75%。"}</p>
      <Form.Item label="启用轮询组">
        <Switch aria-label="启用轮询组" checked={enabled} disabled={saving} onChange={(value) => setEnabled(value)} />
      </Form.Item>
      <div className="routing-member-heading"><strong>成员通道</strong><span className="muted">已选 {members.length} 个</span></div>
      {!options.length && <p className="muted">还没有通道，请先在支付通道页面创建并完成检测。</p>}
      <div className="routing-member-list">{options.map(channel => {
        const member = members.find(item => item.channelId === channel.id);
        const available = channel.enabled && !channel.archivedAt && ["API_VERIFIED", "PAYMENT_VERIFIED", "SIMULATED"].includes(channel.checkStatus);
        const share = member?.enabled && available ? strategy === "RANDOM" ? 100 / Math.max(availableMembers.length, 1) : member.weight / Math.max(totalWeight, 1) * 100 : 0;
        return <div className={`routing-member-row${member ? " selected" : ""}`} key={channel.id}>
          <label className="routing-member-choice">
            <Checkbox
              aria-label={`选择通道 ${channel.name}`}
              checked={!!member}
              disabled={saving || (!!channel.archivedAt && !member)}
              onChange={(checked) => setMembers(current => checked ? [...current, { channelId: channel.id, weight: 1, enabled: true }] : current.filter(item => item.channelId !== channel.id))}
            />
            <span><strong>{channel.name}</strong><span className="muted">{channelLabel(channel.plugin)} · {channel.archivedAt ? "已归档，请移除" : checkLabels[channel.checkStatus] ?? channel.checkStatus}{!channel.enabled ? " · 已停用" : ""}</span></span>
          </label>
          {member && <div className="routing-member-controls">
            {/* 用 span 而不是 label 包住 Switch：label 只会关联可标注的表单控件，按钮型控件的名字得靠 aria-label */}
            <span className="toggle-inline"><Switch size="small" aria-label={`${channel.name} 参与选路`} checked={member.enabled} disabled={saving} onChange={(value) => changeMember(channel.id, { enabled: value })} />参与</span>
            {strategy === "WEIGHTED_RANDOM" && <label className="routing-weight">权重
              <InputNumber
                aria-label={`${channel.name} 权重`}
                min={WEIGHT_MIN}
                max={WEIGHT_MAX}
                step={1}
                value={member.weight}
                disabled={saving}
                onChange={(value) => changeMember(channel.id, { weight: Number.isFinite(Number(value)) ? Number(value) : 0 })}
              />
            </label>}
            <span className="muted">{member.enabled && available ? `${share.toFixed(1)}%` : "暂不选路"}</span>
          </div>}
        </div>;
      })}</div>
      {enabled && members.length > 0 && availableMembers.length === 0 && <div className="dialog-warning" role="status">当前没有可用的参与通道。即使保存并启用此组，也无法承接新的支付，请先检测并启用成员通道。</div>}
      {group && <p className="muted">修改预览：{group.strategy !== strategy ? `选路规则由「${routingStrategyLabels[group.strategy]}」改为「${routingStrategyLabels[strategy]}」；` : ""}成员 ${group.members.length} → ${members.length}，可用参与 ${availableMembers.length} 个。保存后仅影响新的支付尝试。</p>}
      {error && <div className="error" role="alert">{error}</div>}
      <div className="dialog-actions">
        <Button type="primary" htmlType="submit" loading={saving} disabled={!name.trim() || !members.length || saving || (!!group && !dirty)}>{saving ? "保存中…" : group && !dirty ? "尚无修改" : "保存轮询组"}</Button>
        <Button type="secondary" disabled={saving} onClick={onClose}>取消</Button>
      </div>
    </fieldset>
  </Form>;
}
