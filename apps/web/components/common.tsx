export function PageHead({ eyebrow, title, copy, action }: { eyebrow: string; title: string; copy: string; action?: React.ReactNode }) {
  return <header className="page-head"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p className="page-copy">{copy}</p></div>{action}</header>;
}

export function Section({ title, action, className = "", style, children }: { title: string; action?: React.ReactNode; className?: string; style?: React.CSSProperties; children: React.ReactNode }) {
  return <section className={`card section ${className}`.trim()} style={style}>
    <div className="section-title"><h2>{title}</h2>{action}</div>
    {children}
  </section>;
}

export function Stat({ label, value, note, detail = false }: { label: string; value: React.ReactNode; note: string; detail?: boolean }) {
  return <div className="card stat">
    <div className="stat-label">{label}</div>
    <div className={detail ? "stat-value detail-value" : "stat-value"}>{value}</div>
    <div className="stat-note">{note}</div>
  </div>;
}

type Tone = "success" | "warning" | "danger" | "neutral";

const STATUS_TONE: Record<string, Tone> = {
  ACTIVE: "success",
  SUCCESS: "success",
  MATCHED: "success",
  PENDING: "warning",
  PROCESSING: "warning",
  UNKNOWN: "warning",
  UNMATCHED: "warning",
  FAILED: "danger",
  DEAD: "danger",
  DISABLED: "danger",
  MISMATCH: "danger",
  OPEN: "danger",
  CREATED: "neutral",
  CLOSED: "neutral",
  PARTIALLY_REFUNDED: "neutral",
  REFUNDED: "neutral",
  IGNORED: "neutral",
  RESOLVED: "neutral",
};

export function Status({ value }: { value: string }) {
  const tone = STATUS_TONE[value] ?? "neutral";
  return <span className={`badge badge-${tone}`} title={value}>{statusText(value)}</span>;
}

export function LoadingState({ loading, error, empty, children }: { loading: boolean; error: string; empty?: boolean; children: React.ReactNode }) {
  if (loading) return <div className="card loading">正在加载…</div>;
  if (error) return <div className="card error">{error}</div>;
  if (empty) return <div className="card empty">暂无数据</div>;
  return <>{children}</>;
}

export function money(cents: number) { return `¥${(cents / 100).toFixed(2)}`; }
export function time(value: string | null | undefined) { return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—"; }

const statusLabels: Record<string, string> = {
  ACTIVE: "启用",
  DISABLED: "停用",
  CREATED: "已创建",
  PENDING: "待支付",
  PROCESSING: "处理中",
  SUCCESS: "成功",
  FAILED: "失败",
  UNKNOWN: "结果未知",
  CLOSED: "已关闭",
  PARTIALLY_REFUNDED: "部分退款",
  REFUNDED: "已退款",
  DEAD: "重试耗尽",
  MATCHED: "已匹配",
  MISMATCH: "存在差错",
  UNMATCHED: "未匹配",
  IGNORED: "已忽略",
  OPEN: "待处理",
  RESOLVED: "已解决",
};

export function statusText(value: string) { return statusLabels[value] ?? value; }
