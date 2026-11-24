/**
 * 我的地點庫的城市歸類（ARCHITECTURE §5.6）。
 * 輸入為 Google Places（languageCode=en）的 addressComponents。
 */

export interface AddressComponent {
  longText: string;
  shortText?: string;
  types: readonly string[];
}

export interface CityKey {
  countryCode: string;
  cityKey: string;
  /** 用來產生 key 的英文名稱，介面顯示名稱另行以使用者語系取得。 */
  cityNameEn: string;
}

function find(components: readonly AddressComponent[], type: string): AddressComponent | undefined {
  return components.find((c) => c.types.includes(type));
}

const SUFFIXES = [/\s+city$/i, /\s+county$/i, /\s+prefecture$/i, /-shi$/i, /-ku$/i, /-to$/i];

export function slugifyCityName(name: string): string {
  let s = name.trim();
  for (const re of SUFFIXES) s = s.replace(re, "");
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * 選出代表「城市」的地址元件。規則：
 * - 台灣：以直轄市／縣（administrative_area_level_1）為城市
 * - 日本：東京都的各區、市町村一律歸為「東京」；其他以 locality 為城市
 * - 其他：locality → administrative_area_level_2 → administrative_area_level_1
 *
 * 同一個地點用不同語系查詢時，元件的 types 相同，因此可以用英文結果決定 key，
 * 再用同樣的 type 從使用者語系的結果取顯示名稱。
 */
export function cityComponent(
  components: readonly AddressComponent[],
): { countryCode: string; component: AddressComponent } | null {
  const country = find(components, "country");
  const countryCode = country?.shortText?.toUpperCase();
  if (!countryCode) return null;

  const admin1 = find(components, "administrative_area_level_1");
  const admin2 = find(components, "administrative_area_level_2");
  const locality = find(components, "locality");

  let picked: AddressComponent | undefined;
  if (countryCode === "TW") {
    picked = admin1 ?? locality;
  } else if (countryCode === "JP" && admin1 && slugifyCityName(admin1.longText) === "tokyo") {
    picked = admin1;
  } else {
    picked = locality ?? admin2 ?? admin1;
  }
  return picked ? { countryCode, component: picked } : null;
}

export function cityFromAddressComponents(components: readonly AddressComponent[]): CityKey | null {
  const found = cityComponent(components);
  if (!found) return null;
  const slug = slugifyCityName(found.component.longText);
  if (!slug) return null;
  return {
    countryCode: found.countryCode,
    cityKey: `${found.countryCode.toLowerCase()}-${slug}`,
    cityNameEn: found.component.longText.replace(/\s+(city|county|prefecture)$/i, "").trim(),
  };
}

/**
 * 使用者語系的城市顯示名稱。先用英文結果決定是哪一個地址元件（type），
 * 再從使用者語系的結果取同一個 type 的名稱。
 * 日本的「東京都」「京都市」「大阪府」去掉行政區字尾；其他國家保留原名（例如「臺北市」）。
 */
export function localizedCityName(
  englishComponents: readonly AddressComponent[],
  localizedComponents: readonly AddressComponent[],
  fallback: string,
): string {
  const found = cityComponent(englishComponents);
  if (!found) return fallback;
  const type = found.component.types.find((t) =>
    ["locality", "administrative_area_level_1", "administrative_area_level_2"].includes(t),
  );
  const localized = type ? find(localizedComponents, type) : undefined;
  if (!localized) return fallback;
  const name = localized.longText.trim();
  if (found.countryCode === "JP") return name.replace(/[都府県市]$/u, "") || name;
  return name;
}
