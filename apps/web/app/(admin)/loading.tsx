// 路由级加载骨架：服务端组件就绪前的过渡状态。
// 管理台页面在切换时会有一段等待（RSC 数据 + 大表格），没有这一层就是白屏，
// 用户会以为点击没生效；有了它，等待期间页面结构已经出现。
export default function Loading() {
  return <div className="card skeleton-card page-skeleton" role="status" aria-label="正在加载页面">
    <div className="skeleton skeleton-title" />
    <div className="skeleton skeleton-line" />
    <div className="skeleton skeleton-line short" />
    <div className="skeleton skeleton-line" />
  </div>;
}
