import type { NextConfig } from "next";

const config: NextConfig = {
  // Cloud Run 部署用：產生最小的自帶 node_modules 輸出
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,
};

export default config;
