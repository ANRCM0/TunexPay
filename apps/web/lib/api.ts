"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/backend${path}`, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  const payload = await response.json();
  if (response.status === 401 && typeof window !== "undefined") {
    const next = `${window.location.pathname}${window.location.search}`;
    window.location.assign(`/login?next=${encodeURIComponent(next)}`);
  }
  if (!response.ok) throw new Error(payload.error?.message ?? "请求失败");
  return payload;
}

// 轮询的三条护栏：
//   1. 上一次没返回就跳过本轮 —— 接口变慢时不会把请求越堆越多；
//   2. 后台标签页不轮询，切回前台立刻补一次 —— 没人看的页面不该一直打接口；
//   3. 手动 reload 会取消未完成的请求并立即取新数据 —— 所以慢响应不会覆盖新数据，
//      操作后的刷新也不会被正在进行的轮询吞掉。
export function useApi<T>(path: string, intervalMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const controller = useRef<AbortController | null>(null);
  const inFlight = useRef(false);

  const run = useCallback(async () => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    inFlight.current = true;
    try {
      const payload = await api<{ data: T }>(path, { signal: current.signal });
      if (current.signal.aborted) return;
      setData(payload.data);
      setError("");
    } catch (cause) {
      if (current.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : "请求失败");
    } finally {
      // 只有最新那次请求有资格收尾；被取代的旧请求到此为止
      if (controller.current === current) {
        inFlight.current = false;
        setLoading(false);
      }
    }
  }, [path]);

  useEffect(() => {
    void run();
    const onVisible = () => { if (document.visibilityState === "visible") void run(); };
    const timer = intervalMs
      ? setInterval(() => {
        if (document.visibilityState === "hidden") return;
        if (inFlight.current) return;
        void run();
      }, intervalMs)
      : null;
    if (intervalMs) document.addEventListener("visibilitychange", onVisible);
    return () => {
      if (timer !== null) clearInterval(timer);
      if (intervalMs) document.removeEventListener("visibilitychange", onVisible);
      controller.current?.abort();
    };
  }, [run, intervalMs]);

  return { data, error, loading, reload: run };
}
