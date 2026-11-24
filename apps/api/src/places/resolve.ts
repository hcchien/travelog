import tzlookup from "@photostructure/tz-lookup";
import { type DbOrTx, schema } from "@travelog/db";
import {
  categoryFromPlaceTypes,
  cityFromAddressComponents,
  localizedCityName,
} from "@travelog/domain";
import { eq } from "drizzle-orm";
import type { PlacesProvider } from "./provider.js";

export type PlaceRow = typeof schema.places.$inferSelect;

/** 依 Google Maps Platform 條款，除 place_id 外的欄位需定期刷新。 */
const REFRESH_AFTER_MS = 30 * 86_400_000;

export interface PlaceMetadata {
  types?: string[];
  googleMapsUri?: string | null;
  cityName?: string | null;
}

export const serializePlace = (p: PlaceRow) => {
  const meta = p.metadata as PlaceMetadata;
  return {
    id: p.id,
    googlePlaceId: p.googlePlaceId,
    name: p.name,
    address: p.address,
    lat: p.location?.y ?? null,
    lng: p.location?.x ?? null,
    tz: p.tz,
    cityKey: p.cityKey,
    cityName: meta.cityName ?? null,
    types: meta.types ?? [],
    category: categoryFromPlaceTypes(meta.types ?? []),
    googleMapsUri: meta.googleMapsUri ?? null,
  };
};

/**
 * 取得地點（必要時向 Google 查詢並寫入快取），回傳 places 資料列。
 */
export async function resolvePlace(
  db: DbOrTx,
  provider: PlacesProvider,
  googlePlaceId: string,
  opts: { sessionToken?: string | undefined; now: () => Date },
): Promise<PlaceRow> {
  const [cached] = await db
    .select()
    .from(schema.places)
    .where(eq(schema.places.googlePlaceId, googlePlaceId));
  if (cached && opts.now().getTime() - cached.fetchedAt.getTime() < REFRESH_AFTER_MS) return cached;

  const d = await provider.details({ googlePlaceId, sessionToken: opts.sessionToken });
  const city = cityFromAddressComponents(d.componentsEn);
  let tz: string | null = null;
  try {
    tz = tzlookup(d.lat, d.lng);
  } catch {
    tz = null;
  }
  const values = {
    googlePlaceId: d.googlePlaceId,
    name: d.name,
    address: d.address,
    location: { x: d.lng, y: d.lat },
    tz,
    cityKey: city?.cityKey ?? null,
    metadata: {
      types: d.types,
      googleMapsUri: d.googleMapsUri,
      cityName: city ? localizedCityName(d.componentsEn, d.componentsLocal, city.cityNameEn) : null,
    } satisfies PlaceMetadata,
    fetchedAt: opts.now(),
  };
  const [row] = await db
    .insert(schema.places)
    .values(values)
    .onConflictDoUpdate({ target: schema.places.googlePlaceId, set: values })
    .returning();
  if (!row) throw new Error("寫入地點失敗");
  return row;
}
