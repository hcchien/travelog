import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SoftAuthenticator } from "./authenticator.js";
import { APP_ORIGIN, createTestApp, type TestApp } from "./helpers.js";

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

describe("Google 登入（原生 App）", () => {
  it("第一次登入建立帳號，之後同一個 Google 帳號回到同一個使用者", async () => {
    const a = await t.login("alice-sub", "Alice");
    const again = await t.login("alice-sub", "Alice");
    expect(again.userId).toBe(a.userId);
    const me = await t.request("GET", "/v1/me", { token: a.token });
    expect(me.json.displayName).toBe("Alice");
    expect(me.json.identities).toEqual([
      expect.objectContaining({ provider: "google", email: "alice-sub@example.com" }),
    ]);
  });

  it("不依 email 合併帳號：不同 Google 帳號即使 email 相同也是不同使用者", async () => {
    const a = await t.request("POST", "/v1/auth/google/native", {
      body: { idToken: "google|sub-1|same@example.com|A|" },
    });
    const b = await t.request("POST", "/v1/auth/google/native", {
      body: { idToken: "google|sub-2|same@example.com|B|" },
    });
    const meA = await t.request("GET", "/v1/me", { token: a.json.accessToken });
    const meB = await t.request("GET", "/v1/me", { token: b.json.accessToken });
    expect(meA.json.id).not.toBe(meB.json.id);
  });

  it("nonce 不符時拒絕", async () => {
    const res = await t.request("POST", "/v1/auth/google/native", {
      body: { idToken: "google|sub-n|n@example.com|N|abc", nonce: "xyz" },
    });
    expect(res.status).toBe(401);
  });

  it("沒有或無效的 access token 會回 401 Problem Details", async () => {
    const none = await t.request("GET", "/v1/me");
    expect(none.status).toBe(401);
    expect(none.headers.get("content-type")).toContain("application/problem+json");
    const bad = await t.request("GET", "/v1/me", { token: "not-a-jwt" });
    expect(bad.status).toBe(401);
  });

  it("access token 15 分鐘後過期", async () => {
    const { token } = await t.login("expiry-sub");
    t.advance(16 * 60_000);
    const res = await t.request("GET", "/v1/me", { token });
    expect(res.status).toBe(401);
  });
});

describe("Refresh token 輪替（App）", () => {
  it("每次 refresh 都換新 token；舊 token 被重複使用時撤銷整串", async () => {
    const { refreshToken: r1 } = await t.login("refresh-sub");
    const first = await t.request("POST", "/v1/auth/refresh", { body: { refreshToken: r1 } });
    expect(first.status).toBe(200);
    const r2 = first.json.refreshToken as string;
    expect(r2).not.toBe(r1);
    expect((await t.request("GET", "/v1/me", { token: first.json.accessToken })).status).toBe(200);

    // 舊的 r1 再被使用 → 視為外洩
    const replay = await t.request("POST", "/v1/auth/refresh", { body: { refreshToken: r1 } });
    expect(replay.status).toBe(401);
    // 連帶 r2 也失效
    const after = await t.request("POST", "/v1/auth/refresh", { body: { refreshToken: r2 } });
    expect(after.status).toBe(401);
  });

  it("登出後 refresh token 失效", async () => {
    const { refreshToken } = await t.login("logout-sub");
    expect((await t.request("POST", "/v1/auth/logout", { body: { refreshToken } })).status).toBe(
      204,
    );
    expect((await t.request("POST", "/v1/auth/refresh", { body: { refreshToken } })).status).toBe(
      401,
    );
  });
});

