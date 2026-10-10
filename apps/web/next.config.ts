import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: fileURLToPath(new URL("../../", import.meta.url)),
  experimental: {
    // Arco 的入口 re-export 了全部组件，按需转换后只有实际用到的组件进入客户端包，
    // 否则管理台的包体等于拖着整个组件库。
    optimizePackageImports: ["@arco-design/web-react", "@arco-design/web-react/icon"],
  },
  async headers() {
    return ["/cashier/:path*", "/api/backend/public/:path*"].map(source => ({ source, headers: [
      { key: "Cache-Control", value: "no-store, private" },
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "X-Robots-Tag", value: "noindex, nofollow" },
      { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
      { key: "X-Frame-Options", value: "DENY" },
    ] }));
  },
};

export default nextConfig;
