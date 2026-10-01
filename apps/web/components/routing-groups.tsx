"use client";
import Link from "next/link";
import { type FormEvent, useMemo, useState } from "react";
import { api, useApi } from "../lib/api";
import { nextSortState, sortRows, type SortColumn } from "../lib/sort";
import { routingStrategyLabels, type RoutingGroup, type RoutingStrategy } from "../lib/routing-groups";
import { channelLabel } from "../lib/labels";
import { checkLabels, type Channel } from "./channels";
import { ConfirmModal, LoadingState, Modal, PageHead, Section, SortableTh, Status, Toast, sortValueProps } from "./common";

type MemberInput = { channelId: string; weight: number; enabled: boolean };

const SORT_COLUMNS: SortColumn<RoutingGroup>[] = [
  { key: "name", label: "轮询组" },
  { key: "strategy", label: "选路规则" },
  // 单元格显示"可用 / 总数"，排序取可用数（能不能真正承载流量）
  { key: "availableChannels", label: "成员通道", type: "number" },
  { key: "enabled", label: "状态", accessor: (row) => (row.enabled ? 1 : 0), type: "number" },
  { key: "applicationCount", label: "绑定应用", type: "number" },
];

export function RoutingGroups() {
  const groups = useApi<RoutingGroup[]>("/routing-groups", 10_000);
  const channels = useApi<Channel[]>("/channel-instances", 10_000);
  const [sort, setSort] = useState(() => null as ReturnType<typeof nextSortState>);
  const rows = useMemo(() => sortRows(groups.data ?? [], SORT_COLUMNS, sort), [groups.data, sort]);
  const [editing, setEditing] = useState<RoutingGroup | "new" | null>(null);
  const [removing, setRemoving] = useState<RoutingGroup | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ type: "ok" | "error"; text: string } | null>(null);

  async function remove(group: RoutingGroup) {
    setBusy(true);
    try {
      await api(`/routing-groups/${group.id}/delete`, { method: "POST", body: JSON.stringify({ revision: group.revision }) });
      setRemoving(null); setNotice({ type: "ok", text: `轮询组「${group.name}」已删除，历史支付仍使用原通道。` });
      await groups.reload();
    } catch (error) { setNotice({ type: "error", text: error instanceof Error ? error.message : "删除失败" }); }
    finally { setBusy(false); }
  }

  return <>
    <PageHead eyebrow="Routing groups" title="轮询组" copy="将多个通道组成收款路由，应用绑定组后，每次新支付按规则随机选择一个可用通道。" action={<div className="page-head-actions">
      <Link className="button secondary" href="/applications">绑定业务应用</Link>
      <button className="button" onClick={() => setEditing("new")}>创建轮询组</button>
    </div>} />
    {notice && <Toast type={notice.type} text={notice.text} onClose={() => setNotice(null)} />}
    <Section title="轮询组列表" action={<button className="link-button" onClick={() => { void groups.reload(); void channels.reload(); }}>刷新状态</button>}>
      <LoadingState loading={groups.loading} error={groups.error} empty={!groups.data?.length} emptyText="还没有轮询组。先创建轮询组、添加通道，再到业务应用中绑定。">
        <div className="table-wrap"><table><thead><tr>
          <SortableTh label="轮询组" sortKey="name" sort={sort} onSort={key => setSort(nextSortState(sort, key))} />
          <SortableTh label="选路规则" sortKey="strategy" sort={sort} onSort={key => setSort(nextSortState(sort, key))} />
          <SortableTh label="成员通道" sortKey="availableChannels" sort={sort} onSort={key => setSort(nextSortState(sort, key))} />
          <SortableTh label="状态" sortKey="enabled" sort={sort} onSort={key => setSort(nextSortState(sort, key))} />
          <SortableTh label="绑定应用" sortKey="applicationCount" sort={sort} onSort={key => setSort(nextSortState(sort, key))} />
          <th scope="col">操作</th>
        </tr></thead><tbody>
          {rows.map(group => <tr key={group.id}>
            <td {...sortValueProps(group, SORT_COLUMNS[0])}><strong>{group.name}</strong><div className="muted mono">{group.id}</div></td>
            <td data-label="选路规则" {...sortValueProps(group, SORT_COLUMNS[1])}>{routingStrategyLabels[group.strategy]}</td>
            <td data-label="成员通道" {...sortValueProps(group, SORT_COLUMNS[2])}><div>{group.availableChannels} / {group.members.length} 个可用</div><div className="muted routing-member-summary">{group.members.map(member => `${member.channel.name}${group.strategy === "WEIGHTED_RANDOM" ? `（权重 ${member.weight}）` : ""}${!member.eligible ? " · 不参与" : ""}`).join("、") || "成员已移除，请重新配置"}</div></td>
            <td data-label="状态" {...sortValueProps(group, SORT_COLUMNS[3])}><Status value={group.enabled ? "ACTIVE" : "DISABLED"} />{group.enabled && !group.availableChannels && <div className="error">无可用通道</div>}</td>
            <td data-label="绑定应用" {...sortValueProps(group, SORT_COLUMNS[4])}>{group.applicationCount} 个</td>
            <td data-label="操作"><div className="row-actions"><button className="button secondary" onClick={() => setEditing(group)}>配置</button><button className="button danger" disabled={busy || group.applicationCount > 0} title={group.applicationCount ? "请先解除应用绑定" : "删除轮询组"} onClick={() => setRemoving(group)}>删除</button></div></td>
          </tr>)}
        </tbody></table></div>
      </LoadingState>
    </Section>
    <p className="muted routing-help">停用、归档、暂停参与或当前配置未通过检测的通道会被跳过。没有可用通道时拒绝新支付，不回退到组外账号。请求结果不确定时不会自动换通道。</p>
    {editing && <Modal title={editing === "new" ? "创建轮询组" : `配置轮询组 · ${editing.name}`} onClose={() => { if (!busy) setEditing(null); }}>
      <LoadingState loading={channels.loading} error={channels.error} empty={false}>
        <RoutingGroupEditor group={editing === "new" ? null : editing} channels={channels.data ?? []} onBusy={setBusy} onClose={() => setEditing(null)} onSaved={async () => {
          setEditing(null); setNotice({ type: "ok", text: "轮询组已保存，新的支付尝试将使用最新规则。" }); await groups.reload();
        }} />
      </LoadingState>
    </Modal>}
    {removing && <ConfirmModal title={`删除轮询组 · ${removing.name}`} copy="删除后不能再绑定此组。历史支付的通道绑定、查单和退款不受影响。" warning="删除后无法再绑定此组，请先确认所有应用已改派或解除绑定。" danger confirmLabel="确认删除" working={busy} onClose={() => { if (!busy) setRemoving(null); }} onConfirm={() => void remove(removing)} />}
  </>;
}

