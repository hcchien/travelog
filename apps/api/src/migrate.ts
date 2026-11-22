/**
 * 執行資料庫 migration（部署時由 Cloud Run Job 執行：node dist/migrate.js）。
 */
import { createDb, migrationsFolder } from "@travelog/db";
import { migrate } from "drizzle-orm/postgres-js/migrator";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("缺少 DATABASE_URL");
const { db, sql } = createDb(url, { max: 1, quiet: true });
try {
  // biome-ignore lint/suspicious/noExplicitAny: Database 型別不綁 driver；這裡確定是 postgres-js
  await migrate(db as any, { migrationsFolder });
  console.log("migration 完成");
} finally {
  await sql.end({ timeout: 5 });
}
