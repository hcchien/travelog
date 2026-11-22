import type { JournalBlock, JournalDoc, JournalInline, JournalMark } from "@travelog/domain";
import { z } from "zod";
import { isoDate } from "./common.js";

/**
 * 心得內容的受限 schema：只允許文字類節點。未知欄位（例如 Tiptap 的 class、target）一律剝除，
 * 未知節點（例如 image）直接拒絕。
 */
const safeHref = z
  .string()
  .max(2000)
  .refine((h) => /^https?:\/\//i.test(h), "連結只能是 http 或 https");

const mark: z.ZodType<JournalMark> = z.union([
  z.object({ type: z.enum(["bold", "italic", "strike", "code"]) }),
  z.object({ type: z.literal("link"), attrs: z.object({ href: safeHref }) }),
]);

const inline: z.ZodType<JournalInline> = z.union([
  z.object({
    type: z.literal("text"),
    text: z.string().min(1).max(10_000),
    marks: z.array(mark).max(5).optional(),
  }),
  z.object({ type: z.literal("hardBreak") }),
]);

const block: z.ZodType<JournalBlock> = z.lazy(() =>
  z.union([
    z.object({ type: z.literal("paragraph"), content: z.array(inline).max(500).optional() }),
    z.object({
      type: z.literal("heading"),
      attrs: z.object({ level: z.union([z.literal(2), z.literal(3)]) }),
      content: z.array(inline).max(500).optional(),
    }),
    z.object({
      type: z.enum(["bulletList", "orderedList"]),
      content: z
        .array(z.object({ type: z.literal("listItem"), content: z.array(block).min(1).max(50) }))
        .min(1)
        .max(200),
    }),
    z.object({ type: z.literal("blockquote"), content: z.array(block).min(1).max(200) }),
    z.object({ type: z.literal("horizontalRule") }),
  ]),
);

export const journalDoc: z.ZodType<JournalDoc> = z
  .object({ type: z.literal("doc"), content: z.array(block).max(2000) })
  .refine((d) => JSON.stringify(d).length <= 200_000, "心得太長了");

export const journalScopeInput = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("trip") }),
  z.object({ scope: z.literal("day"), dayId: z.uuid() }),
  z.object({ scope: z.literal("item"), itemId: z.uuid() }),
]);

const entryFields = {
  title: z.string().trim().max(200).nullable().optional(),
  /** 給 Web／App 編輯器：受限的 ProseMirror JSON。 */
  body: journalDoc.optional(),
  /** 給 MCP：純文字，每一行一段。body 與 bodyText 擇一。 */
  bodyText: z.string().max(50_000).optional(),
  visibility: z.enum(["members", "public"]).optional(),
};

export const createJournalEntryInput = z
  .object({ ...entryFields, target: journalScopeInput })
  .refine(
    (v) => (v.body === undefined) !== (v.bodyText === undefined),
    "body 與 bodyText 必須擇一",
  );

export const updateJournalEntryInput = z
  .object({ ...entryFields, version: z.number().int().positive() })
  .refine((v) => !(v.body !== undefined && v.bodyText !== undefined), "body 與 bodyText 只能擇一");

/** 把某天自己的快速筆記併入心得（沒有就建立當天的心得）。 */
export const mergeNotesInput = z.object({
  dayId: z.uuid(),
  noteIds: z.array(z.uuid()).min(1).max(200).optional(),
});

export const journalQuery = z.object({
  date: isoDate.optional(),
});

export const createShareLinkInput = z.object({
  /** 公開頁是否隱藏住宿。預設隱藏，避免透露住哪裡。 */
  hideLodging: z.boolean().default(true),
  /** 公開頁是否只顯示心得（不顯示行程表）。 */
  journalOnly: z.boolean().default(false),
});
