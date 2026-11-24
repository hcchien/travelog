import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Hono } from "hono";
import { ApiError, notFound } from "./problem.js";

/**
 * 附件儲存（ARCHITECTURE §6.1、§10）。客戶端直接上傳／下載，API 只發短效簽章網址。
 */
export interface StorageAdapter {
  /** 上傳用的簽章網址；客戶端必須帶上回傳的 headers。 */
  signUpload(
    key: string,
    file: { mime: string; size: number },
  ): Promise<{ url: string; headers: Record<string, string> }>;
  /** 物件存在時回傳大小。 */
  stat(key: string): Promise<{ size: number; generation: string } | null>;
  signDownload(key: string, file: { filename: string; mime: string; generation?: string | null }): Promise<string>;
  remove(key: string): Promise<void>;
}

export const UPLOAD_URL_TTL_MS = 15 * 60 * 1000;
export const DOWNLOAD_URL_TTL_MS = 5 * 60 * 1000;

/** PDF 可以在瀏覽器直接開；其他一律下載，避免在自家網域執行內容（ARCHITECTURE §11）。 */
export function contentDisposition(filename: string, mime: string) {
  const type = mime === "application/pdf" ? "inline" : "attachment";
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

// ---- GCS

export async function createGcsStorage(bucketName: string): Promise<StorageAdapter> {
  const { Storage } = await import("@google-cloud/storage");
  const bucket = new Storage().bucket(bucketName);
  return {
    async signUpload(key, { mime, size }) {
      const headers = { "Content-Type": mime, "x-goog-content-length-range": `${size},${size}`, "x-goog-if-generation-match": "0" };
      const [url] = await bucket.file(key).getSignedUrl({
        version: "v4",
        action: "write",
        expires: Date.now() + UPLOAD_URL_TTL_MS,
        contentType: mime,
        extensionHeaders: { "x-goog-content-length-range": `${size},${size}`, "x-goog-if-generation-match": "0" },
      });
      return { url, headers };
    },
    async stat(key) {
      const [exists] = await bucket.file(key).exists();
      if (!exists) return null;
      const [meta] = await bucket.file(key).getMetadata();
      return { size: Number(meta.size), generation: String(meta.generation) };
    },
    async signDownload(key, { filename, mime, generation }) {
      const [url] = await bucket.file(key).getSignedUrl({
        version: "v4",
        action: "read",
        expires: Date.now() + DOWNLOAD_URL_TTL_MS,
        responseDisposition: contentDisposition(filename, mime),
        responseType: mime,
        ...(generation ? { queryParams: { generation } } : {}),
      });
      return url;
    },
    async remove(key) {
      await bucket.file(key).delete({ ignoreNotFound: true });
    },
  };
}

// ---- 本機（開發、沙盒、測試）：以 HMAC 簽章模擬 signed URL

interface LocalGrant {
  k: string;
  op: "put" | "get";
  exp: number;
  mime: string;
  size?: number;
  name?: string;
  generation?: string;
}

export function createLocalStorage(opts: {
  dir: string;
  apiOrigin: string;
  secret: string;
  now?: () => Date;
}): StorageAdapter & { routes: Hono } {
  const root = resolve(opts.dir);
  const now = opts.now ?? (() => new Date());
  const pathOf = (key: string) => {
    const p = resolve(join(root, key));
    if (!p.startsWith(`${root}/`)) throw new Error("非法的儲存路徑");
    return p;
  };
  const sign = (payload: string) =>
    createHmac("sha256", opts.secret).update(payload).digest("base64url");
  const issue = (g: LocalGrant) => {
    const payload = Buffer.from(JSON.stringify(g)).toString("base64url");
    return `${opts.apiOrigin}/v1/local-storage/${payload}.${sign(payload)}`;
  };
  const verify = (token: string, op: LocalGrant["op"]): LocalGrant => {
    const [payload, sig] = token.split(".");
    if (!payload || !sig) throw notFound();
    const expected = Buffer.from(sign(payload));
    const got = Buffer.from(sig);
    if (expected.length !== got.length || !timingSafeEqual(expected, got)) throw notFound();
    const g = JSON.parse(Buffer.from(payload, "base64url").toString()) as LocalGrant;
    if (g.op !== op) throw notFound();
    if (g.exp < now().getTime()) throw new ApiError(403, "/problems/expired", "網址已過期");
    return g;
  };

  const routes = new Hono();
  routes.put("/v1/local-storage/:token", async (c) => {
    const g = verify(c.req.param("token"), "put");
    if (c.req.header("content-type") !== g.mime)
      throw new ApiError(400, "/problems/bad-upload", "Content-Type 不符");
    const body = Buffer.from(await c.req.arrayBuffer());
    if (body.length !== g.size) throw new ApiError(400, "/problems/bad-upload", "檔案大小不符");
    const p = pathOf(g.k);
    await mkdir(dirname(p), { recursive: true });
    const temporary = `${p}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, body, { flag: "wx" });
      await link(temporary, p); // Atomic create-only publish: never expose a partially written object.
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new ApiError(412, "/problems/object-exists", "上傳網址已使用");
      throw err;
    } finally { await rm(temporary, { force: true }); }
    return c.body(null, 200);
  });
  routes.get("/v1/local-storage/:token", async (c) => {
    const g = verify(c.req.param("token"), "get");
    const data = await readFile(pathOf(g.k)).catch(() => null);
    if (!data || (g.generation && createHash("sha256").update(data).digest("hex") !== g.generation)) throw notFound("檔案");
    return c.body(data, 200, {
      "Content-Type": g.mime,
      "Content-Disposition": contentDisposition(g.name ?? "file", g.mime),
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox",
      "Cache-Control": "private, no-store",
    });
  });

  return {
    routes,
    async signUpload(key, { mime, size }) {
      return {
        url: issue({ k: key, op: "put", exp: now().getTime() + UPLOAD_URL_TTL_MS, mime, size }),
        headers: { "Content-Type": mime },
      };
    },
    async stat(key) {
      const data = await readFile(pathOf(key)).catch(() => null);
      return data ? { size: data.length, generation: createHash("sha256").update(data).digest("hex") } : null;
    },
    async signDownload(key, { filename, mime, generation }) {
      return issue({
        k: key,
        op: "get",
        exp: now().getTime() + DOWNLOAD_URL_TTL_MS,
        mime,
        name: filename,
        ...(generation ? { generation } : {}),
      });
    },
    async remove(key) {
      await rm(pathOf(key), { force: true });
    },
  };
}
