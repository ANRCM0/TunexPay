"use client";

import { LoadingState, PageHead, money, time } from "./common";
import { useApi } from "../lib/api";

type Event = { id: string; type: string; source: string; aggregateId: string; createdAt: string };
type Dashboard = { applications: number; ordersToday: number; successfulToday: number; amountToday: number; unknownPayments: number; pendingWebhooks: number; recentEvents: Event[] };

export function Dashboard() {
  const { data, loading, error } = useApi<Dashboard>("/dashboard", 10_000);
  return <>
    <PageHead eyebrow="Operations" title="支付运行总览" copy="今天的交易、异常状态和通知投递，集中在这一页。" />
    <LoadingState loading={loading} error={error}>
      {data && <>
        <div className="grid stats">
          <Stat label="今日订单" value={String(data.ordersToday)} note={`${data.successfulToday} 笔支付成功`} />
          <Stat label="今日实收" value={money(data.amountToday)} note="仅统计成功支付" />
          <Stat label="结果未知" value={String(data.unknownPayments)} note="需要主动查单" />
          <Stat label="通知待处理" value={String(data.pendingWebhooks)} note={`${data.applications} 个活跃应用`} />
        </div>
        <section className="card section">
          <div className="section-title"><h2>最近业务事件</h2><span className="muted">自动刷新</span></div>
          <div className="timeline">{data.recentEvents.map(event => <div className="timeline-item" key={event.id}>
            <div className="timeline-type">{event.type}</div>
            <div className="timeline-meta"><span className="mono">{event.aggregateId}</span> · {event.source} · {time(event.createdAt)}</div>
          </div>)}</div>
        </section>
      </>}
    </LoadingState>
  </>;
}

function Stat({ label, value, note }: { label: string; value: string; note: string }) {
  return <div className="card stat"><div className="stat-label">{label}</div><div className="stat-value">{value}</div><div className="stat-note">{note}</div></div>;
}