function RoutingGroupEditor({ group, channels, onBusy, onClose, onSaved }: {
  group: RoutingGroup | null; channels: Channel[]; onBusy: (busy: boolean) => void; onClose: () => void; onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState(group?.name ?? "");
  const [strategy, setStrategy] = useState<RoutingStrategy>(group?.strategy ?? "RANDOM");
  const [enabled, setEnabled] = useState(group?.enabled ?? true);
  const [members, setMembers] = useState<MemberInput[]>(group?.members.map(({ channelId, weight, enabled }) => ({ channelId, weight, enabled })) ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const options = [...channels, ...(group?.members.filter(member => !channels.some(channel => channel.id === member.channelId)).map(member => member.channel) ?? [])];
  const activeMembers = members.filter(member => member.enabled);
  const availableMembers = activeMembers.filter(member => options.some(channel => channel.id === member.channelId && channel.enabled && !channel.archivedAt && ["API_VERIFIED", "PAYMENT_VERIFIED", "SIMULATED"].includes(channel.checkStatus)));
  const totalWeight = availableMembers.reduce((total, member) => total + member.weight, 0);

  function changeMember(channelId: string, patch: Partial<MemberInput>) {
    setMembers(current => current.map(member => member.channelId === channelId ? { ...member, ...patch } : member));
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError("");
    if (!members.length) { setError("请至少添加一个通道。"); return; }
    if (members.length > 100) { setError("一个轮询组最多添加 100 个通道。"); return; }
    setSaving(true); onBusy(true);
    try {
      await api(group ? `/routing-groups/${group.id}` : "/routing-groups", { method: "POST", body: JSON.stringify({ name, strategy, enabled, ...(group ? { revision: group.revision } : {}), members }) });
      await onSaved();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "保存失败"); }
    finally { setSaving(false); onBusy(false); }
  }
  return <form className="resolution-form" onSubmit={submit}>
    <fieldset className="routing-editor-fields" disabled={saving}>
      <label>轮询组名称<input required maxLength={120} value={name} onChange={event => setName(event.target.value)} autoFocus /></label>
      <label>选路规则<select value={strategy} onChange={event => setStrategy(event.target.value as RoutingStrategy)}><option value="RANDOM">等概率随机</option><option value="WEIGHTED_RANDOM">按权重随机</option></select></label>
      <p className="muted">{strategy === "RANDOM" ? "每个可用成员被选中的机会相同；不是按顺序轮流。" : "按可用成员的相对权重抽取。例如权重 1 和 3，概率分别约为 25% 和 75%。"}</p>
      <label className="toggle-inline"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />启用轮询组</label>
      <div className="routing-member-heading"><strong>成员通道</strong><span className="muted">已选 {members.length} 个</span></div>
      {!options.length && <p className="muted">还没有通道，请先在支付通道页面创建并完成检测。</p>}
      <div className="routing-member-list">{options.map(channel => {
        const member = members.find(item => item.channelId === channel.id);
        const available = channel.enabled && !channel.archivedAt && ["API_VERIFIED", "PAYMENT_VERIFIED", "SIMULATED"].includes(channel.checkStatus);
        const share = member?.enabled && available ? strategy === "RANDOM" ? 100 / Math.max(availableMembers.length, 1) : member.weight / Math.max(totalWeight, 1) * 100 : 0;
        return <div className={`routing-member-row${member ? " selected" : ""}`} key={channel.id}>
          <label className="routing-member-choice"><input type="checkbox" checked={!!member} disabled={!!channel.archivedAt && !member} onChange={event => setMembers(current => event.target.checked ? [...current, { channelId: channel.id, weight: 1, enabled: true }] : current.filter(item => item.channelId !== channel.id))} /><span><strong>{channel.name}</strong><span className="muted">{channelLabel(channel.plugin)} · {channel.archivedAt ? "已归档，请移除" : checkLabels[channel.checkStatus] ?? channel.checkStatus}{!channel.enabled ? " · 已停用" : ""}</span></span></label>
          {member && <div className="routing-member-controls"><label className="toggle-inline"><input type="checkbox" checked={member.enabled} onChange={event => changeMember(channel.id, { enabled: event.target.checked })} />参与</label>{strategy === "WEIGHTED_RANDOM" && <label className="routing-weight">权重<input aria-label={`${channel.name} 权重`} type="number" min={1} max={10000} step={1} required value={member.weight} onChange={event => changeMember(channel.id, { weight: Number(event.target.value) })} /></label>}<span className="muted">{member.enabled && available ? `${share.toFixed(1)}%` : "暂不选路"}</span></div>}
        </div>;
      })}</div>
      {error && <div className="error" role="alert">{error}</div>}
      <div className="dialog-actions"><button className="button" type="submit" disabled={!name.trim() || !members.length}>{saving ? "保存中…" : "保存轮询组"}</button><button className="button secondary" type="button" onClick={onClose}>取消</button></div>
    </fieldset>
  </form>;
}
