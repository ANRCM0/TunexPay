"use client";

import { Card, Descriptions, Statistic, Tag } from "@arco-design/web-react";
import { Activity, Cpu, Database, Server, Workflow } from "lucide-react";
import type { ReactNode } from "react";
import { useApi } from "../lib/api";
import { LoadingState, PageHead, statusText, time } from "./common";

type Subsystem = { ok: boolean; latencyMs?: number; version?: string; error?: string };
type SystemStatus = {
  api: { version: string; nodeEnv: string; startedAt: string; uptimeSeconds: number };
  mysql: Subsystem;
  redis: Subsystem;
  worker: { status: string; heartbeatAt: string | null; ageSeconds: number | null };
  webhookQueue: { ok: boolean; waiting?: number; active?: number; delayed?: number; failed?: number };
  tasks: { pendingWebhooks: number; deadWebhooks: number; recoveringPayments: number; pendingRefunds: number; openPaymentExceptions: number; nextTaskAt: string | null };
};

/** Arco 2.x 的 Descriptions 只认 data 属性（没有 Descriptions.Item），这里给它一个最小行类型。 */
type DescRow = { key: string; label: string; value: ReactNode };

// 监控页不是列表页：没有筛选和分页，用 Card 把 api / mysql / redis / worker / 队列 / 任务
// 六块状态摊平，横向的「字段 / 值」交给 Descriptions，比手写表格少一层自定义样式。
const TAG_COLOR = { ok: "green", warn: "orange", danger: "red" } as const;
type Tone = keyof typeof TAG_COLOR;

/** 状态色只用三档：绿=正常、橙=需要留意、红=异常，避免每加一种状态就多一种颜色。 */
function ToneTag({ tone, text, code }: { tone: Tone; text: string; code?: string }) {
  // code 放进 title：徽章显示中文，鼠标悬停仍能看到 RUNNING / STALE 这类接口原值
  // （与 common.tsx 的 Status 徽章把原值挂在 title 上的做法保持一致）。
  return <Tag color={TAG_COLOR[tone]} title={code}>{text}</Tag>;
}

// 数值型指标保留原有的配色语义（等待中=默认、投递中=绿、退避=橙、失败=红）
const VALUE_COLOR: Record<Tone, string> = { ok: "var(--success)", warn: "var(--warning)", danger: "var(--danger)" };

function QueueStat({ label, value, note, tone }: { label: string; value: number; note: string; tone?: Tone }) {
  return <Statistic
    title={label}
    value={value}
    suffix="条"
    styleValue={tone ? { color: VALUE_COLOR[tone] } : undefined}
    extra={<span className="stat-note">{note}</span>}
  />;
}

// Worker 的状态码有六种，但用户只关心三档：还在跑 / 要留意 / 已经停了。
// STALE 与 STARTING 都属于"还没确认健康"，所以算橙色而不是红色。
function workerTone(status: string): Tone {
  if (status === "RUNNING" || status === "ONLINE") return "ok";
  if (status === "STALE" || status === "STARTING" || status === "IDLE") return "warn";
  return "danger";
}

function cardTitle(icon: ReactNode, text: string) {
  return <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>{icon}{text}</span>;
}

export function System() {
  // 轮询间隔保持 5 秒：监控页的价值就在于"看到的就是此刻的状态"，
  // 复用 useApi 的轮询护栏（后台标签页暂停、慢响应不叠加请求）。
  const { data, loading, error } = useApi<SystemStatus>("/system", 5_000);
  return <>
    <PageHead eyebrow="System Status" title="系统监控" copy="API、数据库、Redis 与后台 Worker 的运行状态，每 5 秒自动刷新。" />
    <LoadingState loading={loading} error={error} stale={Boolean(data)}>
      {data && <SystemCards data={data} />}
    </LoadingState>
  </>;
}

