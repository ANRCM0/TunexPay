"use client";

import { useState } from "react";
import { api, useApi } from "../lib/api";
import { LoadingState, PageHead, Status, time } from "./common";

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
          <td><strong>{item.eventType.split(":")[0]}</strong><div className="mono muted">{item.order.externalOrderNo}</div>{item.lastError && <div className="row-error">{item.lastError}</div>}</td>
          <td className="mono">{item.url}</td>
          <td>{item.protocol}</td>
          <td><Status value={item.status} /></td>
          <td>{item.attempts}</td>
          <td>{time(item.nextAttemptAt)}</td>
          <td>{item.status === "DEAD" && <button className="button secondary" disabled={retrying === item.id} onClick={() => void retry(item.id)}>重试</button>}</td>
        </tr>)}</tbody>
      </table></div></section>
    </LoadingState>
  </>;
}
