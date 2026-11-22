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
    /** 第一方 client 為 web 或 app；其他為 OAuth client（例如 MCP client）的 client_id。 */
    clientId: text("client_id").notNull(),
    /** OAuth client 被授權的 scope（空白分隔）；第一方 client 為 null。 */
    scope: text("scope"),
    /** OAuth access token 的 audience（MCP 資源）。 */
    resource: text("resource"),
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

/**
 * OAuth client（ARCHITECTURE §4.2）。來源：
 * - dcr：Dynamic Client Registration（RFC 7591），client_id 由我們產生
 * - cimd：Client ID Metadata Document，client_id 即 https URL，內容定期重新抓取
 */
export const oauthClients = pgTable("oauth_clients", {
  id: id(),
  clientId: text("client_id").notNull().unique(),
  kind: text("kind", { enum: ["dcr", "cimd"] }).notNull(),
  clientName: text("client_name"),
  clientUri: text("client_uri"),
  logoUri: text("logo_uri"),
  redirectUris: text("redirect_uris").array().notNull(),
  metadataFetchedAt: tstz("metadata_fetched_at"),
  createdAt: createdAt(),
});

/** 授權請求：從 /oauth/authorize 到使用者同意、換發授權碼。 */
export const oauthRequests = pgTable(
  "oauth_requests",
  {
    id: id(),
    clientId: text("client_id").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    scope: text("scope").notNull(),
    state: text("state"),
    codeChallenge: text("code_challenge").notNull(),
    resource: text("resource").notNull(),
    status: text("status", { enum: ["pending", "approved", "denied", "used"] })
      .notNull()
      .default("pending"),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    /** 使用者同意的 scope（可能少於請求的）。 */
    grantedScope: text("granted_scope"),
    codeHash: text("code_hash").unique(),
    codeExpiresAt: tstz("code_expires_at"),
    expiresAt: tstz("expires_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.clientId)],
);