function SystemCards({ data }: { data: SystemStatus }) {
  // 错误行只在真的出错时出现：正常状态下留着一条"—"只会让人误以为"这一项没数据"
  const mysqlRows: DescRow[] = [
    { key: "version", label: "版本", value: data.mysql.ok ? data.mysql.version ?? "—" : "连接失败" },
    { key: "latency", label: "查询延迟", value: data.mysql.ok ? `${data.mysql.latencyMs} ms` : "—" },
    ...(data.mysql.error ? [{ key: "error", label: "错误", value: <span className="mono">{data.mysql.error}</span> }] : []),
  ];
  const redisRows: DescRow[] = [
    { key: "usage", label: "用途", value: "Webhook 队列与 Worker 心跳" },
    { key: "latency", label: "Ping 延迟", value: data.redis.ok ? `${data.redis.latencyMs} ms` : "—" },
    ...(data.redis.error ? [{ key: "error", label: "错误", value: <span className="mono">{data.redis.error}</span> }] : []),
  ];
  const taskRows: DescRow[] = [
    taskRow("待处理 Webhook 投递", `${data.tasks.pendingWebhooks} 条`, data.tasks.pendingWebhooks > 100),
    taskRow("重试耗尽（DEAD）", `${data.tasks.deadWebhooks} 条`, data.tasks.deadWebhooks > 0),
    taskRow("恢复中支付", `${data.tasks.recoveringPayments} 笔`),
    taskRow("待人工查单退款", `${data.tasks.pendingRefunds} 笔`),
    taskRow("待处理支付异常", `${data.tasks.openPaymentExceptions} 条`, data.tasks.openPaymentExceptions > 0),
  ];

  return <div className="channel-grid">
    <Card bordered title={cardTitle(<Server size={16} aria-hidden="true" />, "API 进程")} extra={<ToneTag tone="ok" text="OK" />}>
      <Descriptions column={1} data={[
        { key: "version", label: "版本", value: `v${data.api.version}` },
        { key: "env", label: "运行环境", value: data.api.nodeEnv },
        { key: "uptime", label: "运行时长", value: uptime(data.api.uptimeSeconds) },
        { key: "startedAt", label: "启动时间", value: time(data.api.startedAt) },
      ]} />
    </Card>

    <Card
      bordered
      title={cardTitle(<Database size={16} aria-hidden="true" />, "MySQL")}
      extra={<ToneTag tone={data.mysql.ok ? "ok" : "danger"} text={data.mysql.ok ? "OK" : "异常"} />}
    >
      <Descriptions column={1} data={mysqlRows} />
    </Card>

    <Card
      bordered
      title={cardTitle(<Cpu size={16} aria-hidden="true" />, "Redis")}
      extra={<ToneTag tone={data.redis.ok ? "ok" : "danger"} text={data.redis.ok ? "OK" : "异常"} />}
    >
      <Descriptions column={1} data={redisRows} />
    </Card>

    <Card
      bordered
      title={cardTitle(<Workflow size={16} aria-hidden="true" />, "Worker")}
      // 状态文案沿用 common.tsx 的 statusText，页面与徽章说的是同一套词
      extra={<ToneTag tone={workerTone(data.worker.status)} text={statusText(data.worker.status)} code={data.worker.status} />}
    >
      <Descriptions column={1} data={[
        { key: "usage", label: "用途", value: "投递 / 恢复 / 过期 / 采集调度" },
        { key: "heartbeat", label: "最近心跳", value: data.worker.heartbeatAt ? time(data.worker.heartbeatAt) : "—" },
        { key: "age", label: "心跳年龄", value: data.worker.ageSeconds !== null ? `${data.worker.ageSeconds} 秒` : "—" },
      ]} />
    </Card>

    {/* 队列与任务信息横向更宽，独占整行；内联 gridColumn 是为了不改动已冻结的 admin.css */}
    <Card
      bordered
      style={{ gridColumn: "1 / -1" }}
      title={cardTitle(<Activity size={16} aria-hidden="true" />, "Webhook 队列")}
      extra={<span className="muted">BullMQ · tuoxin-pay-webhooks</span>}
    >
      {data.webhookQueue.ok ? <div className="grid stats">
        <QueueStat label="等待中" value={data.webhookQueue.waiting ?? 0} note="已进入队列待投递" />
        <QueueStat tone="ok" label="投递中" value={data.webhookQueue.active ?? 0} note="正在向业务方发送" />
        <QueueStat tone="warn" label="延迟重试" value={data.webhookQueue.delayed ?? 0} note="退避等待下次执行" />
        <QueueStat tone="danger" label="失败滞留" value={data.webhookQueue.failed ?? 0} note="可在 Webhook 页面手动重试" />
      </div> : <div className="empty compact">队列数据不可用（Redis 连接失败）</div>}
    </Card>

    <Card
      bordered
      style={{ gridColumn: "1 / -1" }}
      title={cardTitle(<Activity size={16} aria-hidden="true" />, "后台任务")}
      extra={<span className="muted"><Activity size={12} aria-hidden="true" style={{ marginBottom: -1 }} /> 下次到期 {data.tasks.nextTaskAt ? time(data.tasks.nextTaskAt) : "暂无"}</span>}
    >
      <Descriptions column={1} data={taskRows} />
    </Card>
  </div>;
}

// 超过阈值的任务数标红：这是"需要有人去看一眼"的信号，不能被淹没在一串正常数字里
function taskRow(label: string, value: string, warn = false): DescRow {
  return { key: label, label, value: <strong className={warn ? "row-error" : undefined}>{value}</strong> };
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
