// 轮询重试节奏：失败次数越多等待越久，并加入抖动。
// 目的有两个：网络中断时不再固定间隔硬打接口；多个页面同时挂掉时不会在同一时刻一起重试形成脉冲。

export const RETRY_BASE_MS = 1_000;
export const RETRY_MAX_MS = 30_000;

/**
 * 第 attempt 次失败后应等待的毫秒数（attempt 从 1 开始）。
 * 上限为 max，实际取值落在 [上限/2, 上限] 区间，保证既有退避量级又不失随机性。
 */
export function retryDelayMs(attempt: number, random: () => number = Math.random, base = RETRY_BASE_MS, max = RETRY_MAX_MS): number {
  const step = Math.max(1, Math.floor(attempt));
  const ceiling = Math.min(max, base * 2 ** (step - 1));
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

/** 可被 AbortSignal 打断的等待：组件卸载或重新轮询时不会留下悬挂的定时器。 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve(); return; }
    const done = () => {
      signal?.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}
