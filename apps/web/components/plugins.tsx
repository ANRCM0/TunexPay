"use client";

import { Plus, RefreshCw } from "lucide-react";
import { useState } from "react";
import { CopyValue, Modal, LoadingState, PageHead, Section, Toast } from "./common";
import { ChannelEditor } from "./channel-editor";
import { useApi } from "../lib/api";

type Plugin = { code: string; name: string; description: string; capabilities: string[] };

export function Plugins() {
  const plugins = useApi<Plugin[]>("/plugins");
  const [editor, setEditor] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  return <>
    {notice && <Toast text={notice} onClose={() => setNotice("")} />}
    <PageHead eyebrow="Payment Plugins" title="支付插件" copy="每个插件是一种收款能力；从插件创建独立收款通道，配置验证后分配给业务应用。" action={<button className="button secondary" onClick={() => void plugins.reload()}><RefreshCw size={14} />刷新</button>} />
    <Section title="插件列表" action={<span className="muted">{plugins.data?.length ?? 0} 个插件</span>}>
      <LoadingState loading={plugins.loading} error={plugins.error} empty={!plugins.data?.length} emptyText="当前没有可用的支付插件">
        <div className="table-wrap"><table>
          <thead><tr><th>插件编码</th><th>名称</th><th>说明</th><th>支持能力</th><th>操作</th></tr></thead>
          <tbody>{plugins.data?.map(plugin => <tr key={plugin.code}>
            <td><div className="id-line"><code>{plugin.code}</code><CopyValue value={plugin.code} label="复制插件编码" /></div></td>
            <td data-label="名称"><strong>{plugin.name}</strong></td>
            <td data-label="说明"><span className="muted">{plugin.description}</span></td>
            <td data-label="支持能力"><div className="plugin-capabilities">{plugin.capabilities.map(item => <span key={item}>{item}</span>)}</div></td>
            <td data-label="操作"><button className="button secondary" onClick={() => setEditor(plugin.code)}><Plus size={14} />创建通道</button></td>
          </tr>)}</tbody>
        </table></div>
      </LoadingState>
    </Section>
    {editor && <Modal title="创建通道" onClose={() => setEditor(null)}><ChannelEditor key={editor} plugin={editor} onClose={() => setEditor(null)} onSaved={async () => { setEditor(null); setNotice("支付通道已创建，请前往支付通道页面完成检测与验收。"); }} /></Modal>}
  </>;
}
