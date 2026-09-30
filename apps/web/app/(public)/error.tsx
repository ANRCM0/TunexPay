"use client";

import { ErrorState } from "../../components/error-state";

// (public) 分组的错误边界：收银台与登录页共用。
// 收银台出错时最重要的是先阻止用户重复付款，所以文案直接给出这一指引。
export default function PublicError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <div className="error-shell">
    <ErrorState
      title="页面暂时无法加载"
      copy="收银台没能正常显示。请不要重复付款：已经发生的付款不会因为页面出错而丢失，可以重新加载确认，或稍后联系收款方核对。"
      digest={error.digest}
      onRetry={reset}
    />
  </div>;
}
