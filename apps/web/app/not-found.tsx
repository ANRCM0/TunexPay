import Link from "next/link";

// 404 页面：unmatched URL 会落到这里（本项目没有显式调用 notFound()）。
export default function NotFound() {
  return <div className="error-shell">
    <div className="card error-state">
      <div className="error-state-mark neutral" aria-hidden="true">?</div>
      <h2>页面不存在</h2>
      <p className="muted">你访问的地址没有对应的页面，可能是链接已经过期或者输入有误。</p>
      <div className="error-state-actions">
        <Link className="button" href="/">返回首页</Link>
      </div>
    </div>
  </div>;
}
