"use client";

// 页面级错误提示的统一外观，供 admin / public / 根错误边界与 404 页面复用。
// 只展示 Next 生成的 digest 作为排查线索，不回显异常堆栈或原始报文，避免把内部实现细节带到界面。
export function ErrorState({ title, copy, digest, onRetry, retryLabel = "重新加载", homeHref }: {
  title: string;
  copy: string;
  digest?: string;
  onRetry: () => void;
  retryLabel?: string;
  homeHref?: string;
}) {
  return <div className="card error-state" role="alert">
    <div className="error-state-mark" aria-hidden="true">!</div>
    <h2>{title}</h2>
    <p className="muted">{copy}</p>
    {digest && <p className="mono muted">错误编号 {digest}</p>}
    <div className="error-state-actions">
      <button className="button" type="button" onClick={onRetry}>{retryLabel}</button>
      {homeHref && <a className="button secondary" href={homeHref}>返回首页</a>}
    </div>
  </div>;
}
