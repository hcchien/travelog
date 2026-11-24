import { z } from "zod";

const list = z
  .string()
  .default("")
  .transform((s) =>
    s
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
  );

/** Secret Manager 不能存空字串：部署時以 "unset" 表示「未設定」。 */
const optionalSecret = z
  .string()
  .optional()
  .transform((v) => (v && v !== "unset" ? v : undefined));

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().default(8080),
  DATABASE_URL: z.string().min(1),
  /** Web 前端的 origin，例如 http://localhost:3000。也用於 WebAuthn origin 檢查。 */
  APP_ORIGIN: z.url(),
  /** API 自己的對外網址，用於 OAuth 回呼。 */
  API_ORIGIN: z.url(),
  /** 額外允許的 origin（逗號分隔），例如 staging 網址。 */
  EXTRA_ORIGINS: list,
  /** WebAuthn RP ID：正式環境使用根網域，定了之後不能改。 */
  WEBAUTHN_RP_ID: z.string().min(1),
  WEBAUTHN_RP_NAME: z.string().default("Travelog"),
  /** App 的 WebAuthn origin（例如 android:apk-key-hash:...），逗號分隔。 */
  WEBAUTHN_APP_ORIGINS: list,
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  /** iOS / Android 原生 Google Sign-In 的 client ID（逗號分隔），作為可接受的 aud。 */
  GOOGLE_NATIVE_CLIENT_IDS: list,
  /** 簽章 cookie 用的密鑰，至少 32 字元。 */
  COOKIE_SECRET: z.string().min(32),
  /** ES256 私鑰（PKCS#8 PEM）。開發環境可省略，啟動時會產生暫時金鑰。 */
  JWT_PRIVATE_KEY: z.string().optional(),
  JWT_ISSUER: z.string().default("travelog"),
  /** Google Maps Platform 伺服器金鑰（Places API New）。未設定時地點搜尋回 503。 */
  GOOGLE_MAPS_SERVER_KEY: optionalSecret,
  /** 附件儲存：gcs（staging／正式）或 local（本機檔案系統）。 */
  STORAGE_DRIVER: z.enum(["gcs", "local"]).default("local"),
  GCS_BUCKET: z.string().optional(),
  LOCAL_STORAGE_DIR: z.string().default(".data/attachments"),
  /** Resend API 金鑰。未設定時信件只寫到 log。 */
  RESEND_API_KEY: optionalSecret,
  /** 寄件者，例如 "Travelog <hello@travelog.app>"（網域需先在 Resend 驗證）。 */
  MAIL_FROM: z.string().default("Travelog <onboarding@resend.dev>"),
});

export type Env = z.infer<typeof envSchema>;

export interface Config {
  env: Env["NODE_ENV"];
  port: number;
  databaseUrl: string;
  appOrigin: string;
  apiOrigin: string;
  allowedOrigins: string[];
  webauthn: { rpId: string; rpName: string; origins: string[] };
  google: { clientId: string; clientSecret: string; audiences: string[]; redirectUri: string };
  cookieSecret: string;
  secureCookies: boolean;
  jwt: { privateKeyPem: string | undefined; issuer: string };
  accessTokenTtlSeconds: number;
  refreshTokenTtlDays: number;
  mapsServerKey: string | undefined;
  storage: { driver: "gcs"; bucket: string } | { driver: "local"; dir: string };
  mail: { resendApiKey: string | undefined; from: string };
}

export function loadConfig(source: Record<string, string | undefined> = process.env): Config {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`環境變數設定錯誤：\n${issues}`);
  }
  const e = parsed.data;
  if (e.NODE_ENV === "production" && !e.JWT_PRIVATE_KEY) {
    throw new Error("正式環境必須設定 JWT_PRIVATE_KEY");
  }
  if (e.STORAGE_DRIVER === "gcs" && !e.GCS_BUCKET) {
    throw new Error("STORAGE_DRIVER=gcs 時必須設定 GCS_BUCKET");
  }
  if (e.NODE_ENV === "production" && e.STORAGE_DRIVER !== "gcs") {
    throw new Error("正式環境的附件必須存在 GCS（STORAGE_DRIVER=gcs）");
  }
  const allowedOrigins = [e.APP_ORIGIN, ...e.EXTRA_ORIGINS].map((o) => new URL(o).origin);
  return {
    env: e.NODE_ENV,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    appOrigin: new URL(e.APP_ORIGIN).origin,
    apiOrigin: new URL(e.API_ORIGIN).origin,
    allowedOrigins,
    webauthn: {
      rpId: e.WEBAUTHN_RP_ID,
      rpName: e.WEBAUTHN_RP_NAME,
      origins: [...allowedOrigins, ...e.WEBAUTHN_APP_ORIGINS],
    },
    google: {
      clientId: e.GOOGLE_CLIENT_ID,
      clientSecret: e.GOOGLE_CLIENT_SECRET,
      audiences: [e.GOOGLE_CLIENT_ID, ...e.GOOGLE_NATIVE_CLIENT_IDS],
      redirectUri: `${new URL(e.APP_ORIGIN).origin}/session/google/callback`,
    },
    cookieSecret: e.COOKIE_SECRET,
    secureCookies: e.NODE_ENV === "production" || new URL(e.API_ORIGIN).protocol === "https:",
    jwt: { privateKeyPem: e.JWT_PRIVATE_KEY, issuer: e.JWT_ISSUER },
    accessTokenTtlSeconds: 15 * 60,
    refreshTokenTtlDays: 60,
    mapsServerKey: e.GOOGLE_MAPS_SERVER_KEY || undefined,
    storage:
      e.STORAGE_DRIVER === "gcs"
        ? { driver: "gcs", bucket: e.GCS_BUCKET as string }
        : { driver: "local", dir: e.LOCAL_STORAGE_DIR },
    mail: { resendApiKey: e.RESEND_API_KEY || undefined, from: e.MAIL_FROM },
  };
}
