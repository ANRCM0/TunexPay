"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Activity, AlertTriangle, AppWindow, Bell, CreditCard, FileCheck2, Gauge, LayoutDashboard, ListChecks, LogOut, ReceiptText, RotateCcw, Webhook } from "lucide-react";

const navigation = [
  { label: "", items: [["/", "总览", LayoutDashboard]] },
  { label: "交易", items: [["/orders", "订单", ReceiptText], ["/refunds", "退款", RotateCcw], ["/exceptions", "支付异常", AlertTriangle]] },
  { label: "资金", items: [["/reconciliation", "对账", FileCheck2], ["/webhooks", "Webhook", Webhook]] },
  { label: "系统", items: [["/system", "系统监控", Gauge], ["/applications", "应用", AppWindow], ["/channels", "插件与通道", CreditCard], ["/notifications", "通知设置", Bell], ["/audits", "操作审计", ListChecks]] },
] as const;

export function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    window.location.assign("/login");
  }
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark">T</div><div><div className="brand-title">TUOXIN PAY</div><div className="brand-subtitle">拓昕支付基础设施</div></div></div>
      <nav className="nav">{navigation.map(group => <div className="nav-group" key={group.label}>
        {group.label && <div className="nav-group-label">{group.label}</div>}
        {group.items.map(([href, label, Icon]) => <Link className={path === href || (href !== "/" && path.startsWith(`${href}/`)) ? "active" : ""} href={href} key={href}><Icon size={17} />{label}</Link>)}
      </div>)}</nav>
      <div className="sidebar-foot"><Activity size={15} style={{ marginBottom: 7 }} />v0.1 · Single-tenant payment core<button className="logout-button" onClick={() => void logout()}><LogOut size={14} />退出登录</button></div>
    </aside>
    <main className="content">{children}</main>
  </div>;
}
