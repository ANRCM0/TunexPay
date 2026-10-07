"use client";

import { useEffect, useState } from "react";
import { useNavigationPending } from "../lib/nav-progress";

/**
 * 顶部导航进度条。
 *
 * 只在导航确实进行中时出现；进度条走完后延迟卸载，避免每次跳转都闪一下。
 */
export function RouteProgress() {
  const pending = useNavigationPending();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (pending) { setVisible(true); return; }
    if (!visible) return;
    const timer = window.setTimeout(() => setVisible(false), 220);
    return () => window.clearTimeout(timer);
  }, [pending, visible]);

  if (!visible) return null;
  return <div className="route-progress" role="progressbar" aria-label="页面加载中">
    <span className={pending ? "route-progress-bar running" : "route-progress-bar done"} />
  </div>;
}
