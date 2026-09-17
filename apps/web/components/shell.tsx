"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { AlertTriangle, AppWindow, Bell, CreditCard, FileCheck2, Gauge, LayoutDashboard, ListChecks, LogOut, Menu, PanelLeftClose, Puzzle, ReceiptText, RotateCcw, Webhook, X } from "lucide-react";

const navigation = [
  { label: "", items: [["/", "总览", LayoutDashboard, "#2563eb"]] },
  { label: "交易", items: [["/orders", "订单", ReceiptText, "#22a06b"], ["/refunds", "退款", RotateCcw, "#e8a13c"], ["/exceptions", "支付异常", AlertTriangle, "#e5534b"]] },
  { label: "资金", items: [["/reconciliation", "对账", FileCheck2, "#0ea5e9"], ["/webhooks", "Webhook", Webhook, "#8b5cf6"]] },
  { label: "系统", items: [["/system", "系统监控", Gauge, "#14b8a6"], ["/applications", "应用", AppWindow, "#f97316"], ["/plugins", "支付插件", Puzzle, "#8b5cf6"], ["/channels", "支付通道", CreditCard, "#2563eb"], ["/notifications", "通知设置", Bell, "#eab308"], ["/audits", "操作审计", ListChecks, "#64748b"]] },
] as const;

const CRUMB_MAP: [RegExp, string[]][] = [
  [/^\/$/, ["首页"]],
  [/^\/orders\/.+/, ["交易", "订单", "订单详情"]],
  [/^\/orders/, ["交易", "订单"]],
  [/^\/refunds/, ["交易", "退款"]],
  [/^\/exceptions/, ["交易", "支付异常"]],
  [/^\/reconciliation/, ["资金", "对账"]],
  [/^\/webhooks/, ["资金", "Webhook"]],
  [/^\/system/, ["系统", "系统监控"]],
  [/^\/applications/, ["系统", "应用"]],
  [/^\/plugins/, ["系统", "支付插件"]],
  [/^\/channels\/alipay-bill/, ["系统", "支付通道", "账单收款配置"]],
  [/^\/channels/, ["系统", "支付通道"]],
  [/^\/notifications/, ["系统", "通知设置"]],
  [/^\/audits/, ["系统", "操作审计"]],
];

function crumbs(path: string): string[] {
  return CRUMB_MAP.find(([pattern]) => pattern.test(path))?.[1] ?? ["首页"];
}

export function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  useEffect(() => { setNavOpen(false); }, [path]);
  useEffect(() => {
    if (!navOpen) return;
    const previous = document.body.style.overflow;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setNavOpen(false); };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [navOpen]);
  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    window.location.assign("/login");
  }
  const trail = crumbs(path);
  return <div className={`app-shell${collapsed ? " collapsed" : ""}${navOpen ? " nav-open" : ""}`}>
    {navOpen && <div className="nav-mask" onClick={() => setNavOpen(false)} aria-hidden="true" />}
    <aside className="sidebar" id="app-sidebar" aria-label="主导航">
      <div className="brand">
        <div className="brand-mark">T</div>
        <div className="brand-text"><div className="brand-title">TUOXIN PAY</div><div className="brand-subtitle">拓昕支付基础设施</div></div>
        <button className="nav-close" onClick={() => setNavOpen(false)} aria-label="关闭导航菜单"><X size={18} /></button>
      </div>
      <nav className="nav">{navigation.map(group => <div className="nav-group" key={group.label}>
        {group.label && <div className="nav-group-label">{group.label}</div>}
        {group.items.map(([href, label, Icon, color]) => <Link title={label} className={path === href || (href !== "/" && path.startsWith(`${href}/`)) ? "active" : ""} href={href} key={href}><Icon size={17} color={color} /><span>{label}</span></Link>)}
      </div>)}</nav>
      <div className="sidebar-foot">v0.1 · Single-tenant payment core</div>
    </aside>
    <div className="main">
      <header className="topbar">
        <button className="topbar-menu topbar-collapse" onClick={() => setCollapsed(value => !value)} aria-label={collapsed ? "展开侧边栏" : "折叠侧边栏"} aria-expanded={!collapsed} aria-controls="app-sidebar"><PanelLeftClose size={18} /></button>
        <button className="topbar-menu topbar-nav" onClick={() => setNavOpen(true)} aria-label="打开导航菜单" aria-expanded={navOpen} aria-controls="app-sidebar"><Menu size={18} /></button>
        <nav className="breadcrumb" aria-label="面包屑">{trail.map((item, index) => <span key={item}>{index > 0 && <i aria-hidden="true">/</i>}{item}</span>)}</nav>
        <div className="topbar-user"><span className="topbar-avatar" aria-hidden="true">管</span><span className="topbar-name">系统管理员</span><button className="logout-button" onClick={() => void logout()}><LogOut size={14} />退出</button></div>
      </header>
      <main className="content">{children}</main>
    </div>
  </div>;
}
