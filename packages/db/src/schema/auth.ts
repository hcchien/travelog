import { index, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, tstz } from "./columns.js";
import { users } from "./users.js";

/**
 * Refresh token（只存 SHA-256 雜湊）。每次使用都會輪替；
 * 已被替換的 token 再次出現時，視為外洩，撤銷整個 family。
 */
export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    familyId: uuid("family_id").notNull(),
    /** 第一方 client：web 或 app。之後 MCP 的 OAuth client 也會用這張表。 */
    clientId: text("client_id").notNull(),
    expiresAt: tstz("expires_at").notNull(),
    revokedAt: tstz("revoked_at"),
    replacedAt: tstz("replaced_at"),
    createdAt: createdAt(),
    lastUsedAt: tstz("last_used_at"),
  },
  (t) => [index().on(t.userId), index().on(t.familyId)],
);

/** WebAuthn challenge：5 分鐘、單次使用。 */
export const webauthnChallenges = pgTable("webauthn_challenges", {
  id: id(),
  challenge: text("challenge").notNull(),
  purpose: text("purpose", { enum: ["register", "login"] }).notNull(),
  /** 註冊時為目前登入的使用者；登入時為 null。 */
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  expiresAt: tstz("expires_at").notNull(),
  createdAt: createdAt(),
});
