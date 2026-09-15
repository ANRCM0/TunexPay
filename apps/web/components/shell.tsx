"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Activity, AppWindow, LayoutDashboard, ReceiptText, RotateCcw, Webhook } from "lucide-react";

const navigation = [
  ["/", "总览", LayoutDashboard],
  ["/applications", "应用", AppWindow],
  ["/orders", "订单", ReceiptText],
  ["/refunds", "退款", RotateCcw],
  ["/webhooks", "Webhook", Webhook],
] as const;

export function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  if (path.startsWith("/cashier/")) return <>{children}</>;
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark">T</div><div><div className="brand-title">TUOXIN PAY</div><div className="brand-subtitle">拓昕支付基础设施</div></div></div>
      <nav className="nav">{navigation.map(([href, label, Icon]) => <Link href={href} key={href}><Icon size={17} />{label}</Link>)}</nav>
      <div className="sidebar-foot"><Activity size={15} style={{ marginBottom: 7 }} />v0.1 · Single-tenant payment core<br />MySQL outbox / Redis worker</div>
    </aside>
    <main className="content">{children}</main>
  </div>;
}
