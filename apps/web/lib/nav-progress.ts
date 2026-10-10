"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useSyncExternalStore, useTransition } from "react";

/**
 * 导航进行中的全局状态。
 *
 * 为什么需要它：App Router 里没有 push 的“开始”事件，顶部进度条如果只在
 * pathname 变化之后闪一下，那是动画不是反馈。这里用 React 的 transition 跟踪
 * 真实的 pending：开始 push 时置为进行中，新路由渲染完成（transition 结束）
 * 时置回空闲，进度条因此对应真实等待。
 */
let listeners = new Set<() => void>();
let pendingCount = 0;

function emit() {
  listeners.forEach(listener => listener());
}

function setPending(delta: number) {
  pendingCount = Math.max(0, pendingCount + delta);
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function getSnapshot() {
  return pendingCount > 0;
}

/** 供顶部进度条使用：导航是否仍在进行中。 */
export function useNavigationPending(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

/**
 * 带进度反馈的路由跳转。
 *
 * push 包在 startTransition 里，这样 React 会把它当作可中断的过渡更新，
 * 期间 isPending 为真，进度条据此显示。
 */
export function useNavPush() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    // React 的 isPending 变化与外部计数保持同步；用它做增量而不是差值覆盖，
    // 因为可能有多次跳转在重叠期间。
    if (isPending) {
      setPending(1);
      return () => setPending(-1);
    }
    return undefined;
  }, [isPending]);

  const push = useCallback((href: string) => {
    startTransition(() => { router.push(href); });
  }, [router]);

  return push;
}
