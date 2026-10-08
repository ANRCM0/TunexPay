import { AlertCircle, ArrowDown, ArrowUp, ArrowUpDown, Check, CheckCircle2, Copy, X } from "lucide-react";
import { Drawer as ArcoDrawer, Modal as ArcoModal } from "@arco-design/web-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { type SortColumn } from "../lib/sort";
import { channelLabel } from "../lib/labels";
import { refreshClientData } from "../lib/refresh";

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

type CopyState = "idle" | "copied" | "failed";

// 剪贴板 API 只在安全上下文可用：HTTP 或企业策略下可能直接抛错，
// 所以要显式回退到 execCommand，并且把它也当作可能失败的路径。
async function writeClipboard(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch { /* 落到下面的 execCommand 回退 */ }
  try {
    const node = document.createElement("textarea");
    node.value = value;
    node.setAttribute("readonly", "");
    node.style.position = "fixed";
    node.style.top = "0";
    node.style.opacity = "0";
    document.body.appendChild(node);
    node.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(node);
    return ok;
  } catch {
    return false;
  }
}

export function CopyValue({ value, label = "复制" }: { value: string; label?: string }) {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<number | null>(null);

  async function copy() {
    const ok = await writeClipboard(value);
    setState(ok ? "copied" : "failed");
    if (timer.current !== null) window.clearTimeout(timer.current);
    // 失败提示留久一点，用户才有机会读到；并用 ref 收尾，避免卸载后写 state。
    timer.current = window.setTimeout(() => setState("idle"), ok ? 1600 : 4000);
  }

  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);

  // 只有确认写进剪贴板才报成功：写不进去时必须显示失败与可操作提示，不能谎报「已复制」。
  const text = state === "copied" ? "已复制" : state === "failed" ? "复制失败" : label;
  // 提示走 title 而不是 aria-label：可见文本本身就是按钮的可访问名称，
  // 而这段可操作提示太长，不适合当作名字（按钮名里有句号会被逐字念出来）。
  const hint = state !== "failed"
    ? "复制到剪贴板"
    : "复制失败：浏览器拒绝了剪贴板访问。通过 HTTP 打开控制台时会出现这种情况，请改用 HTTPS 或手动选中复制。";
  return <button type="button" className="copy-value" onClick={() => void copy()} title={hint}>
    {state === "copied" ? <Check size={12} aria-hidden="true" /> : state === "failed" ? <AlertCircle size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
    {/* 实时区域就是这段可见文本本身：如果另建一个 sr-only 副本，读屏器会连念两遍 */}
    <span role="status" aria-live="polite">{text}</span>
  </button>;
}

export function Toast({ type = "ok", text, onClose }: { type?: "ok" | "error"; text: string; onClose: () => void }) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    // 错误通常包含排障信息，不能和简短成功提示一样很快消失。
    const lifetime = type === "error" ? Math.min(16_000, Math.max(8_000, 2_500 + text.length * 80)) : Math.min(8_000, Math.max(3_500, 1_500 + text.length * 55));
    const timer = window.setTimeout(() => closeRef.current(), lifetime);
    return () => window.clearTimeout(timer);
  }, [text, type]);

  return <div className={`toast toast-${type}`} role={type === "error" ? "alert" : "status"} aria-live="polite">
    <span className="toast-icon" aria-hidden="true">{type === "error" ? <AlertCircle size={17} /> : <CheckCircle2 size={17} />}</span>
    <span>{text}</span>
    <button type="button" onClick={onClose} aria-label="关闭提示"><X size={14} aria-hidden="true" /></button>
  </div>;
}

