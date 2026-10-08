"use client";
import { Button, Form, Input, Table } from "@arco-design/web-react";
import type { ColumnProps } from "@arco-design/web-react/es/Table";
import { RefreshCw, Settings2, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { api, useApi } from "../lib/api";
import { cashierLink } from "../lib/form-safety";
import { channelLabel } from "../lib/labels";
import type { RoutingGroup } from "../lib/routing-groups";
import { sortRows, type SortColumn } from "../lib/sort";
import { ChannelEditor, type PluginOption } from "./channel-editor";
import { ConfirmModal, CopyValue, HoverDetail, LoadingState, Modal, PageHead, RowAction, Status, Toast, sortValueProps, statusText, time } from "./common";
import { FilterCard, FilterInput, FilterItem, FilterSelect, ListCard, ListPage, Pager, ToolbarNote, ToolbarSpacer, sortHeader, useClientPager, useTableSort } from "./list";
import { RoutingTargetSelect, applicationRoutingTarget, assignPaymentRouting } from "./routing-target";

export type Channel = {
  id: string; name: string; plugin: string; enabled: boolean; revision: number;
  archivedAt?: string | null;
  settings: Record<string, string | number | boolean>; checkStatus: string; checkMessage: string | null; checkedAt: string | null;
  watcherUrl: string; webhookUrl: string;
  // 接口只报「当前配置下」的验收单；配置变更后旧单作废，这里就是 null
  testPayment: { paymentNo: string; status: string; cashierUrl: string } | null;
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

// 状态筛选项直接由展示字典生成：后端新增枚举时字典先变，筛选项不会漏掉。
const CHECK_OPTIONS = [{ label: "全部状态", value: "ALL" }, ...Object.entries(checkLabels).map(([value, label]) => ({ label, value }))];
const ENABLED_OPTIONS = [
  { label: "全部", value: "ALL" },
  { label: "仅启用", value: "ON" },
  { label: "仅停用", value: "OFF" },
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
  const { sort, onSort } = useTableSort<Channel>();
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  // 查询条件在点「查询」时才生效：输入过程中每敲一个字都重算整张表，长列表会明显卡顿
  const [draft, setDraft] = useState({ query: "", plugin: "ALL", checkStatus: "ALL", enabled: "ALL" });
  const [applied, setApplied] = useState({ query: "", plugin: "ALL", checkStatus: "ALL", enabled: "ALL" });
  // 插件筛选项取「插件目录 ∪ 通道实际用到的插件」：目录接口还没回来时，列表里的插件也能筛
  const pluginOptions = useMemo(() => {
    const codes = Array.from(new Set([...(plugins.data ?? []).map(item => item.code), ...(channels.data ?? []).map(item => item.plugin)]));
    return [{ label: "全部插件", value: "ALL" }, ...codes.map(code => ({ label: channelLabel(code), value: code }))];
  }, [plugins.data, channels.data]);
  const filtered = useMemo(() => (channels.data ?? []).filter(channel => {
    const needle = applied.query.trim().toLowerCase();
    const matchesQuery = !needle || [channel.name, channel.id, channel.plugin, channelLabel(channel.plugin)].some(value => value.toLowerCase().includes(needle));
    const matchesPlugin = applied.plugin === "ALL" || channel.plugin === applied.plugin;
    const matchesCheck = applied.checkStatus === "ALL" || channel.checkStatus === applied.checkStatus;
    const matchesEnabled = applied.enabled === "ALL" || (applied.enabled === "ON") === channel.enabled;
    return matchesQuery && matchesPlugin && matchesCheck && matchesEnabled;
  }), [channels.data, applied]);
  // 先筛选再排序：筛选是用户当前关心的子集，排序只作用于这个子集
  const rows = useMemo(() => sortRows(filtered, SORT_COLUMNS, sort), [filtered, sort]);
  const pager = useClientPager(rows, 20);
  const [testChannel, setTestChannel] = useState<Channel | null>(null);
  const [testAmount, setTestAmount] = useState("0.01");
  const [cashierUrl, setCashierUrl] = useState("");
  const [pendingAssignment, setPendingAssignment] = useState<{ app: Application; target: string } | null>(null);
  const [formBusy, setFormBusy] = useState(false);
  const [formDirty, setFormDirty] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const targetLabel = (target: string): string => {
    if (!target) return "未绑定收款路由";
    if (target.startsWith("group:")) return groups.data?.find(group => group.id === target.slice(6))?.name ?? target;
    if (target.startsWith("channel:")) return channels.data?.find(channel => channel.id === target.slice(8))?.name ?? target;
    return target;
  };
  const closeChannelForm = () => {
    if (formBusy) return;
    if (formDirty) { setConfirmDiscard(true); return; }
    setEditor(null); setCreateOpen(false);
  };
  const discardChannelForm = () => {
    setConfirmDiscard(false); setFormDirty(false); setEditor(null); setCreateOpen(false);
  };
  async function operate(channel: Channel, action: "check" | "test-payment", amount?: string) {
    // 必须在点击事件里同步预留窗口，否则 await 后 window.open 常被浏览器阻止。
    const cashierWindow = action === "test-payment" && channel.plugin !== "MOCK" ? window.open("about:blank", "_blank") : null;
    if (cashierWindow) cashierWindow.opener = null;
    setBusy(channel.id); setNotice(null); setCashierUrl("");
    try {
      const result = await api<{ data: Channel | { cashierUrl: string } }>(`/channel-instances/${channel.id}/${action}`, { method: "POST", body: JSON.stringify({ revision: channel.revision, ...(amount ? { amount } : {}) }) });
      if (action === "check") {
        const checked = result.data as Channel;
        setNotice({ ok: checked.checkStatus !== "FAILED", text: checked.checkMessage || checkLabels[checked.checkStatus] || "检测完成" });
      } else {
        const cashierUrl = (result.data as { cashierUrl: string }).cashierUrl;
        const url = cashierLink(cashierUrl, window.location.origin);
        setCashierUrl(url);
        let opened = false;
        if (cashierWindow && !cashierWindow.closed) {
          try { cashierWindow.location.replace(url); opened = true; } catch { /* 改为手动打开 */ }
        }
        setNotice({ ok: true, text: opened
          ? `验收订单已创建（¥${amount || "0.01"}），收银台已在新窗口打开；测试款不会自动退款。`
          : `验收订单已创建（¥${amount || "0.01"}），浏览器未能自动打开收银台，请点击下方链接；测试款不会自动退款。` });
        setTestChannel(null);
      }
      await channels.reload();
    } catch (error) {
      if (cashierWindow && !cashierWindow.closed) cashierWindow.close();
      setNotice({ ok: false, text: error instanceof Error ? error.message : "操作失败" });
    }
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
    if (busy) return;
    setBusy(app.id); setNotice(null);
    try {
      await assignPaymentRouting(app.id, target);
      setPendingAssignment(null);
      setNotice({ ok: true, text: target ? `${app.name} 收款路由已更新，仅影响新支付。` : `${app.name} 已解除收款绑定，新支付将被拒绝。` });
      await applications.reload(); await groups.reload();
    } catch (error) { setNotice({ ok: false, text: error instanceof Error ? error.message : "分配失败" }); }
    finally { setBusy(""); }
  }

  const columns: ColumnProps<Channel>[] = [
    {
      title: sortHeader(SORT_COLUMNS[0], sort, onSort),
      dataIndex: "name",
      render: (_: unknown, channel: Channel) => <div {...sortValueProps(channel, SORT_COLUMNS[0])}>
        <div className="channel-id-cell">
          {/* 图标里的字只是插件的视觉代称，真正的插件名在相邻文本里，避免被读屏重复朗读 */}
          <div className={`channel-icon xs ${channel.plugin === "MOCK" ? "mock" : "alipay"}`} aria-hidden="true">{channel.plugin === "MOCK" ? "M" : channel.plugin === "ALIPAY_BILL" ? "账" : "支"}</div>
          <div>
            <strong>{channel.name}</strong>
            <div className="id-line"><span className="muted">{channelLabel(channel.plugin)} · <span className="mono">{channel.id}</span></span><CopyValue value={channel.id} label="复制通道 ID" /></div>
          </div>
        </div>
      </div>,
    },
    {
      title: sortHeader(SORT_COLUMNS[1], sort, onSort),
      dataIndex: "enabled",
      width: 110,
      render: (_: unknown, channel: Channel) => <span {...sortValueProps(channel, SORT_COLUMNS[1])}><Status value={channel.enabled ? "ACTIVE" : "DISABLED"} /></span>,
    },
    {
      title: sortHeader(SORT_COLUMNS[2], sort, onSort),
      dataIndex: "checkStatus",
      width: 220,
      render: (_: unknown, channel: Channel) => <div {...sortValueProps(channel, SORT_COLUMNS[2])}>
        <HoverDetail text={checkDetail(channel)} tone={channel.checkStatus === "FAILED" ? "danger" : "muted"}><span className={`badge badge-${channel.checkStatus === "FAILED" ? "danger" : ["PAYMENT_VERIFIED", "API_VERIFIED"].includes(channel.checkStatus) ? "success" : "warning"}`}>{checkLabels[channel.checkStatus]}</span></HoverDetail>

      </div>,
    },
    {
      title: sortHeader(SORT_COLUMNS[3], sort, onSort),
      dataIndex: "checkedAt",
      width: 180,
      render: (_: unknown, channel: Channel) => <span {...sortValueProps(channel, SORT_COLUMNS[3])}>{time(channel.checkedAt)}</span>,
    },
    {
      title: "操作",
      dataIndex: "actions",
      width: 280,
      render: (_: unknown, channel: Channel) => <div className="channel-actions">
        <RowAction disabled={!!busy} onClick={() => { setFormBusy(false); setFormDirty(false); setEditor(channel); }}><Settings2 size={13} aria-hidden="true" />配置</RowAction>
        <RowAction busy={busy === channel.id} disabled={!!busy} onClick={() => void operate(channel, "check")}>{busy === channel.id ? "检测中…" : "检测"}</RowAction>
        <RowAction disabled={!!busy || !channel.enabled} title={!channel.enabled ? "请先启用通道，再进行验收" : undefined} onClick={() => { setTestAmount("0.01"); setTestChannel(channel); }}>{channel.plugin === "MOCK" ? "模拟验收" : "实付验收"}</RowAction>
        <RowAction danger disabled={!!busy} onClick={() => setRemoving(channel)}><Trash2 size={13} aria-hidden="true" />删除</RowAction>
      </div>,
    },
  ];

  return <>
    <PageHead eyebrow="Channels" title="支付通道" copy="独立收款账号的通道实例；修改配置后需重新检测，验证通过才能分配给应用。" action={
      <div className="page-head-actions">
        <Button type="secondary" icon={<RefreshCw size={14} aria-hidden="true" />} onClick={() => void channels.reload()}>刷新状态</Button>
        <Button type="primary" onClick={() => { setFormBusy(false); setFormDirty(false); setCreateOpen(true); }}>创建通道</Button>
      </div>
    } />
    {notice && <Toast type={notice.ok ? "ok" : "error"} text={notice.text} onClose={() => setNotice(null)} />}
    {cashierUrl && <div className="operation-notice ok" role="status">验收收银台链接：<a href={cashierUrl} target="_blank" rel="noopener noreferrer" onClick={() => setCashierUrl("")}>点击打开收银台 ↗</a><button type="button" className="link-button" onClick={() => setCashierUrl("")}>关闭</button></div>}
    <ListPage>
      <FilterCard
        onSearch={() => setApplied(draft)}
        onReset={() => { const empty = { query: "", plugin: "ALL", checkStatus: "ALL", enabled: "ALL" }; setDraft(empty); setApplied(empty); }}
      >
        <FilterItem label="关键字">
          <FilterInput value={draft.query} onChange={value => setDraft({ ...draft, query: value })} placeholder="通道名称 / ID / 插件" />
        </FilterItem>
        <FilterItem label="对接插件">
          <FilterSelect value={draft.plugin} onChange={value => setDraft({ ...draft, plugin: value })} options={pluginOptions} />
        </FilterItem>
        <FilterItem label="验证状态">
          <FilterSelect value={draft.checkStatus} onChange={value => setDraft({ ...draft, checkStatus: value })} options={CHECK_OPTIONS} />
        </FilterItem>
        <FilterItem label="新订单">
          <FilterSelect value={draft.enabled} onChange={value => setDraft({ ...draft, enabled: value })} options={ENABLED_OPTIONS} />
        </FilterItem>
      </FilterCard>
      <LoadingState loading={channels.loading} error={channels.error} stale={Boolean(channels.data)} empty={!channels.data?.length} emptyText="还没有支付通道：请先创建通道并选择对接的支付插件，检测通过后再分配给应用">
        <ListCard
          toolbar={<><ToolbarNote>共 {rows.length} 个通道</ToolbarNote><ToolbarSpacer /><RowAction onClick={() => setAssignOpen(true)}>通道分配</RowAction><Button size="small" onClick={() => void channels.reload()}>刷新状态</Button></>}
          pagination={<Pager total={pager.total} page={pager.page} pageSize={pager.pageSize} onChange={pager.setPage} onPageSizeChange={pager.setPageSize} />}
        >
          <Table<Channel>
            className="list-table"
            columns={columns}
            data={pager.rows}
            rowKey="id"
            pagination={false}
            borderCell={false}
            loading={false}
            noDataElement={<div className="empty compact">没有符合筛选条件的通道</div>}
          />
        </ListCard>
      </LoadingState>
    </ListPage>
    {removing && <ConfirmModal title={`删除通道 · ${removing.name}`} danger confirmLabel="确认删除"
      copy={`即将删除通道「${removing.name}」（${removing.id}）。如果它从未产生过支付或退款记录，会被直接删除；如果承载过资金数据，则转为归档删除：不再出现于列表与分配选项、不能再发起新支付，但对接密钥与历史单据保留，历史支付单仍可查单与原路退款。若仍有应用正在使用该通道，删除会被拒绝，请先在「通道分配」里改派。`}
      warning="删除不可逆。归档保留的密钥是历史支付单查单与原路退款的唯一凭据。"
      working={busy === removing.id} onConfirm={() => void remove(removing)} onClose={() => setRemoving(null)} />}
    {testChannel && <Modal title={testChannel.plugin === "MOCK" ? "模拟验收" : "实付验收"} onClose={busy ? () => undefined : () => setTestChannel(null)}>
      <div className="resolution-form">
        <p className="dialog-copy">{testChannel.plugin === "MOCK"
          ? "将创建一笔模拟测试订单，用于验证完整支付流程，不会产生真实扣款。"
          : "将创建一笔真实测试订单并打开收银台。账单金额模式可能在输入金额基础上增加最多 ¥0.99，请以收银台最终显示金额为准。"}</p>
        <Form layout="vertical">
          <Form.Item label="验收金额（元）" required>
            <Input aria-label="验收金额（元）" type="number" min="0.01" step="0.01" value={testAmount} disabled={!!busy} autoFocus onChange={value => setTestAmount(value)} />
          </Form.Item>
        </Form>
        {testChannel.plugin !== "MOCK" && <div className="dialog-warning">测试款不会自动退款，请使用你可以确认到账并接受实际扣款的金额。</div>}
        <div className="dialog-actions">
          <Button type="primary" loading={busy === testChannel.id} disabled={!!busy || !Number.isFinite(Number(testAmount)) || Number(testAmount) <= 0} onClick={() => void operate(testChannel, "test-payment", testAmount.trim() || "0.01")}>{busy === testChannel.id ? "创建中…" : "创建验收订单"}</Button>
          <Button type="secondary" disabled={!!busy} onClick={() => setTestChannel(null)}>取消</Button>
        </div>
      </div>
    </Modal>}

    {editor && <Modal title={`配置通道 · ${editor.name}`} onClose={closeChannelForm} dismissible={!formBusy}><ChannelEditor key={editor.id} channel={editor} plugins={plugins.data ?? []} onBusyChange={setFormBusy} onDirtyChange={setFormDirty} onClose={closeChannelForm} onSaved={async () => { setEditor(null); setFormBusy(false); setFormDirty(false); setNotice({ ok: true, text: "通道配置已保存，请重新检测后再分配给应用。" }); void channels.reload().catch(() => setNotice({ ok: false, text: "通道配置已保存，但列表刷新失败，请手动刷新。" })); }} /></Modal>}
    {createOpen && <Modal title="创建通道" onClose={closeChannelForm} dismissible={!formBusy}><ChannelEditor plugins={plugins.data ?? []} onBusyChange={setFormBusy} onDirtyChange={setFormDirty} onClose={closeChannelForm} onSaved={async () => { setCreateOpen(false); setFormBusy(false); setFormDirty(false); setNotice({ ok: true, text: "支付通道已创建，请完成检测与验收后再分配给应用。" }); void channels.reload().catch(() => setNotice({ ok: false, text: "支付通道已创建，但列表刷新失败，请不要重复创建，尝试手动刷新。" })); }} /></Modal>}
    {confirmDiscard && <ConfirmModal title="放弃未保存的通道配置？" copy="你修改的通道设置、密钥输入及清除选项都尚未保存。关闭后这些输入将丢失。" confirmLabel="放弃修改" danger onClose={() => setConfirmDiscard(false)} onConfirm={discardChannelForm} />}
    {pendingAssignment && <ConfirmModal title="确认修改收款路由" copy={`${pendingAssignment.app.name}：${targetLabel(applicationRoutingTarget(pendingAssignment.app))} → ${targetLabel(pendingAssignment.target)}。修改仅影响新支付。`} warning={!pendingAssignment.target ? "解除绑定后，这个应用无法创建新的支付订单。" : undefined} danger={!pendingAssignment.target} working={!!busy} confirmLabel={!pendingAssignment.target ? "确认解除绑定" : "确认改派"} onClose={() => setPendingAssignment(null)} onConfirm={() => void assign(pendingAssignment.app, pendingAssignment.target)} />}
    {assignOpen && <Modal title="应用收款路由分配" onClose={() => setAssignOpen(false)}>
      <LoadingState loading={applications.loading} error={applications.error} stale={Boolean(applications.data)} empty={!applications.data?.length} emptyText="还没有业务应用，创建应用后即可在这里分配收款通道">
        {groups.error && <div className="error" role="alert">{groups.error}</div>}
        <Table<Application>
          className="list-table"
          columns={[
            { title: "业务应用", dataIndex: "name", render: (_: unknown, app: Application) => <strong>{app.name}</strong> },
            {
              title: "收款路由",
              dataIndex: "routing",
              render: (_: unknown, app: Application) => {
                const current = applicationRoutingTarget(app);
                // 这里的控件就是路由选择本身（原生 select），它是绑定关系的唯一入口，
                // 保持原样的 props 与调用方式，避免改坏 group:/channel: 的取值语义。
                return <RoutingTargetSelect aria-label={`${app.name} 收款路由`} value={current} currentTarget={current} groups={groups.data ?? []} channels={channels.data ?? []} disabled={!!busy || groups.loading || !!groups.error} onChange={event => { if (event.target.value !== current) setPendingAssignment({ app, target: event.target.value }); }} />;
              },
            },
          ]}
          data={applications.data ?? []}
          rowKey="id"
          pagination={false}
          borderCell={false}
          loading={false}
        />
      </LoadingState>
    </Modal>}
  </>;
}
