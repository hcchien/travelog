import { describe, expect, it } from "vitest";
import { safeReturnTo } from "../src/auth/session.js";

describe("safeReturnTo", () => {
  it("preserves relative paths and rejects external redirects", () => {
    expect(safeReturnTo("/trips?tab=saved#map")).toBe("/trips?tab=saved#map");
    for (const value of [undefined, "", "https://example.com", "//example.com", "/\\example.com"]) {
      expect(safeReturnTo(value)).toBe("/");
    }
  });

  it("rejects every ASCII control character and space in return paths", () => {
    for (let code = 0; code <= 0x20; code++) {
      expect(safeReturnTo(`/trips${String.fromCharCode(code)}next`)).toBe("/");
    }
    expect(safeReturnTo(`/trips${String.fromCharCode(0x7f)}next`)).toBe("/");
  });
});
