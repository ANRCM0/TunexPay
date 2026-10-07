import "./admin.css";
import { ArcoProvider } from "../../components/arco-provider";
import { Shell } from "../../components/shell";
import { resolveAppVersion } from "../../lib/app-version";

export default function AdminLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // 版本号在服务端解析一次后传给侧边栏：首屏 HTML 里就带着版本号，不等客户端请求。
  // 页面（尤其是预渲染出来的）可能是旧构建的产物，客户端挂载后还会用 /api/version 自我校验。
  return <ArcoProvider><Shell version={resolveAppVersion()}>{children}</Shell></ArcoProvider>;
}
