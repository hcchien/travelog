import { type Database, schema } from "@travelog/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { readPublicJson } from "../lib/public-https.js";

export type OAuthClientRow = typeof schema.oauthClients.$inferSelect;

/** redirect_uri：https，或本機 loopback（給桌面版 client）。不可帶 fragment。 */
export function isAllowedRedirectUri(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.hash || u.username || u.password) return false;
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
}

export const clientMetadata = z.object({
  redirect_uris: z.array(z.string().max(2000)).min(1).max(10),
  client_name: z.string().max(200).optional(),
  client_uri: z.url().max(2000).optional(),
  logo_uri: z.url().max(2000).optional(),
  token_endpoint_auth_method: z.literal("none").default("none"),
  grant_types: z.array(z.enum(["authorization_code", "refresh_token"])).optional(),
  response_types: z.array(z.literal("code")).optional(),
});

/** 抓取 Client ID Metadata Document（client_id 為 https URL）。介面化以便測試替換。 */
export type FetchClientMetadata = (url: string) => Promise<unknown>;

export const fetchClientMetadataOverHttps: FetchClientMetadata = readPublicJson;

const CIMD_REFRESH_MS = 24 * 3_600_000;

/**
 * 取得 OAuth client：
 * - client_id 為 https URL → Client ID Metadata Document（快取 24 小時）
 * - 其他 → Dynamic Client Registration 註冊過的 client
 */
export async function findClient(
  db: Database,
  clientId: string,
  opts: { fetchMetadata: FetchClientMetadata; now: () => Date },
): Promise<OAuthClientRow | null> {
  const [row] = await db
    .select()
    .from(schema.oauthClients)
    .where(eq(schema.oauthClients.clientId, clientId));
  if (!clientId.startsWith("https://")) return row ?? null;
  if (
    row?.metadataFetchedAt &&
    opts.now().getTime() - row.metadataFetchedAt.getTime() < CIMD_REFRESH_MS
  ) {
    return row;
  }
  let doc: z.infer<typeof clientMetadata> & { client_id?: unknown };
  try {
    const raw = (await opts.fetchMetadata(clientId)) as Record<string, unknown>;
    doc = { ...clientMetadata.parse(raw), client_id: raw.client_id };
  } catch {
    return null; // Expired metadata fails closed; revoked redirect URIs must not live indefinitely.
  }
  if (doc.client_id !== clientId || !doc.redirect_uris.every(isAllowedRedirectUri)) return null;
  const values = {
    clientId,
    kind: "cimd" as const,
    clientName: doc.client_name ?? new URL(clientId).hostname,
    clientUri: doc.client_uri ?? null,
    logoUri: doc.logo_uri ?? null,
    redirectUris: doc.redirect_uris,
    metadataFetchedAt: opts.now(),
  };
  const [saved] = await db
    .insert(schema.oauthClients)
    .values(values)
    .onConflictDoUpdate({ target: schema.oauthClients.clientId, set: values })
    .returning();
  return saved ?? null;
}
