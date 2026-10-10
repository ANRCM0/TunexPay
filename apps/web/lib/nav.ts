import { AlertTriangle, AppWindow, Bell, CreditCard, FileCheck2, Gauge, KeyRound, LayoutDashboard, ListChecks, Palette, Puzzle, ReceiptText, RotateCcw, Shuffle, Webhook, type LucideIcon } from "lucide-react";

/**
 * 管理台导航配置。
 *
 * 结构对齐 MPAY V2 管理台：一级是「首页」单页，其余按业务域分组，
 * 组内是二级菜单。分组顺序即侧栏顺序，改这里就等于改全站导航、
 * 面包屑和页签标题，不用再去别处同步。
 */

export type NavTone = "blue" | "green" | "orange" | "purple" | "cyan" | "red";

export type NavItem = {
  href: string;
  title: string;
  icon: LucideIcon;
  tone: NavTone;
};

export type NavGroup = {
  key: string;
  title: string;
  icon: LucideIcon;
  tone: NavTone;
  items: NavItem[];
};

export const HOME: NavItem = { href: "/", title: "首页", icon: LayoutDashboard, tone: "blue" };

export const NAV_GROUPS: NavGroup[] = [
  {
    key: "trade",
    title: "交易中心",
    icon: ReceiptText,
    tone: "blue",
    items: [
      { href: "/orders", title: "支付订单", icon: ReceiptText, tone: "blue" },
      { href: "/refunds", title: "退款", icon: RotateCcw, tone: "orange" },
      { href: "/exceptions", title: "支付异常", icon: AlertTriangle, tone: "red" },
    ],
  },
  {
    key: "channel",
    title: "通道中心",
    icon: CreditCard,
    tone: "cyan",
    items: [
      { href: "/plugins", title: "支付插件", icon: Puzzle, tone: "purple" },
      { href: "/channels", title: "支付通道", icon: CreditCard, tone: "cyan" },
      { href: "/channels/alipay-bill", title: "账单收款配置", icon: FileCheck2, tone: "green" },
    ],
  },
  {
    key: "route",
    title: "路由中心",
    icon: Shuffle,
    tone: "purple",
    items: [{ href: "/routing-groups", title: "轮询组", icon: Shuffle, tone: "purple" }],
  },
  {
    key: "recon",
    title: "对账与通知",
    icon: FileCheck2,
    tone: "green",
    items: [
      { href: "/reconciliation", title: "对账", icon: FileCheck2, tone: "green" },
      { href: "/webhooks", title: "Webhook", icon: Webhook, tone: "cyan" },
      { href: "/notifications", title: "通知设置", icon: Bell, tone: "orange" },
    ],
  },
  {
    key: "system",
    title: "系统管理",
    icon: Gauge,
    tone: "blue",
    items: [
      { href: "/system", title: "系统监控", icon: Gauge, tone: "blue" },
      { href: "/applications", title: "应用", icon: AppWindow, tone: "cyan" },
      { href: "/mcp-access", title: "MCP / Agent Access", icon: KeyRound, tone: "purple" },
      { href: "/audits", title: "操作审计", icon: ListChecks, tone: "green" },
      { href: "/settings", title: "界面设置", icon: Palette, tone: "purple" },
    ],
  },
];

const ALL_ITEMS: NavItem[] = [HOME, ...NAV_GROUPS.flatMap(group => group.items)];

// 更具体的路径优先：/channels/alipay-bill 必须命中账单收款配置，
// 而不是被 /channels 用前缀规则抢走。所以按 href 长度倒序取第一个匹配。
const BY_SPECIFICITY = [...ALL_ITEMS].sort((a, b) => b.href.length - a.href.length);

export function matchNavItem(pathname: string): NavItem | null {
  return BY_SPECIFICITY.find(item =>
    item.href === "/" ? pathname === "/" : pathname === item.href || pathname.startsWith(`${item.href}/`),
  ) ?? null;
}

export function navGroupOf(pathname: string): NavGroup | null {
  const item = matchNavItem(pathname);
  if (!item) return null;
  return NAV_GROUPS.find(group => group.items.some(candidate => candidate.href === item.href)) ?? null;
}

/** 详情页路径（/orders/PAY123）在面包屑末尾补一层，避免只显示到列表页。 */
const DETAIL_LABELS: [RegExp, string][] = [
  [/^\/orders\/.+/, "订单详情"],
];

export function navTrail(pathname: string): string[] {
  const item = matchNavItem(pathname);
  const group = navGroupOf(pathname);
  const detail = DETAIL_LABELS.find(([pattern]) => pattern.test(pathname))?.[1];
  const trail = group ? [group.title, item?.title ?? ""] : [item?.title ?? "首页"];
  return detail ? [...trail, detail] : trail;
}

export function navTitle(pathname: string): string {
  const item = matchNavItem(pathname);
  const detail = DETAIL_LABELS.find(([pattern]) => pattern.test(pathname))?.[1];
  return detail ? `${item?.title ?? ""} · ${detail}` : item?.title ?? "首页";
}

/** 页签栏用它把路径还原成菜单项，找不到的路径（详情页等）不建页签。 */
export function navItemByHref(href: string): NavItem | null {
  return ALL_ITEMS.find(item => item.href === href) ?? null;
}