describe("Google 登入（網頁）", () => {
  async function startFlow() {
    const res = await t.app.request("/v1/auth/google?returnTo=/trips");
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    const cookie = res.headers.get("set-cookie")?.split(";")[0] ?? "";
    return {
      state: location.searchParams.get("state") ?? "",
      nonce: location.searchParams.get("nonce") ?? "",
      cookie,
    };
  }

  it("完成授權後設定 HttpOnly refresh cookie 並導回前端", async () => {
    const { state, nonce, cookie } = await startFlow();
    const code = encodeURIComponent(`google|web-sub|web@example.com|Web|${nonce}`);
    const res = await t.app.request(`/v1/auth/google/callback?code=${code}&state=${state}`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${APP_ORIGIN}/trips`);
    const setCookie = res.headers.getSetCookie().join("\n");
    expect(setCookie).toMatch(/tl_rt=[^;]+;.*HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Lax/);

    // 用 cookie 換 access token：必須帶允許的 Origin
    const rt = setCookie.match(/tl_rt=([^;]+)/)?.[1];
    const noOrigin = await t.request("POST", "/v1/auth/refresh", {
      body: {},
      headers: { Cookie: `tl_rt=${rt}` },
    });
    expect(noOrigin.status).toBe(403);
    const ok = await t.request("POST", "/v1/auth/refresh", {
      body: {},
      headers: { Cookie: `tl_rt=${rt}`, Origin: APP_ORIGIN },
    });
    expect(ok.status).toBe(200);
    expect(ok.json.accessToken).toBeTypeOf("string");
    expect(ok.json.refreshToken).toBeUndefined(); // Web 不會在 body 拿到 refresh token
  });

  it("state 不符時導回登入頁並帶錯誤", async () => {
    const { cookie } = await startFlow();
    const res = await t.app.request("/v1/auth/google/callback?code=x&state=wrong", {
      headers: { Cookie: cookie },
    });
    expect(res.headers.get("location")).toBe(`${APP_ORIGIN}/login?error=state`);
  });

  it("returnTo 只接受站內路徑", async () => {
    const res = await t.app.request("/v1/auth/google?returnTo=//evil.example.com");
    const location = new URL(res.headers.get("location") ?? "");
    const { cookie } = { cookie: res.headers.get("set-cookie")?.split(";")[0] ?? "" };
    const code = encodeURIComponent(
      `google|rt-sub|rt@example.com|R|${location.searchParams.get("nonce")}`,
    );
    const cb = await t.app.request(
      `/v1/auth/google/callback?code=${code}&state=${location.searchParams.get("state")}`,
      { headers: { Cookie: cookie } },
    );
    expect(cb.headers.get("location")).toBe(`${APP_ORIGIN}/`);
  });
});

describe("Passkey", () => {
  it("未登入不能新增 Passkey（不能用 Passkey 註冊）", async () => {
    const res = await t.request("POST", "/v1/auth/passkey/register/options");
    expect(res.status).toBe(401);
  });

  it("登入後新增 Passkey，之後可以只用 Passkey 登入同一個帳號", async () => {
    const user = await t.login("passkey-sub", "Passkey User");
    const authenticator = new SoftAuthenticator(APP_ORIGIN, "localhost");

    const opts = await t.request("POST", "/v1/auth/passkey/register/options", {
      token: user.token,
    });
    expect(opts.status).toBe(200);
    expect(opts.json.options.authenticatorSelection.residentKey).toBe("required");
    const reg = await t.request("POST", "/v1/auth/passkey/register/verify", {
      token: user.token,
      body: {
        challengeId: opts.json.challengeId,
        name: "MacBook",
        response: authenticator.createCredential(opts.json.options),
      },
    });
    expect(reg.status).toBe(201);
    expect(reg.json.name).toBe("MacBook");

    // Passkey 登入（App）
    const login = await t.request("POST", "/v1/auth/passkey/login/options");
    const verify = await t.request("POST", "/v1/auth/passkey/login/verify", {
      body: {
        challengeId: login.json.challengeId,
        client: "app",
        response: authenticator.getAssertion(login.json.options),
      },
    });
    expect(verify.status).toBe(200);
    const me = await t.request("GET", "/v1/me", { token: verify.json.accessToken });
    expect(me.json.id).toBe(user.userId);

    // 已註冊的 Passkey 會在下一次註冊時被排除，避免重複
    const again = await t.request("POST", "/v1/auth/passkey/register/options", {
      token: user.token,
    });
    expect(again.json.options.excludeCredentials).toHaveLength(1);

    // challenge 只能用一次
    const replay = await t.request("POST", "/v1/auth/passkey/login/verify", {
      body: {
        challengeId: login.json.challengeId,
        client: "app",
        response: authenticator.getAssertion(login.json.options),
      },
    });
    expect(replay.status).toBe(400);
  });

  it("Web 的 Passkey 登入必須來自允許的 Origin，並以 cookie 發 refresh token", async () => {
    const user = await t.login("passkey-web-sub");
    const authenticator = new SoftAuthenticator(APP_ORIGIN, "localhost");
    const opts = await t.request("POST", "/v1/auth/passkey/register/options", {
      token: user.token,
    });
    await t.request("POST", "/v1/auth/passkey/register/verify", {
      token: user.token,
      body: {
        challengeId: opts.json.challengeId,
        response: authenticator.createCredential(opts.json.options),
      },
    });

    const login = await t.request("POST", "/v1/auth/passkey/login/options");
    const body = {
      challengeId: login.json.challengeId,
      client: "web",
      response: authenticator.getAssertion(login.json.options),
    };
    expect((await t.request("POST", "/v1/auth/passkey/login/verify", { body })).status).toBe(403);

    const login2 = await t.request("POST", "/v1/auth/passkey/login/options");
    const ok = await t.request("POST", "/v1/auth/passkey/login/verify", {
      headers: { Origin: APP_ORIGIN },
      body: {
        challengeId: login2.json.challengeId,
        client: "web",
        response: authenticator.getAssertion(login2.json.options),
      },
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.getSetCookie().join()).toMatch(/tl_rt=/);
  });

  it("簽在錯誤 challenge 上的回應會被拒絕", async () => {
    const user = await t.login("passkey-bad-sub");
    const authenticator = new SoftAuthenticator(APP_ORIGIN, "localhost");
    const opts = await t.request("POST", "/v1/auth/passkey/register/options", {
      token: user.token,
    });
    await t.request("POST", "/v1/auth/passkey/register/verify", {
      token: user.token,
      body: {
        challengeId: opts.json.challengeId,
        response: authenticator.createCredential(opts.json.options),
      },
    });
    const login = await t.request("POST", "/v1/auth/passkey/login/options");
    const res = await t.request("POST", "/v1/auth/passkey/login/verify", {
      body: {
        challengeId: login.json.challengeId,
        client: "app",
        response: authenticator.getAssertion(login.json.options, { challenge: "d3Jvbmc" }),
      },
    });
    expect(res.status).toBe(400);
  });

  it("沒註冊過的 Passkey 不能登入", async () => {
    const stranger = new SoftAuthenticator(APP_ORIGIN, "localhost");
    stranger.createCredential({ user: { id: "eA" }, challenge: "eA" });
    const login = await t.request("POST", "/v1/auth/passkey/login/options");
    const res = await t.request("POST", "/v1/auth/passkey/login/verify", {
      body: {
        challengeId: login.json.challengeId,
        client: "app",
        response: stranger.getAssertion(login.json.options),
      },
    });
    expect(res.status).toBe(401);
  });

  it("可以列出、重新命名、刪除自己的 Passkey，但碰不到別人的", async () => {
    const user = await t.login("passkey-manage-sub");
    const other = await t.login("passkey-other-sub");
    const authenticator = new SoftAuthenticator(APP_ORIGIN, "localhost");
    const opts = await t.request("POST", "/v1/auth/passkey/register/options", {
      token: user.token,
    });
    const reg = await t.request("POST", "/v1/auth/passkey/register/verify", {
      token: user.token,
      body: {
        challengeId: opts.json.challengeId,
        response: authenticator.createCredential(opts.json.options),
      },
    });
    const id = reg.json.id;

    const list = await t.request("GET", "/v1/me/passkeys", { token: user.token });
    expect(list.json.passkeys).toHaveLength(1);
    expect(
      (
        await t.request("PATCH", `/v1/me/passkeys/${id}`, {
          token: user.token,
          body: { name: "iPhone" },
        })
      ).json.name,
    ).toBe("iPhone");
    expect(
      (await t.request("DELETE", `/v1/me/passkeys/${id}`, { token: other.token })).status,
    ).toBe(404);
    expect((await t.request("DELETE", `/v1/me/passkeys/${id}`, { token: user.token })).status).toBe(
      204,
    );
    expect(
      (await t.request("GET", "/v1/me/passkeys", { token: user.token })).json.passkeys,
    ).toHaveLength(0);
  });
});

describe("其他", () => {
  it("提供 JWKS 讓其他服務驗證 access token", async () => {
    const res = await t.request("GET", "/.well-known/jwks.json");
    expect(res.json.keys[0]).toMatchObject({ kty: "EC", crv: "P-256", alg: "ES256", use: "sig" });
    expect(res.json.keys[0].d).toBeUndefined();
  });

  it("不存在的路徑回 404 Problem Details", async () => {
    const res = await t.request("GET", "/nope");
    expect(res.status).toBe(404);
    expect(res.json.type).toBe("/problems/not-found");
  });
});
