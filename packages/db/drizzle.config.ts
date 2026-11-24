import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://localhost:5432/travelog",
  },
  // PostGIS 建立的系統資料表不納入比對
  extensionsFilters: ["postgis"],
  strict: true,
  verbose: true,
});
