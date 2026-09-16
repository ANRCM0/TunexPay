"use client";

import { useCallback, useEffect, useState } from "react";

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

export function useApi<T>(path: string, intervalMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    try { setData((await api<{ data: T }>(path)).data); setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "请求失败"); }
    finally { setLoading(false); }
  }, [path]);
  useEffect(() => {
    void reload();
    if (!intervalMs) return;
    const timer = setInterval(() => void reload(), intervalMs);
    return () => clearInterval(timer);
  }, [reload, intervalMs]);
  return { data, error, loading, reload };
}
