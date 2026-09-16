"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Activity, AlertTriangle, AppWindow, CreditCard, FileCheck2, LayoutDashboard, ListChecks, LogOut, ReceiptText, RotateCcw, Webhook } from "lucide-react";

const navigation = [
  ["/", "总览", LayoutDashboard],
  ["/applications", "应用", AppWindow],
  ["/orders", "订单", ReceiptText],
  ["/refunds", "退款", RotateCcw],
  ["/reconciliation", "对账", FileCheck2],
  ["/exceptions", "支付异常", AlertTriangle],
  ["/webhooks", "Webhook", Webhook],
  ["/channels", "支付渠道", CreditCard],
  ["/audits", "操作审计", ListChecks],
] as const;

export function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  if (path.startsWith("/cashier/") || path === "/login") return <>{children}</>;
  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    window.location.assign("/login");
  }
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark">T</div><div><div className="brand-title">TUOXIN PAY</div><div className="brand-subtitle">拓昕支付基础设施</div></div></div>
      <nav className="nav">{navigation.map(([href, label, Icon]) => <Link className={path === href || (href !== "/" && path.startsWith(`${href}/`)) ? "active" : ""} href={href} key={href}><Icon size={17} />{label}</Link>)}</nav>
      <div className="sidebar-foot"><Activity size={15} style={{ marginBottom: 7 }} />v0.1 · Single-tenant payment core<br />MySQL outbox / Redis worker<button className="logout-button" onClick={() => void logout()}><LogOut size={14} />退出登录</button></div>
    </aside>
    <main className="content">{children}</main>
  </div>;
}
