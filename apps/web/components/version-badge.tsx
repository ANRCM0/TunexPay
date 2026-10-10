"use client";

import { useEffect, useState } from "react";
import type { AppVersion, AppVersionSource } from "../lib/app-version";

const SOURCE_LABEL: Record<AppVersionSource, string> = {
  env: "构建注入",
  git: "本地 Git",
  fallback: "开发兜底",
};

/**
 * 左下角常驻的版本徽标。
 *
 * 首屏用的是服务端渲染进来的版本号（构建时确定），挂载后再向 /api/version 问一次
 * **当前进程**的版本号并覆盖：页面可能是缓存下来的旧 HTML，也可能和 API 不是同一版本，
 * 这样显示出来的永远是线上真正在跑的那一版。接口拿不到（401、离线、旧镜像）就保留首屏值，
 * 版本号不是关键路径，失败不应该冒泡成界面错误。
 */
export function VersionBadge({ initial }: { initial: AppVersion }) {
  const [runtime, setRuntime] = useState<AppVersion | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/version", { cache: "no-store" })
      .then(response => (response.ok ? response.json() as Promise<AppVersion> : null))
      .then(data => { if (!cancelled && typeof data?.version === "string" && data.version) setRuntime(data); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  const current = runtime ?? initial;
  // 版本号现在就是发布 tag，只有本地构建才带得出提交号；没有提交号时只报来源。
  const detail = [
    current.commit ? `提交 ${current.commit}` : null,
    `来源：${SOURCE_LABEL[current.source] ?? current.source}`,
  ].filter(Boolean).join(" · ");

  return (
    <span className="version-badge" data-version-source={current.source} data-version-verified={runtime ? "true" : "false"} title={`当前运行版本 ${detail}`}>
      <i className="version-dot" aria-hidden="true" />
      <span className="version-text">v{current.version}</span>
      <span className="sr-only">（{detail}）</span>
    </span>
  );
}
