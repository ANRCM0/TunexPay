import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TUOXIN Pay",
  description: "拓昕支付基础设施控制台",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
