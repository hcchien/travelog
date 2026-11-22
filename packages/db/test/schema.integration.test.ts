/**
 * 資料庫整合測試：需要本機 PostgreSQL（含 postgis、pg_trgm、pgcrypto）。
 * 設定 TEST_DATABASE_URL 才會執行，例如：
 *   createdb travelog_test
 *   TEST_DATABASE_URL=postgres://localhost:5432/travelog_test pnpm --filter @travelog/db test
 * 每次執行會先清空 public schema 再跑全部 migration。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../drizzle");

describe.skipIf(!url)("資料庫 schema 與確定行程點防線", () => {
  const sql = postgres(url ?? "", { max: 1, onnotice: () => {} });

  let userId: string;
  let tripId: string;
  let dayId: string;

  beforeAll(async () => {
    await sql.unsafe("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
    await sql.unsafe("DROP SCHEMA IF EXISTS drizzle CASCADE;");
    await migrate(drizzle(sql), { migrationsFolder });

    [{ id: userId }] = await sql`
      INSERT INTO users (display_name) VALUES ('陳') RETURNING id`;
    [{ id: tripId }] = await sql`
      INSERT INTO trips (title, start_date, end_date, primary_tz, owner_id)
      VALUES ('京都・大阪 秋楓之旅', '2026-12-03', '2026-12-08', 'Asia/Tokyo', ${userId})
      RETURNING id`;
    [{ id: dayId }] = await sql`
      INSERT INTO trip_days (trip_id, date) VALUES (${tripId}, '2026-12-03') RETURNING id`;
  });

  afterAll(async () => {
    await sql.end();
  });

  async function insertItem(confirmed: boolean) {
    const [row] = await sql`
      INSERT INTO itinerary_items
        (trip_id, day_id, type, title, tz, sort_key, start_at, end_at,
         confirmed_at, confirm_source, created_by)
      VALUES
        (${tripId}, ${dayId}, 'transport', '台北桃園 → 關西機場', 'Asia/Tokyo', 'a0',
         '2026-12-03T00:50:00Z', '2026-12-03T03:25:00Z',
         ${confirmed ? new Date() : null}, ${confirmed ? "booking" : null}, ${userId})
      RETURNING id`;
    return row?.id as string;
  }

  it("users 自動產生 64 bytes 的 WebAuthn user handle", async () => {
    const [row] =
      await sql`SELECT length(webauthn_user_handle) AS len FROM users WHERE id = ${userId}`;
    expect(row?.len).toBe(64);
  });

  it("confirmed_at 與 confirm_source 必須同時有值或同時為空", async () => {
    await expect(sql`
      INSERT INTO itinerary_items (trip_id, type, title, tz, sort_key, confirmed_at, created_by)
      VALUES (${tripId}, 'sight', 'x', 'Asia/Tokyo', 'b0', now(), ${userId})`).rejects.toThrow(
      /itinerary_items_confirm_consistent/,
    );
  });

  it("已確定的行程點不能改時間", async () => {
    const id = await insertItem(true);
    await expect(
      sql`UPDATE itinerary_items SET start_at = '2026-12-03T02:00:00Z' WHERE id = ${id}`,
    ).rejects.toMatchObject({ code: "TL423" });
  });

  it("已確定的行程點可以改標題與備註", async () => {
    const id = await insertItem(true);
    await sql`UPDATE itinerary_items SET title = '長榮航空', notes = '記得帶護照' WHERE id = ${id}`;
    const [row] = await sql`SELECT notes FROM itinerary_items WHERE id = ${id}`;
    expect(row?.notes).toBe("記得帶護照");
  });

  it("已確定的行程點不能刪除，解除確定後才可以", async () => {
    const id = await insertItem(true);
    await expect(sql`DELETE FROM itinerary_items WHERE id = ${id}`).rejects.toMatchObject({
      code: "TL423",
    });
    await sql`UPDATE itinerary_items SET confirmed_at = NULL, confirm_source = NULL WHERE id = ${id}`;
    await sql`DELETE FROM itinerary_items WHERE id = ${id}`;
  });

  it("還有行程點的那一天不能直接刪除", async () => {
    await insertItem(false);
    await expect(sql`DELETE FROM trip_days WHERE id = ${dayId}`).rejects.toThrow(/foreign key/);
  });

  it("排序鍵使用 C collation（依位元組排序）", async () => {
    const [row] = await sql`
      SELECT collation_name FROM information_schema.columns
      WHERE table_name = 'itinerary_items' AND column_name = 'sort_key'`;
    expect(row?.collation_name).toBe("C");
  });

  it("刪除整個行程會連同已確定的行程點一起刪除", async () => {
    await insertItem(true);
    await sql`DELETE FROM trips WHERE id = ${tripId}`;
    const [row] =
      await sql`SELECT count(*)::int AS n FROM itinerary_items WHERE trip_id = ${tripId}`;
    expect(row?.n).toBe(0);
  });
});
