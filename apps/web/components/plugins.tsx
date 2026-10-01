"use client";

import { Plus, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { nextSortState, sortRows, type SortColumn } from "../lib/sort";
import { CopyValue, LoadingState, Modal, PageHead, Section, SortableTh, Toast, sortValueProps } from "./common";
import { ChannelEditor } from "./channel-editor";
import { useApi } from "../lib/api";

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
  const [notice, setNotice] = useState("");
  const [sort, setSort] = useState(() => null as ReturnType<typeof nextSortState>);
  const rows = useMemo(() => sortRows(plugins.data ?? [], SORT_COLUMNS, sort), [plugins.data, sort]);
  return <>
    {notice && <Toast text={notice} onClose={() => setNotice("")} />}
    <PageHead eyebrow="Payment Plugins" title="支付插件" copy="每个插件是一种收款能力；创建通道时必须选择一个插件作为对接，配置验证后分配给业务应用。" action={
      <div className="page-head-actions">
        <button className="button secondary" onClick={() => void plugins.reload()}><RefreshCw size={14} />刷新</button>
        <button className="button" onClick={() => setEditor("")}><Plus size={14} />创建通道</button>
      </div>
    } />
    <Section title="插件列表" action={<span className="muted">{plugins.data?.length ?? 0} 个插件</span>}>
      <LoadingState loading={plugins.loading} error={plugins.error} empty={!plugins.data?.length} emptyText="当前没有可用的支付插件">
        <div className="table-wrap"><table>
          <thead><tr>
            <SortableTh label="插件编码" sortKey="code" sort={sort} onSort={key => setSort(nextSortState(sort, key))} />
            <SortableTh label="名称" sortKey="name" sort={sort} onSort={key => setSort(nextSortState(sort, key))} />
            <SortableTh label="说明" sortKey="description" sort={sort} onSort={key => setSort(nextSortState(sort, key))} />
            <SortableTh label="支持能力" sortKey="capabilities" sort={sort} onSort={key => setSort(nextSortState(sort, key))} />
            <th scope="col">操作</th>
          </tr></thead>
          <tbody>{rows.map(plugin => <tr key={plugin.code}>
            <td {...sortValueProps(plugin, SORT_COLUMNS[0])}><div className="id-line"><code>{plugin.code}</code><CopyValue value={plugin.code} label="复制插件编码" /></div></td>
            <td data-label="名称" {...sortValueProps(plugin, SORT_COLUMNS[1])}><strong>{plugin.name}</strong></td>
            <td data-label="说明" {...sortValueProps(plugin, SORT_COLUMNS[2])}><span className="muted">{plugin.description}</span></td>
            <td data-label="支持能力" {...sortValueProps(plugin, SORT_COLUMNS[3])}><div className="plugin-capabilities">{plugin.capabilities.map(item => <span key={item}>{item}</span>)}</div></td>
            <td data-label="操作"><button className="button secondary" onClick={() => setEditor(plugin.code)}><Plus size={14} />创建通道</button></td>
          </tr>)}</tbody>
        </table></div>
      </LoadingState>
    </Section>
    {editor !== null && <Modal title="创建通道" onClose={() => setEditor(null)}><ChannelEditor key={editor} plugin={editor || undefined} plugins={plugins.data ?? []} onClose={() => setEditor(null)} onSaved={async () => { setEditor(null); setNotice("支付通道已创建，请前往支付通道页面完成检测与验收。"); }} /></Modal>}
  </>;
}
