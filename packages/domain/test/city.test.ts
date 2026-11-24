import { describe, expect, it } from "vitest";
import { type AddressComponent, cityFromAddressComponents, slugifyCityName } from "../src/city.js";

const c = (longText: string, types: string[], shortText?: string): AddressComponent => ({
  longText,
  types,
  ...(shortText ? { shortText } : {}),
});

describe("cityFromAddressComponents", () => {
  it("東京都的各區都歸為東京", () => {
    const shibuya = [
      c("Shibuya", ["locality", "political"]),
      c("Tokyo", ["administrative_area_level_1", "political"]),
      c("Japan", ["country", "political"], "JP"),
    ];
    expect(cityFromAddressComponents(shibuya)).toEqual({
      countryCode: "JP",
      cityKey: "jp-tokyo",
      cityNameEn: "Tokyo",
    });
  });

  it("日本其他城市以 locality 為準", () => {
    const kyoto = [
      c("Higashiyama Ward", ["sublocality_level_1", "sublocality", "political"]),
      c("Kyoto", ["locality", "political"]),
      c("Kyoto", ["administrative_area_level_1", "political"]),
      c("Japan", ["country", "political"], "JP"),
    ];
    expect(cityFromAddressComponents(kyoto)?.cityKey).toBe("jp-kyoto");

    const osaka = [
      c("Osaka", ["locality", "political"]),
      c("Osaka", ["administrative_area_level_1", "political"]),
      c("Japan", ["country", "political"], "JP"),
    ];
    expect(cityFromAddressComponents(osaka)?.cityKey).toBe("jp-osaka");
  });

  it("台灣以直轄市／縣為準", () => {
    const daan = [
      c("Da’an District", ["administrative_area_level_2", "political"]),
      c("Taipei City", ["administrative_area_level_1", "political"]),
      c("Taiwan", ["country", "political"], "TW"),
    ];
    expect(cityFromAddressComponents(daan)).toEqual({
      countryCode: "TW",
      cityKey: "tw-taipei",
      cityNameEn: "Taipei",
    });

    const hualien = [
      c("Hualien City", ["locality", "political"]),
      c("Hualien County", ["administrative_area_level_1", "political"]),
      c("Taiwan", ["country", "political"], "TW"),
    ];
    expect(cityFromAddressComponents(hualien)?.cityKey).toBe("tw-hualien");
  });

  it("韓國等其他國家以 locality 為準", () => {
    const seoul = [
      c("Jongno District", ["sublocality_level_1", "sublocality", "political"]),
      c("Seoul", ["locality", "political"]),
      c("South Korea", ["country", "political"], "KR"),
    ];
    expect(cityFromAddressComponents(seoul)?.cityKey).toBe("kr-seoul");
  });

  it("沒有 locality 時依序退回 level 2、level 1", () => {
    expect(
      cityFromAddressComponents([
        c("Some County", ["administrative_area_level_2"]),
        c("Some State", ["administrative_area_level_1"]),
        c("United States", ["country"], "US"),
      ])?.cityKey,
    ).toBe("us-some");
  });

  it("沒有國家資訊時回傳 null", () => {
    expect(cityFromAddressComponents([c("Kyoto", ["locality"])])).toBeNull();
  });
});

describe("slugifyCityName", () => {
  it("去掉 City／County 等字尾並轉成小寫連字號", () => {
    expect(slugifyCityName("New Taipei City")).toBe("new-taipei");
    expect(slugifyCityName("Hualien County")).toBe("hualien");
    expect(slugifyCityName("São Paulo")).toBe("sao-paulo");
  });
});

describe("localizedCityName", () => {
  it("東京都的區也顯示為東京；日本去掉都府県市字尾", async () => {
    const { localizedCityName } = await import("../src/city.js");
    const en = [
      c("Shibuya", ["locality", "political"]),
      c("Tokyo", ["administrative_area_level_1", "political"]),
      c("Japan", ["country", "political"], "JP"),
    ];
    const ja = [
      c("渋谷区", ["locality", "political"]),
      c("東京都", ["administrative_area_level_1", "political"]),
      c("日本", ["country", "political"], "JP"),
    ];
    expect(localizedCityName(en, ja, "Tokyo")).toBe("東京");

    const kyotoEn = [
      c("Kyoto", ["locality"]),
      c("Kyoto", ["administrative_area_level_1"]),
      c("Japan", ["country"], "JP"),
    ];
    const kyotoJa = [
      c("京都市", ["locality"]),
      c("京都府", ["administrative_area_level_1"]),
      c("日本", ["country"], "JP"),
    ];
    expect(localizedCityName(kyotoEn, kyotoJa, "Kyoto")).toBe("京都");
  });

  it("台灣保留原名；找不到時用備援名稱", async () => {
    const { localizedCityName } = await import("../src/city.js");
    const en = [c("Taipei City", ["administrative_area_level_1"]), c("Taiwan", ["country"], "TW")];
    const zh = [c("臺北市", ["administrative_area_level_1"]), c("台灣", ["country"], "TW")];
    expect(localizedCityName(en, zh, "Taipei")).toBe("臺北市");
    expect(localizedCityName(en, [], "Taipei")).toBe("Taipei");
  });
});
