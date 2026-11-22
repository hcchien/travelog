import { z } from "zod";
import { instant } from "./common.js";

export const createNoteInput = z.object({
  body: z.string().trim().min(1).max(2000),
  /** 省略時為現在。 */
  takenAt: instant.optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  itemId: z.uuid().optional(),
  /** 指定要記在哪一天；省略時依 takenAt 的日期對應。 */
  dayId: z.uuid().optional(),
});

export const searchQuery = z.object({
  q: z.string().trim().min(1).max(100),
});
