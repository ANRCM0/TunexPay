"use client";

import { ConfigProvider } from "@arco-design/web-react";
import zhCN from "@arco-design/web-react/es/locale/zh-CN";
// React 19 的 react-dom 不再导出 createRoot，Arco 的 Message / Notification 等
// 命令式 API 需要这个适配器把 createRoot 注入进去，缺了它一调用就报错。
import "@arco-design/web-react/es/_util/react-19-adapter";
import "@arco-design/web-react/dist/css/arco.css";

export function ArcoProvider({ children }: { children: React.ReactNode }) {
  return <ConfigProvider locale={zhCN} componentConfig={{ Card: { bordered: false } }}>{children}</ConfigProvider>;
}
