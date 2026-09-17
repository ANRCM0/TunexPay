import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import { channelLabel } from "../lib/labels";

// 对话框统一行为：Esc 关闭、打开时接管焦点、Tab 在对话框内循环、关闭后把焦点还给原来的触发元素
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

function useDialog(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current;
    node?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { closeRef.current(); return; }
      if (event.key !== "Tab" || !node) return;
      const items = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (!items.length) { event.preventDefault(); node.focus(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (!active || !node.contains(active)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); return; }
      if (event.shiftKey && active === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      previous?.focus?.();
    };
  }, []);
  return ref;
}

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
  return <span className={`tag ${CHANNEL_TAG_STYLE[code] ?? "tag-gray"}`} title={code}>{channelLabel(code)}</span>;
}

export function Drawer({ title, onClose, wide = false, children }: { title: string; onClose: () => void; wide?: boolean; children: React.ReactNode }) {
  const ref = useDialog(onClose);
  return <div className="drawer-mask" onClick={onClose}>
    <div ref={ref} tabIndex={-1} className={wide ? "drawer drawer-wide" : "drawer"} onClick={event => event.stopPropagation()} role="dialog" aria-modal="true" aria-label={title}>
      <div className="drawer-head"><h2>{title}</h2><button className="drawer-close" onClick={onClose} aria-label="关闭"><X size={18} /></button></div>
      <div className="drawer-body">{children}</div>
    </div>
  </div>;
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const ref = useDialog(onClose);
  return <div className="drawer-mask modal-mask" onClick={onClose}>
    <div ref={ref} tabIndex={-1} className="modal" onClick={event => event.stopPropagation()} role="dialog" aria-modal="true" aria-label={title}>
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
  RUNNING: "success",
  PENDING: "warning",
  PROCESSING: "warning",
  UNKNOWN: "warning",
  UNMATCHED: "warning",
  STALE: "warning",
  STARTING: "warning",
  FAILED: "danger",
  ERROR: "danger",
  DEAD: "danger",
  DISABLED: "danger",
  MISMATCH: "danger",
  OPEN: "danger",
  OFFLINE: "danger",
  CREATED: "neutral",
  IDLE: "neutral",
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
  if (loading) return <div className="card loading" role="status">正在加载…</div>;
  if (error) return <div className="card error" role="alert">{error}</div>;
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
  RUNNING: "运行中",
  STALE: "心跳延迟",
  STARTING: "首次启动",
  ERROR: "出错",
  OFFLINE: "离线",
  IDLE: "空闲待命",
};

export function statusText(value: string) { return statusLabels[value] ?? value; }
