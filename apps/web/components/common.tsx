export function PageHead({ eyebrow, title, copy, action }: { eyebrow: string; title: string; copy: string; action?: React.ReactNode }) {
  return <header className="page-head"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p className="page-copy">{copy}</p></div>{action}</header>;
}

export function Status({ value }: { value: string }) {
  return <span className={`badge ${value}`}>{value}</span>;
}

export function LoadingState({ loading, error, empty, children }: { loading: boolean; error: string; empty?: boolean; children: React.ReactNode }) {
  if (loading) return <div className="card loading">正在加载…</div>;
  if (error) return <div className="card error">{error}</div>;
  if (empty) return <div className="card empty">暂无数据</div>;
  return <>{children}</>;
}

export function money(cents: number) { return `¥${(cents / 100).toFixed(2)}`; }
export function time(value: string | null | undefined) { return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—"; }
