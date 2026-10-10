"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { REFRESH_DATA_EVENT } from "./refresh";

export type ApiOptions = RequestInit & { redirectOnUnauthorized?: boolean };
export type PageMeta = { page: number; pageSize: number; total: number };

export async function api<T>(path: string, init?: ApiOptions): Promise<T> {
  const { redirectOnUnauthorized = true, ...requestInit } = init ?? {};
  const headers = new Headers(requestInit.headers);
  headers.set("accept", "application/json");
  if (requestInit.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(`/api/backend${path}`, { cache: "no-store", ...requestInit, headers });
  const text = await response.text();
  let payload: any;
  if (text) {
    try { payload = JSON.parse(text); }
    catch { payload = {}; }
  }
  if (response.status === 401 && redirectOnUnauthorized && typeof window !== "undefined") {
    const next = `${window.location.pathname}${window.location.search}`;
    window.location.assign(`/login?next=${encodeURIComponent(next)}`);
  }
  if (!response.ok) throw new Error(payload?.error?.message || response.statusText || "请求失败");
  return payload as T;
}

// 轮询护栏：跳过未完成的请求、隐藏标签页/离线时暂停、切回前台节流补刷。
// 手动刷新会取消旧请求；已成功读取的数据在后台刷新失败时保留，同时显示可重试错误。
export function useApi<T>(path: string, intervalMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [meta, setMeta] = useState<PageMeta | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [resolvedPath, setResolvedPath] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const inFlight = useRef(false);
  const lastAttemptAt = useRef(0);

  const run = useCallback(async () => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    inFlight.current = true;
    lastAttemptAt.current = Date.now();
    try {
      const payload = await api<{ data: T; meta?: PageMeta }>(path, { signal: current.signal });
      if (current.signal.aborted) return;
      setData(payload.data);
      setMeta(payload.meta ?? null);
      setResolvedPath(path);
      setUpdatedAt(Date.now());
      setError("");
    } catch (cause) {
      if (current.signal.aborted) return;
      setResolvedPath(path);
      setError(cause instanceof Error ? cause.message : "请求失败");
    } finally {
      // 只有最新那次请求有资格收尾；被取代的旧请求到此为止
      if (controller.current === current) {
        inFlight.current = false;
        if (!current.signal.aborted) {
          setLoading(false);
        }
      }
    }
  }, [path]);

  useEffect(() => {
    setLoading(true);
    setData(null);
    setMeta(null);
    setError("");
    setUpdatedAt(null);
    void run();

    const isForegroundOnline = () => document.visibilityState === "visible" && navigator.onLine !== false;
    // 切回前台或网络恢复时补刷；最小间隔避免快速切标签造成请求风暴。
    const onResume = () => {
      if (!intervalMs || !isForegroundOnline() || inFlight.current) return;
      if (Date.now() - lastAttemptAt.current < 2_000) return;
      void run();
    };
    const onRefresh = () => { void run(); };
    const timer = intervalMs
      ? window.setInterval(() => {
        if (!isForegroundOnline() || inFlight.current) return;
        if (Date.now() - lastAttemptAt.current < 2_000) return;
        void run();
      }, intervalMs)
      : null;
    if (intervalMs) {
      document.addEventListener("visibilitychange", onResume);
      window.addEventListener("online", onResume);
    }
    window.addEventListener(REFRESH_DATA_EVENT, onRefresh);
    return () => {
      if (timer !== null) window.clearInterval(timer);
      if (intervalMs) {
        document.removeEventListener("visibilitychange", onResume);
        window.removeEventListener("online", onResume);
      }
      window.removeEventListener(REFRESH_DATA_EVENT, onRefresh);
      controller.current?.abort();
    };
  }, [run, intervalMs]);

  const pathPending = resolvedPath !== path;
  return {
    data: pathPending ? null : data,
    meta: pathPending ? null : meta,
    error: pathPending ? "" : error,
    loading: loading || pathPending,
    updatedAt: pathPending ? null : updatedAt,
    reload: run,
  };
}
