import type { AddressComponent } from "@travelog/domain";
import type { Config } from "../config.js";
import { ApiError } from "../lib/problem.js";

export interface PlaceSuggestion {
  googlePlaceId: string;
  mainText: string;
  secondaryText: string;
  types: string[];
}

export interface PlaceDetails {
  googlePlaceId: string;
  name: string;
  address: string | null;
  lat: number;
  lng: number;
  types: string[];
  googleMapsUri: string | null;
  /** 英文地址元件：用來決定城市 key。 */
  componentsEn: AddressComponent[];
  /** 使用者語系（zh-TW）地址元件：用來取城市顯示名稱。 */
  componentsLocal: AddressComponent[];
}

/** Google Places API（New）。介面化以便測試替換。 */
export interface PlacesProvider {
  autocomplete(params: {
    input: string;
    sessionToken: string;
    near?: { lat: number; lng: number } | undefined;
  }): Promise<PlaceSuggestion[]>;
  details(params: {
    googlePlaceId: string;
    sessionToken?: string | undefined;
  }): Promise<PlaceDetails>;
}

const BASE = "https://places.googleapis.com/v1";
const LANGUAGE = "zh-TW";

const unavailable = () =>
  new ApiError(
    503,
    "/problems/places-unavailable",
    "地點搜尋暫時無法使用（未設定 Google Maps 金鑰）",
  );

export function createGooglePlaces(config: Config): PlacesProvider {
  const key = config.mapsServerKey;

  async function call<T>(path: string, init: RequestInit & { fieldMask: string }): Promise<T> {
    if (!key) throw unavailable();
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": init.fieldMask,
      },
    });
    if (res.status === 404) throw new ApiError(404, "/problems/not-found", "找不到這個地點");
    if (!res.ok) {
      console.error("places api error", res.status, await res.text().catch(() => ""));
      throw new ApiError(502, "/problems/places-upstream", "地點服務發生錯誤，請稍後再試");
    }
    return (await res.json()) as T;
  }

  interface RawDetails {
    id: string;
    displayName?: { text: string };
    formattedAddress?: string;
    location?: { latitude: number; longitude: number };
    types?: string[];
    googleMapsUri?: string;
    addressComponents?: AddressComponent[];
  }

  return {
    async autocomplete({ input, sessionToken, near }) {
      const body: Record<string, unknown> = { input, sessionToken, languageCode: LANGUAGE };
      if (near) {
        body.locationBias = {
          circle: { center: { latitude: near.lat, longitude: near.lng }, radius: 30_000 },
        };
      }
      const data = await call<{
        suggestions?: Array<{
          placePrediction?: {
            placeId: string;
            types?: string[];
            structuredFormat?: { mainText?: { text: string }; secondaryText?: { text: string } };
          };
        }>;
      }>("/places:autocomplete", {
        method: "POST",
        body: JSON.stringify(body),
        fieldMask:
          "suggestions.placePrediction.placeId,suggestions.placePrediction.types,suggestions.placePrediction.structuredFormat",
      });
      return (data.suggestions ?? [])
        .map((s) => s.placePrediction)
        .filter((p): p is NonNullable<typeof p> => !!p)
        .map((p) => ({
          googlePlaceId: p.placeId,
          mainText: p.structuredFormat?.mainText?.text ?? "",
          secondaryText: p.structuredFormat?.secondaryText?.text ?? "",
          types: p.types ?? [],
        }));
    },

    async details({ googlePlaceId, sessionToken }) {
      const id = encodeURIComponent(googlePlaceId);
      const session = sessionToken ? `&sessionToken=${encodeURIComponent(sessionToken)}` : "";
      const [local, en] = await Promise.all([
        call<RawDetails>(`/places/${id}?languageCode=${LANGUAGE}${session}`, {
          method: "GET",
          fieldMask:
            "id,displayName,formattedAddress,location,types,googleMapsUri,addressComponents",
        }),
        call<RawDetails>(`/places/${id}?languageCode=en`, {
          method: "GET",
          fieldMask: "id,addressComponents",
        }),
      ]);
      if (!local.location)
        throw new ApiError(422, "/problems/place-no-location", "這個地點沒有座標");
      return {
        googlePlaceId: local.id,
        name: local.displayName?.text ?? "",
        address: local.formattedAddress ?? null,
        lat: local.location.latitude,
        lng: local.location.longitude,
        types: local.types ?? [],
        googleMapsUri: local.googleMapsUri ?? null,
        componentsEn: en.addressComponents ?? [],
        componentsLocal: local.addressComponents ?? [],
      };
    },
  };
}