export function ConfirmModal({ title, copy, confirmLabel = "确认", danger = false, warning, working = false, onConfirm, onClose }: {
  title: string;
  copy: string;
  confirmLabel?: string;
  danger?: boolean;
  warning?: string;
  working?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return <Modal title={title} onClose={onClose} dismissible={!working}>
    <p className="dialog-copy">{copy}</p>
    {danger && <div className="dialog-warning">{warning || "这是影响当前交易状态的操作，请确认你已经核对支付单信息。"}</div>}
    <div className="dialog-actions">
      <button type="button" className={danger ? "button danger" : "button"} disabled={working} onClick={onConfirm}>{working ? "处理中…" : confirmLabel}</button>
      <button type="button" className="button secondary" disabled={working} onClick={onClose}>取消</button>
    </div>
  </Modal>;
}

export function Drawer({ title, onClose, wide = false, dismissible = true, children }: { title: string; onClose: () => void; wide?: boolean; dismissible?: boolean; children: React.ReactNode }) {
  // 换成 Arco 的 Drawer：焦点管理、Esc 关闭、遮罩点击都由组件库负责，
  // 与本项目原来手写的那套行为一致（Esc 关闭、打开时接管焦点、关闭后归还焦点）。
  return <ArcoDrawer
    className={wide ? "drawer-wide" : undefined}
    width={wide ? "min(960px, 100vw)" : 560}
    title={title}
    visible
    onCancel={onClose}
    footer={null}
    closable={dismissible}
    maskClosable={dismissible}
    escToExit={dismissible}
    unmountOnExit
  >{children}</ArcoDrawer>;
}

export function Modal({ title, onClose, dismissible = true, children }: { title: string; onClose: () => void; dismissible?: boolean; children: React.ReactNode }) {
  return <ArcoModal
    className="app-modal"
    title={title}
    visible
    onCancel={onClose}
    footer={null}
    closable={dismissible}
    maskClosable={dismissible}
    escToExit={dismissible}
    autoFocus
    focusLock
    alignCenter
    unmountOnExit
  >{children}</ArcoModal>;
}

// 标签页遵循 WAI-ARIA tabs 模式：只有当前标签可 Tab 聚焦（roving tabindex），
// 组内用方向键切换，Home / End 跳到首尾；否则键盘用户要逐个 Tab 才能走到下一个控件。
export function Tabs({ items, active, onChange }: { items: readonly string[]; active: string; onChange: (item: string) => void }) {
  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const keys = ["ArrowRight", "ArrowLeft", "Home", "End"];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const index = Math.max(0, items.indexOf(active));
    const next = event.key === "Home" ? 0
      : event.key === "End" ? items.length - 1
      : event.key === "ArrowRight" ? (index + 1) % items.length
      : (index - 1 + items.length) % items.length;
    onChange(items[next]);
    // 焦点跟着选中项走，符合 tabs 模式的预期
    event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
  }

  return <div className="tabs" role="tablist" onKeyDown={onKeyDown}>{items.map(item => <button
    key={item}
    type="button"
    role="tab"
    aria-selected={item === active}
    tabIndex={item === active ? 0 : -1}
    className={item === active ? "tabs-item active" : "tabs-item"}
    onClick={() => onChange(item)}
  >{item}</button>)}</div>;
}

/**
 * 给数据单元格标注该行在本列上的排序值。
 *
 * 为什么需要它：单元格里往往混着「复制」按钮、徽章和补充说明，纯文本无法代表排序依据。
 * 把它标出来，验证脚本（和以后的端到端测试）就能直接断言排序性质，而不用去猜文本
 * 里哪一段才是被排序的值。未排序的列不标注，避免留下无意义的空值。
 */
export function sortValueProps<T>(row: T, column: SortColumn<T> | undefined): { "data-sort-value"?: string } {
  if (!column) return {};
  const raw = column.accessor ? column.accessor(row) : (row as Record<string, unknown> | null)?.[column.key];
  if (raw === null || raw === undefined || raw === "") return {};
  return { "data-sort-value": String(raw) };
}

/**
 * 可排序表头。整格就是一个按钮，点击/回车/空格都能触发，命中区域比文字大；
 * `aria-sort` 放在 th 上（ARIA 要求），按钮的 aria-label 说明下一步会做什么。
 */
