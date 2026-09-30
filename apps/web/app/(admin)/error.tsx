"use client";

import { ErrorState } from "../../components/error-state";

// (admin) 分组的错误边界：渲染在 Shell 内部，侧边导航与顶栏保持可用。
// 文案刻意区分「页面渲染失败」与「资金操作失败」——重新加载不会影响服务端已经发生的支付事实。
export default function AdminError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <ErrorState
    title="页面加载失败"
    copy="管理台渲染这个页面时出错。可以先重新加载；如果反复失败，请到「系统监控」和「操作审计」确认后台实际状态，再决定是否重试刚才的操作。"
    digest={error.digest}
    onRetry={reset}
    homeHref="/"
  />;
}
