import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

export type Schema = typeof schema;

/**
 * 不綁定特定 driver 的資料庫型別：正式環境用 postgres-js，測試可用 PGlite。
 */
export type Database = PgDatabase<PgQueryResultHKT, Schema>;
export type Transaction = PgTransaction<
  PgQueryResultHKT,
  Schema,
  ExtractTablesWithRelations<Schema>
>;
export type DbOrTx = Database | Transaction;

/**
 * Cloud SQL 透過 unix socket 連線：postgres://user:pass@localhost/db?host=/cloudsql/PROJECT:REGION:INSTANCE
 * （主機名稱只是佔位；postgres-js 需要明確的 socket 檔路徑，這裡轉換成 path 選項。）
 */
export function connectionOptions(url: string): { url: string; path?: string } {
  const u = new URL(url);
  const host = u.searchParams.get("host");
  if (!host?.startsWith("/")) return { url };
  u.searchParams.delete("host");
  return { url: u.toString(), path: `${host}/.s.PGSQL.${u.port || 5432}` };
}

export function createDb(url: string, options: { max?: number; quiet?: boolean } = {}) {
  const conn = connectionOptions(url);
  const sql = postgres(conn.url, {
    max: options.max ?? 10,
    ...(conn.path ? { path: conn.path } : {}),
    // 「已存在，略過」之類的 NOTICE 不印出
    ...(options.quiet ? { onnotice: () => {} } : {}),
  });
  const db: Database = drizzle(sql, { schema });
  return { db, sql };
}

/** migration SQL 檔所在資料夾（發佈後位於套件根目錄的 drizzle/）。 */
export const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../drizzle",
);
