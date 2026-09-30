// Worker 的轮询节奏策略。
//
// 快速通道（发现到期 Webhook 并入队）决定支付成功通知的时效，必须每跳执行；
// 慢速通道（查单恢复、过期关闭、流水恢复、本人通知）都不急，连续空转后逐步拉长间隔，
// 一旦领到任务立刻回到每跳。

export const WORKER_TICK_MS = 3_000;

/** 慢速通道的最长间隔：3 秒 × 5 = 15 秒。 */
export const HEAVY_SCAN_MAX_STRIDE = 5;

/** 每空转这么多跳，慢速通道的间隔放宽一档。 */
export const HEAVY_SCAN_RAMP_TICKS = 3;

/**
 * 慢速通道每多少跳执行一次。
 * 空闲 0~2 跳 → 每跳；3~5 → 每 2 跳；6~8 → 每 3 跳；依此类推，封顶 5 跳（15 秒）。
 */
export function heavyScanStride(idleTicks: number): number {
  return Math.min(HEAVY_SCAN_MAX_STRIDE, 1 + Math.floor(Math.max(0, idleTicks) / HEAVY_SCAN_RAMP_TICKS));
}
