import { sql } from "drizzle-orm";
import { boolean, index, integer, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { bytea, createdAt, id, tstz, updatedAt } from "./columns.js";
import { identityProvider } from "./enums.js";

export const users = pgTable("users", {
  id: id(),
  displayName: text("display_name").notNull(),
  avatarUrl: text("avatar_url"),
  primaryEmail: text("primary_email"),
  defaultTz: text("default_tz").notNull().default("Asia/Taipei"),
  locale: text("locale").notNull().default("zh-TW"),
  /** WebAuthn user handle：隨機 64 bytes（pgcrypto），不使用 email。帳號建立時產生。 */
  webauthnUserHandle: bytea("webauthn_user_handle")
    .notNull()
    .unique()
    .default(sql`gen_random_bytes(64)`),
  deletedAt: tstz("deleted_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Google / Apple 身分。帳號一律由這兩者之一建立（Passkey 不能註冊）。 */
export const userIdentities = pgTable(
  "user_identities",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: identityProvider("provider").notNull(),
    providerSub: text("provider_sub").notNull(),
    email: text("email"),
    emailVerified: boolean("email_verified").notNull().default(false),
    isPrivateRelay: boolean("is_private_relay").notNull().default(false),
    /** Apple refresh token（KMS 加密後的密文），刪除帳號時用來撤銷授權。 */
    providerRefreshTokenEnc: text("provider_refresh_token_enc"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("user_identities_provider_sub").on(t.provider, t.providerSub),
    index().on(t.userId),
  ],
);

export const webauthnCredentials = pgTable(
  "webauthn_credentials",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    credentialId: bytea("credential_id").notNull().unique(),
    publicKey: bytea("public_key").notNull(),
    signCount: integer("sign_count").notNull().default(0),
    transports: text("transports").array().notNull().default(sql`'{}'::text[]`),
    aaguid: text("aaguid"),
    backedUp: boolean("backed_up").notNull().default(false),
    deviceType: text("device_type"),
    name: text("name").notNull(),
    createdAt: createdAt(),
    lastUsedAt: tstz("last_used_at"),
  },
  (t) => [index().on(t.userId)],
);

/** App 推播的裝置權杖（Expo Push）。 */
export const pushTokens = pgTable(
  "push_tokens",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    platform: text("platform").notNull(),
    createdAt: createdAt(),
    lastSeenAt: tstz("last_seen_at").notNull().defaultNow(),
  },
  (t) => [index().on(t.userId)],
);

/**
 * 推播去重與節流：每個 API 執行個體都會收到同一個事件，
 * 由先寫入（或在節流時間外更新）這張表的執行個體負責送出。
 */
export const pushDispatches = pgTable("push_dispatches", {
  key: text("key").primaryKey(),
  sentAt: tstz("sent_at").notNull(),
});
