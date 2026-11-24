import { z } from "zod";

/** 附件只收文件與截圖（ARCHITECTURE §6.1），不做照片相簿。 */
export const ATTACHMENT_MIME = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

export const createUploadInput = z.object({
  filename: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine(
      (f) => !/[\\/]/.test(f) && [...f].every((ch) => (ch.codePointAt(0) ?? 0) >= 0x20),
      "檔名不能包含路徑或控制字元",
    ),
  mime: z.enum(ATTACHMENT_MIME, { message: "只接受 PDF、PNG、JPEG、WebP" }),
  sizeBytes: z.number().int().positive().max(ATTACHMENT_MAX_BYTES, "檔案不能超過 10 MB"),
  itemId: z.uuid().nullable().optional(),
});
