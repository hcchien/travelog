import path from "node:path";
import type { NextConfig } from "next";

const config: NextConfig = {
  // Cloud Run 部署用：產生最小的自帶 node_modules 輸出
  output: "standalone",
  // monorepo：從 repo 根目錄追蹤相依，standalone 內的伺服器位於 apps/web/server.js
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: "frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
          },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default config;
