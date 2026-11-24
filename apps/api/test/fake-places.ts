import type { AddressComponent } from "@travelog/domain";
import { ApiError } from "../src/lib/problem.js";
import type { PlaceDetails, PlacesProvider } from "../src/places/provider.js";

const c = (longText: string, types: string[], shortText?: string): AddressComponent => ({
  longText,
  types,
  ...(shortText ? { shortText } : {}),
});

const jp = (cityEn: string, cityJa: string, admin1En: string, admin1Ja: string) => ({
  en: [
    c(cityEn, ["locality", "political"]),
    c(admin1En, ["administrative_area_level_1"]),
    c("Japan", ["country"], "JP"),
  ],
  local: [
    c(cityJa, ["locality", "political"]),
    c(admin1Ja, ["administrative_area_level_1"]),
    c("日本", ["country"], "JP"),
  ],
});

const kyoto = jp("Kyoto", "京都市", "Kyoto", "京都府");
const shibuya = jp("Shibuya", "渋谷区", "Tokyo", "東京都");
const taipei = {
  en: [c("Taipei City", ["administrative_area_level_1"]), c("Taiwan", ["country"], "TW")],
  local: [c("臺北市", ["administrative_area_level_1"]), c("台灣", ["country"], "TW")],
};

const fixture = (
  id: string,
  name: string,
  lat: number,
  lng: number,
  types: string[],
  comps: { en: AddressComponent[]; local: AddressComponent[] },
): PlaceDetails => ({
  googlePlaceId: id,
  name,
  address: `${name} 的地址`,
  lat,
  lng,
  types,
  googleMapsUri: `https://maps.google.com/?cid=${id}`,
  componentsEn: comps.en,
  componentsLocal: comps.local,
});

export const PLACES: Record<string, PlaceDetails> = {
  "kyoto-city": fixture(
    "kyoto-city",
    "京都市",
    35.0116,
    135.7681,
    ["locality", "political"],
    kyoto,
  ),
  "tokyo-city": fixture(
    "tokyo-city",
    "東京",
    35.6762,
    139.6503,
    ["locality", "political"],
    shibuya,
  ),
  kinkaku: fixture(
    "kinkaku",
    "金閣寺",
    35.0394,
    135.7292,
    ["place_of_worship", "tourist_attraction"],
    kyoto,
  ),
  arashiyama: fixture(
    "arashiyama",
    "嵐山竹林小徑",
    35.017,
    135.6713,
    ["tourist_attraction", "park"],
    kyoto,
  ),
  kiyomizu: fixture(
    "kiyomizu",
    "清水寺",
    34.9949,
    135.785,
    ["place_of_worship", "tourist_attraction"],
    kyoto,
  ),
  fushimi: fixture(
    "fushimi",
    "伏見稻荷大社",
    34.9671,
    135.7727,
    ["shrine", "tourist_attraction"],
    kyoto,
  ),
  ponto: fixture("ponto", "先斗町 川床料理", 35.0055, 135.7707, ["restaurant", "food"], kyoto),
  fuglen: fixture("fuglen", "Fuglen Tokyo", 35.6667, 139.6923, ["cafe", "food"], shibuya),
  ichiran: fixture(
    "ichiran",
    "一蘭 澀谷店",
    35.6614,
    139.7005,
    ["ramen_restaurant", "restaurant"],
    shibuya,
  ),
  taipei101: fixture("taipei101", "台北 101", 25.0339, 121.5645, ["tourist_attraction"], taipei),
};

export function createFakePlaces() {
  const calls = { details: 0 };
  const provider: PlacesProvider = {
    async autocomplete({ input }) {
      return Object.values(PLACES)
        .filter((p) => p.name.includes(input))
        .map((p) => ({
          googlePlaceId: p.googlePlaceId,
          mainText: p.name,
          secondaryText: p.address ?? "",
          types: p.types,
        }));
    },
    async details({ googlePlaceId }) {
      calls.details += 1;
      const p = PLACES[googlePlaceId];
      if (!p) throw new ApiError(404, "/problems/not-found", "找不到這個地點");
      return p;
    },
  };
  return { provider, calls };
}
