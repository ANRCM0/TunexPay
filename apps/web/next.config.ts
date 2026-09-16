import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: new URL("../../", import.meta.url).pathname,
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
