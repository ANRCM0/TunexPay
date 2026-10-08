/**
 * 管理台客户端数据的统一刷新信号。
 * Next 的 router.refresh() 只重新获取 RSC 树，无法主动刷新 useApi 的客户端请求。
 */
export const REFRESH_DATA_EVENT = "tuoxin:refresh-data";

export function refreshClientData() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(REFRESH_DATA_EVENT));
}
