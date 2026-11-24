import { customType, timestamp, uuid } from "drizzle-orm/pg-core";

export const id = () => uuid("id").primaryKey().defaultRandom();

export const createdAt = () =>
  timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow();

export const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

export const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/** WebAuthn credential ID、公鑰等二進位資料。 */
export const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => "bytea",
  toDriver: (value) => Buffer.from(value),
  fromDriver: (value) => new Uint8Array(value),
});

/**
 * Fractional indexing 的排序鍵。使用 "C" collation，確保依位元組排序，
 * 不受資料庫預設語系影響。
 */
export const sortKey = customType<{ data: string }>({
  dataType: () => 'text COLLATE "C"',
});
