import { describe, expect, it } from "vitest";
import { connectionOptions } from "../src/client.js";

describe("connectionOptions", () => {
  it("一般網址維持原樣", () => {
    expect(connectionOptions("postgres://u:p@localhost:5432/db")).toEqual({
      url: "postgres://u:p@localhost:5432/db",
    });
  });

  it("Cloud SQL unix socket 轉成 path", () => {
    const r = connectionOptions(
      "postgres://travelog:p%40ss@localhost/travelog?host=/cloudsql/proj:asia-east1:travelog-dev",
    );
    expect(r.path).toBe("/cloudsql/proj:asia-east1:travelog-dev/.s.PGSQL.5432");
    expect(r.url).not.toContain("host=");
    expect(new URL(r.url).password).toBe("p%40ss");
    expect(new URL(r.url).pathname).toBe("/travelog");
  });
});
