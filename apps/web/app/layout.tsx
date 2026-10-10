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
  //
  // suppressHydrationWarning 是必需的：脚本改动的正是 <html> 和 <body> 这两个元素
  // （内联变量 + arco-theme 属性），而服务端渲染出的 HTML 里没有它们，
  // 不声明就会被判定为水合不匹配。该属性只作用于本元素自身的属性，不会掩盖子树里的问题。
  return <html lang="zh-CN" suppressHydrationWarning>
    <head>
      <script dangerouslySetInnerHTML={{ __html: themeBootstrapScript() }} />
    </head>
    <body suppressHydrationWarning>{children}</body>
  </html>;
}
