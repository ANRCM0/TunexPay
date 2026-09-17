"use client";

import { useState } from "react";
import { api, useApi } from "../lib/api";
import { LoadingState, PageHead, Status, time } from "./common";
import { protocolLabel, webhookEventLabel } from "../lib/labels";

type Delivery = { id: string; eventType: string; protocol: string; url: string; status: string; attempts: number; lastError: string | null; nextAttemptAt: string; application: { name: string }; order: { orderNo: string; externalOrderNo: string } };

export function Webhooks() {
  const { data, loading, error, reload } = useApi<Delivery[]>("/webhooks?pageSize=100", 8_000);
  const [retrying, setRetrying] = useState("");
  async function retry(id: string) {
    setRetrying(id);
    try { await api(`/webhooks/${id}/retry`, { method: "POST" }); await reload(); }
    finally { setRetrying(""); }
  }
  return <>
    <PageHead eyebrow="Delivery" title="Webhook 投递" copy="通知任务与支付结果同事务创建；失败后指数退避，达到上限进入 DEAD。" />
    <LoadingState loading={loading} error={error} empty={!data?.length}>
      <section className="card section"><div className="table-wrap"><table>
        <thead><tr><th>事件 / 订单</th><th>目标地址</th><th>协议</th><th>状态</th><th>尝试</th><th>下次执行</th><th></th></tr></thead>
        <tbody>{data?.map(item => <tr key={item.id}>
          <td><strong>{webhookEventLabel(item.eventType.split(":")[0])}</strong><div className="mono muted">{item.eventType}</div><div className="mono muted">{item.order.externalOrderNo}</div>{item.lastError && <div className="row-error">{item.lastError}</div>}</td>
          <td data-label="目标地址" className="mono">{item.url}</td>
          <td data-label="协议">{protocolLabel(item.protocol)}</td>
          <td data-label="状态"><Status value={item.status} /></td>
          <td data-label="尝试">{item.attempts}</td>
          <td data-label="下次执行">{time(item.nextAttemptAt)}</td>
          <td data-label="操作">{item.status === "DEAD" && <button className="button secondary" disabled={retrying === item.id} onClick={() => void retry(item.id)}>重试</button>}</td>
        </tr>)}</tbody>
      </table></div></section>
    </LoadingState>
  </>;
}
