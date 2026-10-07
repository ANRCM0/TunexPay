"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { LoadingState, Section, Stat, money, time, type StatTone } from "./common";
import { useApi } from "../lib/api";
import { eventLabel, eventSourceLabel, eventTone } from "../lib/labels";

type Event = { id: string; type: string; source: string; aggregateId: string; createdAt: string };
type Dashboard = {
  applications: number; ordersToday: number; successfulToday: number; amountToday: number; unknownPayments: number; pendingWebhooks: number;
  recoveringPayments: number; pendingRefunds: number; exhaustedRecoveries: number; unmatchedReceipts: number; mismatchedReceipts: number;
  openPaymentExceptions: number; expirationFailures: number; failedAdminActionsToday: number; recentEvents: Event[];
};

type AlertItem = { label: string; value: number; note: string; tone: StatTone; href: string };

function alertItems(data: Dashboard): AlertItem[] {
  const all: AlertItem[] = [
    { label: "需要人工处理", value: data.exhaustedRecoveries, note: "自动查单已达到上限", tone: "red", href: "/system" },
    { label: "支付异常", value: data.openPaymentExceptions, note: "待核实、退款或人工关闭", tone: "red", href: "/exceptions" },
    { label: "对账差错", value: data.mismatchedReceipts, note: "金额或流水号冲突", tone: "red", href: "/reconciliation" },
    { label: "今日管理失败", value: data.failedAdminActionsToday, note: "可在操作审计中查看", tone: "red", href: "/audits" },
    { label: "结果未知", value: data.unknownPayments, note: "需要主动查单", tone: "orange", href: "/orders" },
    { label: "待人工查单退款", value: data.pendingRefunds, note: "退款不再自动查单", tone: "orange", href: "/refunds" },
    { label: "未匹配账单", value: data.unmatchedReceipts, note: "等待订单或退款单出现", tone: "orange", href: "/reconciliation" },
    { label: "过期关闭异常", value: data.expirationFailures, note: "Worker 将自动退避重试", tone: "orange", href: "/orders" },
  ];
  return all.filter(item => item.value > 0);
}

export function Dashboard() {
  const { data, loading, error } = useApi<Dashboard>("/dashboard", 10_000);
  const alerts = data ? alertItems(data) : [];
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  // 仅成功获取新数据时更新时间，避免普通重渲染把旧数据误报为最新。
  useEffect(() => { if (data) setLastUpdatedAt(new Date().toISOString()); }, [data]);
  const riskTone = alerts.some(item => item.tone === "red") ? "tone-bad" : alerts.length ? "tone-warn" : "tone-ok";
  return <>
    <section className="card hero-card">
      <div className="hero-main">
        <div className="eyebrow">Operations</div>
        <h1>支付运行总览</h1>
        <p className="page-copy">今天的交易、异常状态和通知投递，集中在这一页。</p>
      </div>
      <div className="hero-status">
        <div className="hero-status-item">
          <span>风险提醒</span>
          <strong className={error ? "tone-bad" : data ? riskTone : undefined}>
            {error ? "刷新失败" : data ? (alerts.length ? `${alerts.length} 类待关注` : "暂无待办") : "—"}
          </strong>
        </div>
        <div className="hero-status-item">
          <span>活跃应用</span>
          <strong>{data ? `${data.applications} 个` : "—"}</strong>
        </div>
        <div className="hero-status-foot muted">
          {lastUpdatedAt ? `${error ? "上次成功更新" : "数据更新于"} ${time(lastUpdatedAt)}` : error ? "暂时无法读取数据" : "正在读取运行状态"}
        </div>
        {data && !error && alerts.length > 0 && <span className="hero-badge">可进入对应页面查看详情</span>}
      </div>
    </section>
    <LoadingState loading={loading} error={error}>
      {data && <>
        <div className="grid stats">
          <Stat label="今日订单" value={String(data.ordersToday)} note={`${data.successfulToday} 笔支付成功`} />
          <Stat tone="green" label="今日实收" value={money(data.amountToday)} note="仅统计成功支付" />
          <Stat label="自动恢复中" value={String(data.recoveringPayments)} note="仅支付单自动查单" />
          <Stat label="通知待处理" value={String(data.pendingWebhooks)} note={`${data.applications} 个活跃应用`} />
        </div>
        {alerts.length
          ? <div className="alert-strip">
            <div className="alert-strip-head">需要关注<span className="alert-count">{alerts.length} 类提醒</span></div>
            <div className="grid alert-grid">{alerts.map(item => <Link key={item.label} href={item.href} className="alert-action-card">
              <Stat tone={item.tone} label={item.label} value={String(item.value)} note={item.note} />
              <span className="alert-action-link" aria-hidden="true">查看相关页面 ↗</span>
            </Link>)}</div>
          </div>
          : <div className="card stat-clear">当前没有需要人工处理的异常</div>}
        <Section title="最近业务事件" action={<span className="muted">{data.recentEvents.length} 条 · 自动刷新</span>}>
          {data.recentEvents.length ? <div className="timeline">{data.recentEvents.map(event => <div className={`timeline-item tone-${eventTone(event.type)}`} key={event.id}>
            <div className="timeline-type">{eventLabel(event.type)}</div>
            <div className="timeline-meta"><span className="mono">{event.aggregateId}</span> · {eventSourceLabel(event.source)} · {time(event.createdAt)}</div>
          </div>)}</div> : <div className="empty compact">暂无业务事件</div>}
        </Section>
      </>}
    </LoadingState>
  </>;
}
