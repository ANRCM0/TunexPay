"use client";

import { useMemo, useState } from "react";
import { api, useApi } from "../lib/api";
import { nextSortState, sortRows, type SortColumn } from "../lib/sort";
import { CopyValue, HoverDetail, LoadingState, PageHead, SortableTh, Status, Toast, sortValueProps, time } from "./common";
import { protocolLabel, webhookEventLabel } from "../lib/labels";

type Delivery = { id: string; eventType: string; protocol: string; url: string; status: string; attempts: number; lastError: string | null; nextAttemptAt: string; application: { name: string }; order: { orderNo: string; externalOrderNo: string } };

const SORT_COLUMNS: SortColumn<Delivery>[] = [
  { key: "eventType", label: "事件 / 订单" },
  { key: "url", label: "目标地址" },
  { key: "protocol", label: "协议" },
  { key: "status", label: "状态" },
  { key: "attempts", label: "尝试", type: "number" },
  { key: "nextAttemptAt", label: "下次执行", type: "date" },
];

export function Webhooks() {
  const { data, loading, error, reload } = useApi<Delivery[]>("/webhooks?pageSize=100", 8_000);
  const [sort, setSort] = useState(() => null as ReturnType<typeof nextSortState>);
  const [retrying, setRetrying] = useState("");
  const [notice, setNotice] = useState<{ type: "ok" | "error"; text: string } | null>(null);
  const rows = useMemo(() => sortRows(data ?? [], SORT_COLUMNS, sort), [data, sort]);

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
        <thead><tr>
            <SortableTh label="事件 / 订单" sortKey="eventType" sort={sort} onSort={key => setSort(nextSortState(sort, key))} />
            <SortableTh label="目标地址" sortKey="url" sort={sort} onSort={key => setSort(nextSortState(sort, key))} />
            <SortableTh label="协议" sortKey="protocol" sort={sort} onSort={key => setSort(nextSortState(sort, key))} />
            <SortableTh label="状态" sortKey="status" sort={sort} onSort={key => setSort(nextSortState(sort, key))} />
            <SortableTh label="尝试" sortKey="attempts" sort={sort} onSort={key => setSort(nextSortState(sort, key))} />
            <SortableTh label="下次执行" sortKey="nextAttemptAt" sort={sort} onSort={key => setSort(nextSortState(sort, key))} />
            <th scope="col">操作</th>
          </tr></thead>
        <tbody>{rows.map(item => <tr key={item.id}>
          <td {...sortValueProps(item, SORT_COLUMNS[0])}>
            <strong>{webhookEventLabel(item.eventType.split(":")[0])}</strong>
            <div className="mono muted">{item.eventType}</div>
            <div className="id-line"><span className="mono muted">{item.order.externalOrderNo}</span><CopyValue value={item.order.externalOrderNo} label="复制业务订单号" /></div>
          </td>
          <td data-label="目标地址" {...sortValueProps(item, SORT_COLUMNS[1])}><div className="id-line"><span className="mono break-all">{item.url}</span><CopyValue value={item.url} label="复制 Webhook 地址" /></div></td>
          <td data-label="协议" {...sortValueProps(item, SORT_COLUMNS[2])}>{protocolLabel(item.protocol)}</td>
          <td data-label="状态" {...sortValueProps(item, SORT_COLUMNS[3])}><HoverDetail text={item.lastError} tone="danger"><Status value={item.status} /></HoverDetail></td>
          <td data-label="尝试" {...sortValueProps(item, SORT_COLUMNS[4])}>{item.attempts}</td>
          <td data-label="下次执行" {...sortValueProps(item, SORT_COLUMNS[5])}>{time(item.nextAttemptAt)}</td>
          <td data-label="操作">{item.status === "DEAD" && <button className="button secondary" disabled={retrying !== ""} onClick={() => void retry(item.id)}>{retrying === item.id ? "重试中…" : "重新投递"}</button>}</td>
        </tr>)}</tbody>
      </table></div></section>
    </LoadingState>
  </>;
}
