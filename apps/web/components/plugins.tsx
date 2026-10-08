"use client";

import { Button, Table } from "@arco-design/web-react";
import type { ColumnProps } from "@arco-design/web-react/es/Table";
import { Plus, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { useApi } from "../lib/api";
import { sortRows, type SortColumn } from "../lib/sort";
import { ChannelEditor } from "./channel-editor";
import { ConfirmModal, CopyValue, LoadingState, Modal, PageHead, Toast, sortValueProps } from "./common";
import { FilterCard, FilterInput, FilterItem, FilterSelect, ListCard, ListPage, Pager, ToolbarNote, ToolbarSpacer, sortHeader, useClientPager, useTableSort } from "./list";

type Plugin = { code: string; name: string; description: string; capabilities: string[] };

const SORT_COLUMNS: SortColumn<Plugin>[] = [
  { key: "code", label: "插件编码" },
  { key: "name", label: "名称" },
  { key: "description", label: "说明" },
  // 「支持能力」是一串标签，按数量排序比按拼接后的文本排序更符合直觉
  { key: "capabilities", label: "支持能力", accessor: (row) => row.capabilities.length, type: "number" },
];

export function Plugins() {
  const plugins = useApi<Plugin[]>("/plugins");
  // 从插件行点进来时带上该插件作为默认选择；也可以从页面顶部直接创建后再选插件。
  const [editor, setEditor] = useState<string | null>(null);
  const [formBusy, setFormBusy] = useState(false);
  const [formDirty, setFormDirty] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const requestClose = () => {
    if (formBusy) return;
    if (formDirty) setConfirmDiscard(true);
    else setEditor(null);
  };
  const openEditor = (plugin: string) => { setFormBusy(false); setFormDirty(false); setEditor(plugin); };
  const [notice, setNotice] = useState("");
  const { sort, onSort } = useTableSort<Plugin>();
  // 查询条件在点「查询」时才生效，避免输入过程中反复重算整张表
  const [draft, setDraft] = useState({ query: "", capability: "ALL" });
  const [applied, setApplied] = useState({ query: "", capability: "ALL" });
  // 能力标签是插件自带的展示串（"扫码支付" 等），从数据里取并集，
  // 后端给插件加能力时筛选项自动跟着出现，不用维护第二份字典。
  const capabilityOptions = useMemo(() => {
    const values = Array.from(new Set((plugins.data ?? []).flatMap(item => item.capabilities)));
    return [{ label: "全部能力", value: "ALL" }, ...values.map(value => ({ label: value, value }))];
  }, [plugins.data]);
  const filtered = useMemo(() => (plugins.data ?? []).filter(plugin => {
    const needle = applied.query.trim().toLowerCase();
    const matchesQuery = !needle || [plugin.code, plugin.name, plugin.description].some(value => value.toLowerCase().includes(needle));
    const matchesCapability = applied.capability === "ALL" || plugin.capabilities.includes(applied.capability);
    return matchesQuery && matchesCapability;
  }), [plugins.data, applied]);
  // 先筛选再排序：筛选是用户当前关心的子集，排序只作用于这个子集
  const rows = useMemo(() => sortRows(filtered, SORT_COLUMNS, sort), [filtered, sort]);
  const pager = useClientPager(rows, 20);

  const columns: ColumnProps<Plugin>[] = [
    {
      title: sortHeader(SORT_COLUMNS[0], sort, onSort),
      dataIndex: "code",
      render: (_: unknown, plugin: Plugin) => <span {...sortValueProps(plugin, SORT_COLUMNS[0])}>
        <div className="id-line"><code>{plugin.code}</code><CopyValue value={plugin.code} label="复制插件编码" /></div>
      </span>,
    },
    {
      title: sortHeader(SORT_COLUMNS[1], sort, onSort),
      dataIndex: "name",
      width: 200,
      render: (_: unknown, plugin: Plugin) => <strong {...sortValueProps(plugin, SORT_COLUMNS[1])}>{plugin.name}</strong>,
    },
    {
      title: sortHeader(SORT_COLUMNS[2], sort, onSort),
      dataIndex: "description",
      render: (_: unknown, plugin: Plugin) => <span className="muted" {...sortValueProps(plugin, SORT_COLUMNS[2])}>{plugin.description}</span>,
    },
    {
      title: sortHeader(SORT_COLUMNS[3], sort, onSort),
      dataIndex: "capabilities",
      width: 260,
      render: (_: unknown, plugin: Plugin) => <div {...sortValueProps(plugin, SORT_COLUMNS[3])}>
        <div className="plugin-capabilities">{plugin.capabilities.map(item => <span key={item}>{item}</span>)}</div>
      </div>,
    },
    {
      title: "操作",
      dataIndex: "actions",
      width: 130,
      render: (_: unknown, plugin: Plugin) => <button type="button" className="link-button" onClick={() => openEditor(plugin.code)}><Plus size={13} aria-hidden="true" />创建通道</button>,
    },
  ];

  return <>
    {notice && <Toast text={notice} onClose={() => setNotice("")} />}
    <PageHead eyebrow="Payment Plugins" title="支付插件" copy="每个插件是一种收款能力；创建通道时必须选择一个插件作为对接，配置验证后分配给业务应用。" action={
      <div className="page-head-actions">
        <Button type="secondary" icon={<RefreshCw size={14} aria-hidden="true" />} onClick={() => void plugins.reload()}>刷新</Button>
        <Button type="primary" icon={<Plus size={14} aria-hidden="true" />} onClick={() => openEditor("")}>创建通道</Button>
      </div>
    } />
    <ListPage>
      <FilterCard
        onSearch={() => setApplied(draft)}
        onReset={() => { const empty = { query: "", capability: "ALL" }; setDraft(empty); setApplied(empty); }}
      >
        <FilterItem label="关键字">
          <FilterInput value={draft.query} onChange={value => setDraft({ ...draft, query: value })} placeholder="插件编码 / 名称 / 说明" />
        </FilterItem>
        <FilterItem label="支持能力">
          <FilterSelect value={draft.capability} onChange={value => setDraft({ ...draft, capability: value })} options={capabilityOptions} />
        </FilterItem>
      </FilterCard>
      <LoadingState loading={plugins.loading} error={plugins.error} stale={Boolean(plugins.data)} empty={!plugins.data?.length} emptyText="当前没有可用的支付插件">
        <ListCard
          toolbar={<><ToolbarNote>共 {rows.length} 个插件</ToolbarNote><ToolbarSpacer /><Button size="small" onClick={() => void plugins.reload()}>刷新</Button></>}
          pagination={<Pager total={pager.total} page={pager.page} pageSize={pager.pageSize} onChange={pager.setPage} onPageSizeChange={pager.setPageSize} />}
        >
          <Table<Plugin>
            className="list-table"
            columns={columns}
            data={pager.rows}
            // 插件没有 id 字段，编码才是它的稳定主键（也是通道绑定插件时的取值）
            rowKey="code"
            pagination={false}
            borderCell={false}
            loading={false}
            noDataElement={<div className="empty compact">没有符合筛选条件的插件</div>}
          />
        </ListCard>
      </LoadingState>
    </ListPage>
    {editor !== null && <Modal title="创建通道" onClose={requestClose} dismissible={!formBusy}><ChannelEditor key={editor} plugin={editor || undefined} plugins={plugins.data ?? []} onBusyChange={setFormBusy} onDirtyChange={setFormDirty} onClose={requestClose} onSaved={async () => { setEditor(null); setFormBusy(false); setFormDirty(false); setNotice("支付通道已创建，请前往支付通道页面完成检测与验收。"); }} /></Modal>}
    {confirmDiscard && <ConfirmModal title="放弃通道配置？" copy="尚未保存的通道信息、密钥与高级配置将丢失。" confirmLabel="放弃修改" danger onConfirm={() => { setConfirmDiscard(false); setFormDirty(false); setEditor(null); }} onClose={() => setConfirmDiscard(false)} />}
  </>;
}
