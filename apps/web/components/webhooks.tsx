"use client";

import { useState } from "react";
import { api, useApi } from "../lib/api";
import { CopyValue, LoadingState, PageHead, Status, Toast, time } from "./common";
import { protocolLabel, webhookEventLabel } from "../lib/labels";

type Delivery = { id: string; eventType: string; protocol: string; url: string; status: string; attempts: number; lastError: string | null; nextAttemptAt: string; application: { name: string }; order: { orderNo: string; externalOrderNo: string } };

export function Webhooks() {
  const { data, loading, error, reload } = useApi<Delivery[]>("/webhooks?pageSize=100", 8_000);
  const [retrying, setRetrying] = useState("");
  const [notice, setNotice] = useState<{ type: "ok" | "error"; text: string } | null>(null);

  async function retry(id: string) {
    setRetrying(id);
    setNotice(null);
    try {
      await api(`/webhooks/${id}/retry`, { method: "POST" });
      setNotice({ type: "ok", text: "Webhook 已重新加入投递队列。" });
      await reload();
    } catch (cause) {
      setNotice({ type: "error", text: cause instanceof Error ? cause.message : "Webhook 重试失败" });
    } finally {
      setRetrying("");
    }
  }

  return <>
    <PageHead eyebrow="Delivery" title="Webhook 投递" copy="通知任务与支付结果同事务创建；失败后指数退避，达到上限进入 DEAD。" />
    {notice && <Toast type={notice.type} text={notice.text} onClose={() => setNotice(null)} />}
    <LoadingState loading={loading} error={error} empty={!data?.length}>
      <section className="card section"><div className="table-wrap"><table>
        <thead><tr><th>事件 / 订单</th><th>目标地址</th><th>协议</th><th>状态</th><th>尝试</th><th>下次执行</th><th>操作</th></tr></thead>
        <tbody>{data?.map(item => <tr key={item.id}>
          <td>
            <strong>{webhookEventLabel(item.eventType.split(":")[0])}</strong>
            <div className="mono muted">{item.eventType}</div>
            <div className="id-line"><span className="mono muted">{item.order.externalOrderNo}</span><CopyValue value={item.order.externalOrderNo} label="复制业务订单号" /></div>
            {item.lastError && <div className="row-error">{item.lastError}</div>}
          </td>
          <td data-label="目标地址"><div className="id-line"><span className="mono break-all">{item.url}</span><CopyValue value={item.url} label="复制 Webhook 地址" /></div></td>
          <td data-label="协议">{protocolLabel(item.protocol)}</td>
          <td data-label="状态"><Status value={item.status} /></td>
          <td data-label="尝试">{item.attempts}</td>
          <td data-label="下次执行">{time(item.nextAttemptAt)}</td>
          <td data-label="操作">{item.status === "DEAD" && <button className="button secondary" disabled={retrying !== ""} onClick={() => void retry(item.id)}>{retrying === item.id ? "重试中…" : "重新投递"}</button>}</td>
        </tr>)}</tbody>
      </table></div></section>
    </LoadingState>
  </>;
}
