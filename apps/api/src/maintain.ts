/** Scheduled Cloud Run job: cleanup also runs when the API scales to zero. */
import { createDb } from "@travelog/db";
import { maintenance } from "./lib/maintenance.js";
import { createGcsStorage } from "./lib/storage.js";

const url = process.env.DATABASE_URL;
const bucket = process.env.GCS_BUCKET;
if (!url || !bucket) throw new Error("缺少 DATABASE_URL 或 GCS_BUCKET");
const { db, sql } = createDb(url, { max: 1, quiet: true });
try {
  const storage = await createGcsStorage(bucket);
  await maintenance({ db, storage, now: () => new Date() });
} finally {
  await sql.end({ timeout: 5 });
}
