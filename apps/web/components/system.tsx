"use client";

import { Activity, Cpu, Database, Server, Workflow } from "lucide-react";
import { useApi } from "../lib/api";
import { LoadingState, PageHead, Section, Stat, Status, time } from "./common";

type Subsystem = { ok: boolean; latencyMs?: number; version?: string; error?: string };
type SystemStatus = {
  api: { version: string; nodeEnv: string; startedAt: string; uptimeSeconds: number };
  mysql: Subsystem;
  redis: Subsystem;
  worker: { status: string; heartbeatAt: string | null; ageSeconds: number | null };
  webhookQueue: { ok: boolean; waiting?: number; active?: number; delayed?: number; failed?: number };
  tasks: { pendingWebhooks: number; deadWebhooks: number; recoveringPayments: number; recoveringRefunds: number; openPaymentExceptions: number; nextTaskAt: string | null };
};

export function System() {
  const { data, loading, error } = useApi<SystemStatus>("/system", 5_000);
  return <>
    <PageHead eyebrow="System Status" title="系统监控" copy="API、数据库、Redis 与后台 Worker 的运行状态，每 5 秒自动刷新。" />
    <LoadingState loading={loading} error={error}>
      {data && <>
        <div className="channel-grid">
          <section className="card channel-card">
            <div className="channel-head"><div><div className="channel-icon mock"><Server size={19} /></div><div><h2>API 进程</h2><span>v{data.api.version} · {data.api.nodeEnv}</span></div></div><Status value="ACTIVE" /></div>
            <div className="channel-meta"><span>运行时长</span><code>{uptime(data.api.uptimeSeconds)}</code><span>启动时间</span><code>{time(data.api.startedAt)}</code></div>
          </section>

          <section className="card channel-card">
            <div className="channel-head"><div><div className="channel-icon alipay"><Database size={19} /></div><div><h2>MySQL</h2><span>{data.mysql.ok ? data.mysql.version : "连接失败"}</span></div></div><Status value={data.mysql.ok ? "ACTIVE" : "FAILED"} /></div>
            <div className="channel-meta"><span>查询延迟</span><code>{data.mysql.ok ? `${data.mysql.latencyMs} ms` : "—"}</code>{data.mysql.error && <><span>错误</span><code>{data.mysql.error}</code></>}</div>
          </section>

          <section className="card channel-card">
            <div className="channel-head"><div><div className="channel-icon alipay"><Cpu size={19} /></div><div><h2>Redis</h2><span>Webhook 队列与 Worker 心跳</span></div></div><Status value={data.redis.ok ? "ACTIVE" : "FAILED"} /></div>
            <div className="channel-meta"><span>Ping 延迟</span><code>{data.redis.ok ? `${data.redis.latencyMs} ms` : "—"}</code>{data.redis.error && <><span>错误</span><code>{data.redis.error}</code></>}</div>
          </section>

          <section className="card channel-card">
            <div className="channel-head"><div><div className="channel-icon mock"><Workflow size={19} /></div><div><h2>Worker</h2><span>投递 / 恢复 / 过期 / 采集调度</span></div></div><Status value={data.worker.status} /></div>
            <div className="channel-meta"><span>最近心跳</span><code>{data.worker.heartbeatAt ? time(data.worker.heartbeatAt) : "—"}</code><span>心跳年龄</span><code>{data.worker.ageSeconds !== null ? `${data.worker.ageSeconds} 秒` : "—"}</code></div>
          </section>
        </div>

        <Section title="Webhook 队列" action={<span className="muted">BullMQ · tuoxin-pay-webhooks</span>} className="detail-section">
          {data.webhookQueue.ok ? <div className="grid stats">
            <Stat label="等待中" value={String(data.webhookQueue.waiting)} note="已进入队列待投递" />
            <Stat tone="green" label="投递中" value={String(data.webhookQueue.active)} note="正在向业务方发送" />
            <Stat tone="orange" label="延迟重试" value={String(data.webhookQueue.delayed)} note="退避等待下次执行" />
            <Stat tone="red" label="失败滞留" value={String(data.webhookQueue.failed)} note="可在 Webhook 页面手动重试" />
          </div> : <div className="empty compact">队列数据不可用（Redis 连接失败）</div>}
        </Section>

        <Section title="后台任务" action={<span className="muted"><Activity size={12} style={{ marginBottom: -1 }} /> 下次到期 {data.tasks.nextTaskAt ? time(data.tasks.nextTaskAt) : "暂无"}</span>} className="detail-section">
          <div className="detail-list">
            <Row label="待处理 Webhook 投递" value={`${data.tasks.pendingWebhooks} 条`} warn={data.tasks.pendingWebhooks > 100} />
            <Row label="重试耗尽（DEAD）" value={`${data.tasks.deadWebhooks} 条`} warn={data.tasks.deadWebhooks > 0} />
            <Row label="恢复中支付" value={`${data.tasks.recoveringPayments} 笔`} />
            <Row label="恢复中退款" value={`${data.tasks.recoveringRefunds} 笔`} />
            <Row label="待处理支付异常" value={`${data.tasks.openPaymentExceptions} 条`} warn={data.tasks.openPaymentExceptions > 0} />
          </div>
        </Section>
      </>}
    </LoadingState>
  </>;
}

function Row({ label, value, warn = false }: { label: string; value: string; warn?: boolean }) {
  return <div className="detail-row"><span>{label}</span><strong className={warn ? "row-error" : ""}>{value}</strong></div>;
}

function uptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  if (minutes > 0) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${seconds} 秒`;
}
