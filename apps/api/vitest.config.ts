import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 每個測試檔各自啟動一個 PGlite（含 PostGIS），記憶體用量大：限制同時執行的數量
    maxWorkers: 2,
    // Cold PGlite/PostGIS startup and migrations can exceed the default 10s on CI.
    hookTimeout: 60_000,
    testTimeout: 15_000,
  },
});
