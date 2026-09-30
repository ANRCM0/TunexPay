"use client";

import { ErrorState } from "../components/error-state";

// 根错误边界：兜住分组布局自身抛出的异常（分组内的 error.tsx 位于布局之下，无法捕获这一层）。
export default function RootError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <div className="error-shell">
    <ErrorState
      title="服务暂时不可用"
      copy="页面渲染时发生错误。请重新加载；如果问题持续出现，请把下面的错误编号提供给管理员。"
      digest={error.digest}
      onRetry={reset}
    />
  </div>;
}