export function SortableTh({ label, sortKey, sort, onSort, alignRight = false }: {
  label: string;
  sortKey: string;
  /** 当前排序状态，null 表示未排序。 */
  sort: { key: string; direction: "asc" | "desc" } | null;
  onSort: (key: string) => void;
  /** 与 .amount-cell 右对齐的列保持一致。 */
  alignRight?: boolean;
}) {
  const active = sort?.key === sortKey;
  const direction = active ? sort!.direction : null;
  const ariaSort = direction === "asc" ? "ascending" : direction === "desc" ? "descending" : "none";
  const nextHint = direction === "asc" ? "切换为降序" : direction === "desc" ? "取消排序" : "按此列升序排序";

  return <th scope="col" aria-sort={ariaSort} className={alignRight ? "th-sort th-right" : "th-sort"}>
    <button type="button" className={active ? "th-sort-button active" : "th-sort-button"} onClick={() => onSort(sortKey)} aria-label={`${label}，${nextHint}`}>
      <span>{label}</span>
      <span className="th-sort-icon" aria-hidden="true">{direction === "asc" ? <ArrowUp size={12} /> : direction === "desc" ? <ArrowDown size={12} /> : <ArrowUpDown size={12} />}</span>
    </button>
  </th>;
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
  REJECTED: "danger",
  ERROR: "danger",
  DEAD: "danger",
  DISABLED: "danger",
  MISMATCH: "danger",
  OPEN: "danger",
  OFFLINE: "danger",
  CREATED: "neutral",
  APPROVED: "warning",
  EXECUTED: "success",
  EXPIRED: "neutral",
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

// 单元格里的次要信息（失败原因、验证说明）默认不占版面，悬浮或键盘聚焦时才浮出。
// 浮层用 fixed 定位：.table-wrap 是 overflow: auto，绝对定位的浮层会被裁掉。
export function HoverDetail({ text, tone = "muted", children }: { text?: string | null; tone?: "muted" | "danger"; children: React.ReactNode }) {
  const [position, setPosition] = useState<React.CSSProperties | null>(null);
  const anchor = useRef<HTMLSpanElement>(null);

  const show = useCallback(() => {
    const node = anchor.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const width = Math.min(340, window.innerWidth - 24);
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
    // 下方放不下就翻到上方；用 bottom 定位就不必预先知道浮层高度
    setPosition(window.innerHeight - rect.bottom > 180
      ? { left, width, top: rect.bottom + 8 }
      : { left, width, bottom: window.innerHeight - rect.top + 8 });
  }, []);

  const hide = useCallback(() => setPosition(null), []);

  useEffect(() => {
    if (!position) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setPosition(null); };
    // 浮层是 fixed 的，页面滚动或改尺寸后会脱离锚点，直接收起而不是跟随错位
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [position, hide]);

  if (!text) return <>{children}</>;

  return <span
    ref={anchor}
    className={`hover-detail tone-${tone}`}
    tabIndex={0}
    aria-label={text}
    onMouseEnter={show}
    onMouseLeave={hide}
    onFocus={show}
    onBlur={hide}
  >
    {children}
    {position && <span className="hover-detail-pop" role="tooltip" style={position}>{text}</span>}
  </span>;
}

export function LoadingState({ loading, error, empty, emptyText = "暂无数据", stale = false, children }: { loading: boolean; error: string; empty?: boolean; emptyText?: string; stale?: boolean; children: React.ReactNode }) {
  if (loading) return <div className="card skeleton-card" role="status" aria-label="正在加载"><div className="skeleton skeleton-title" /><div className="skeleton skeleton-line" /><div className="skeleton skeleton-line short" /></div>;
  // 只有明确确认有旧数据的页面才在错误时保留内容；避免初始化失败时显示可操作的空表单。
  if (error) return <>
    <div className="operation-notice error load-error-notice" role="alert">
      <div className="load-error-copy"><strong>数据更新失败</strong><span>{error}{stale ? "；以下为上次成功读取的数据。" : "。请检查网络后重试。"}</span></div>
      <button type="button" className="button secondary load-retry" onClick={refreshClientData}>重新尝试</button>
    </div>
    {stale && !empty && children}
  </>;
  if (empty) return <div className="card empty">{emptyText}</div>;
  return <>{children}</>;
}

export function money(cents: number) { return `¥${(cents / 100).toFixed(2)}`; }
export function time(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("zh-CN", { hour12: false });
}

export function toLocalDateTimeInput(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}

const statusLabels: Record<string, string> = {
  ACTIVE: "启用",
  DISABLED: "停用",
  CREATED: "已创建",
  PENDING: "待支付",
  PROCESSING: "处理中",
  SUCCESS: "成功",
  FAILED: "失败",
  REJECTED: "已拒绝",
  APPROVED: "已批准",
  EXECUTED: "已执行",
  EXPIRED: "已过期",
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
