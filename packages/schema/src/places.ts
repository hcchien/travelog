import { SAVED_PLACE_CATEGORIES } from "@travelog/domain";
import { z } from "zod";

export const googlePlaceId = z.string().min(1).max(300);

export const autocompleteQuery = z.object({
  q: z.string().trim().min(1).max(100),
  session: z.string().min(8).max(100),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
});

export const resolvePlaceInput = z.object({
  googlePlaceId,
  sessionToken: z.string().max(100).optional(),
});

export const savedPlaceCategory = z.enum(SAVED_PLACE_CATEGORIES);

export const createSavedPlaceInput = z.object({
  googlePlaceId,
  sessionToken: z.string().max(100).optional(),
  /** 省略時依地點類型推測。 */
  category: savedPlaceCategory.optional(),
  tags: z.array(z.string().max(40)).max(20).default([]),
  privateNote: z.string().max(2000).nullable().default(null),
});

export const updateSavedPlaceInput = z
  .object({
    category: savedPlaceCategory,
    tags: z.array(z.string().max(40)).max(20),
    privateNote: z.string().max(2000).nullable(),
    /** 手動調整城市歸類。 */
    cityKey: z.string().min(1).max(80),
    cityName: z.string().min(1).max(80),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "至少要修改一個欄位")
  .refine((v) => (v.cityKey === undefined) === (v.cityName === undefined), {
    message: "cityKey 與 cityName 要一起修改",
    path: ["cityName"],
  });

export const addWishlistInput = z
  .object({
    googlePlaceId: googlePlaceId.optional(),
    /** 從我的地點庫加入。 */
    savedPlaceId: z.uuid().optional(),
    /** 從地點庫加入時，是否把私人備註一併帶入（成員都看得到）。 */
    includePrivateNote: z.boolean().default(false),
    note: z.string().max(1000).nullable().default(null),
    sessionToken: z.string().max(100).optional(),
  })
  .refine((v) => (v.googlePlaceId === undefined) !== (v.savedPlaceId === undefined), {
    message: "googlePlaceId 與 savedPlaceId 必須擇一",
  });

export const scheduleWishlistInput = z.object({
  dayId: z.uuid().nullable(),
  index: z.number().int().min(0).default(Number.MAX_SAFE_INTEGER),
  /** 排入後是否保留在想去清單。預設移除。 */
  keepInWishlist: z.boolean().default(false),
});
