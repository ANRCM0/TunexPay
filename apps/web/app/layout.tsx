import type { Metadata } from "next";
import { themeBootstrapScript } from "../lib/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: "TUOXIN Pay",
  description: "拓昕支付基础设施控制台",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // 主题模式与自定义配色必须在首帧绘制前落到 DOM 上，否则深色模式用户会看到白屏闪烁。
  // 这段脚本同步执行于 <head>，早于 body 渲染，所以用 dangerouslySetInnerHTML 内联。
  return <html lang="zh-CN">
    <head>
      <script dangerouslySetInnerHTML={{ __html: themeBootstrapScript() }} />
    </head>
    <body>{children}</body>
  </html>;
}
