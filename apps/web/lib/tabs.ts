/**
 * 多页签栏的状态算法。
 *
 * 抽成纯函数是为了能直接测：页签的关闭规则（关当前要跳到邻居、首页不可关）
 * 容易写错，且错了只有在用户点的时候才会暴露。
 */

export type Tab = { href: string; title: string };

/** 首页常驻且不可关闭，作为「关闭全部」后的落点。 */
export const HOME_TAB: Tab = { href: "/", title: "首页" };

const STORAGE_KEY = "tuoxin.tabs";

export function openTab(tabs: Tab[], tab: Tab): Tab[] {
  if (tabs.some(candidate => candidate.href === tab.href)) return tabs;
  return [...tabs, tab];
}

/**
 * 关闭一个页签。
 *
 * 返回新的页签列表与应当激活的路径：关掉当前页签时激活右邻居，没有右邻居就
 * 激活左邻居；关掉的不是当前页签时保持原激活项。
 */
export function closeTab(tabs: Tab[], href: string, activeHref: string): { tabs: Tab[]; active: string } {
  const index = tabs.findIndex(tab => tab.href === href);
  if (index < 0) return { tabs, active: activeHref };
  const next = tabs.filter(tab => tab.href !== href);
  // 首页是兜底落点，始终保留
  if (!next.some(tab => tab.href === HOME_TAB.href)) next.unshift(HOME_TAB);
  if (href !== activeHref) return { tabs: next, active: activeHref };
  const fallback = next[index] ?? next[index - 1] ?? HOME_TAB;
  return { tabs: next, active: fallback.href };
}

/** 关闭其它：保留首页、目标页签和当前激活页签。 */
export function closeOthers(tabs: Tab[], href: string, activeHref: string): { tabs: Tab[]; active: string } {
  const keep = new Set([HOME_TAB.href, href, activeHref]);
  const next = tabs.filter(tab => keep.has(tab.href));
  if (!next.some(tab => tab.href === HOME_TAB.href)) next.unshift(HOME_TAB);
  return { tabs: next, active: next.some(tab => tab.href === activeHref) ? activeHref : href };
}

export function closeAll(): { tabs: Tab[]; active: string } {
  return { tabs: [HOME_TAB], active: HOME_TAB.href };
}

/**
 * 读回持久化的页签。
 *
 * 存储里的内容可能来自旧版本、被手动改过或本身损坏，所以逐项校验形状，
 * 任何不合规的项直接丢弃，而不是让整块界面在渲染时炸掉。
 */
export function parseStoredTabs(raw: string | null): Tab[] {
  if (!raw) return [HOME_TAB];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [HOME_TAB];
  }
  if (!Array.isArray(parsed)) return [HOME_TAB];
  const tabs = parsed.flatMap(entry => {
    if (typeof entry !== "object" || entry === null) return [];
    const { href, title } = entry as Partial<Tab>;
    if (typeof href !== "string" || !href.startsWith("/") || typeof title !== "string" || !title) return [];
    return [{ href, title }];
  });
  return tabs.some(tab => tab.href === HOME_TAB.href) ? tabs : [HOME_TAB, ...tabs];
}

export function serializeTabs(tabs: Tab[]): string {
  return JSON.stringify(tabs);
}

export function loadTabs(): Tab[] {
  if (typeof window === "undefined") return [HOME_TAB];
  try {
    return parseStoredTabs(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return [HOME_TAB];
  }
}

export function saveTabs(tabs: Tab[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, serializeTabs(tabs));
  } catch {
    // 隐私模式下 localStorage 会直接抛错，页签退化成不持久化即可，不该影响使用
  }
}
