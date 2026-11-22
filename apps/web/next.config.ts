import path from "node:path";
import type { NextConfig } from "next";

const config: NextConfig = {
  // Cloud Run 部署用：產生最小的自帶 node_modules 輸出
  output: "standalone",
  // monorepo：從 repo 根目錄追蹤相依，standalone 內的伺服器位於 apps/web/server.js
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
  reactStrictMode: true,
  poweredByHeader: false,
};

export default config;
