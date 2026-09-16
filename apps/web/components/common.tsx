import { X } from "lucide-react";

export function PageHead({ eyebrow, title, copy, action }: { eyebrow: string; title: string; copy: string; action?: React.ReactNode }) {
  return <header className="page-head"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p className="page-copy">{copy}</p></div>{action}</header>;
}

export function Section({ title, action, className = "", style, children }: { title: string; action?: React.ReactNode; className?: string; style?: React.CSSProperties; children: React.ReactNode }) {
  return <section className={`card section ${className}`.trim()} style={style}>
    <div className="section-title"><h2>{title}</h2>{action}</div>
    {children}
  </section>;
}

export type StatTone = "blue" | "green" | "red" | "orange";

export function Stat({ label, value, note, detail = false, tone = "blue" }: { label: string; value: React.ReactNode; note: string; detail?: boolean; tone?: StatTone }) {
  return <div className={`card stat stat-${tone}`}>
    <div className="stat-label">{label}</div>
    <div className={detail ? "stat-value detail-value" : "stat-value"}>{value}</div>
    <div className="stat-note">{note}</div>
  </div>;
}

export function Toggle({ checked, onChange, label, disabled = false }: { checked: boolean; onChange: (value: boolean) => void; label: string; disabled?: boolean }) {
  return <button type="button" role="switch" aria-checked={checked} className={`toggle${checked ? " on" : ""}`} disabled={disabled} onClick={() => onChange(!checked)}>
    <span className="toggle-knob" /><span className="toggle-label">{label}</span>
  </button>;
}

const CHANNEL_TAG_STYLE: Record<string, string> = { ALIPAY: "tag-blue", ALIPAY_BILL: "tag-green", MOCK: "tag-gray" };

export function ChannelTag({ code }: { code: string }) {
  return <span className={`tag ${CHANNEL_TAG_STYLE[code] ?? "tag-gray"}`}>{code}</span>;
}

export function Drawer({ title, onClose, wide = false, children }: { title: string; onClose: () => void; wide?: boolean; children: React.ReactNode }) {
  return <div className="drawer-mask" onClick={onClose}>
    <div className={wide ? "drawer drawer-wide" : "drawer"} onClick={event => event.stopPropagation()} role="dialog" aria-label={title}>
      <div className="drawer-head"><h2>{title}</h2><button className="drawer-close" onClick={onClose} aria-label="关闭"><X size={18} /></button></div>
      <div className="drawer-body">{children}</div>
    </div>
  </div>;
}

export function Tabs({ items, active, onChange }: { items: readonly string[]; active: string; onChange: (item: string) => void }) {
  return <div className="tabs">{items.map(item => <button key={item} type="button" className={item === active ? "tabs-item active" : "tabs-item"} onClick={() => onChange(item)}>{item}</button>)}</div>;
}

type Tone = "success" | "warning" | "danger" | "neutral";

const STATUS_TONE: Record<string, Tone> = {
  ACTIVE: "success",
  SUCCESS: "success",
  MATCHED: "success",
  ONLINE: "success",
  PENDING: "warning",
  PROCESSING: "warning",
  UNKNOWN: "warning",
  UNMATCHED: "warning",
  STALE: "warning",
  FAILED: "danger",
  DEAD: "danger",
  DISABLED: "danger",
  MISMATCH: "danger",
  OPEN: "danger",
  OFFLINE: "danger",
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
  ONLINE: "在线",
  STALE: "心跳延迟",
  OFFLINE: "离线",
};

export function statusText(value: string) { return statusLabels[value] ?? value; }
