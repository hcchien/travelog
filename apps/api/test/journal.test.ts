import { schema } from "@travelog/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { invitationEmail, resendMailer } from "../src/lib/mailer.js";
import { drainStorageDeletions } from "../src/lib/maintenance.js";
import { createTestApp, type TestApp } from "./helpers.js";

let t: TestApp;
type User = Awaited<ReturnType<TestApp["login"]>>;
let owner: User;
let editor: User;
let viewer: User;
let stranger: User;

beforeAll(async () => {
  t = await createTestApp();
  owner = await t.login("j-owner", "陳");
  editor = await t.login("j-editor", "小安");
  viewer = await t.login("j-viewer", "阿明");
  stranger = await t.login("j-stranger", "路人");
});
afterAll(() => t.close());

async function createTrip() {
  const trip = (
    await t.request("POST", "/v1/trips", {
      token: owner.token,
      body: {
        title: "京都",
        startDate: "2026-12-03",
        endDate: "2026-12-05",
        primaryTz: "Asia/Tokyo",
      },
    })
  ).json;
  for (const [user, role] of [
    [editor, "editor"],
    [viewer, "viewer"],
  ] as const) {
    const inv = await t.request("POST", `/v1/trips/${trip.id}/invitations`, {
      token: owner.token,
      body: { role },
    });
    const token = new URL(inv.json.url).pathname.split("/").pop();
    const res = await t.request("POST", `/v1/invitations/${token}/accept`, { token: user.token });
    expect(res.status).toBe(200);
  }
  return trip as { id: string; days: { id: string; date: string }[] };
}

const doc = (...lines: string[]) => ({
  type: "doc",
  content: lines.map((text) => ({ type: "paragraph", content: [{ type: "text", text }] })),
});

/** 走完整個上傳流程，回傳附件。 */
async function upload(
  tripId: string,
  user: User,
  content: Buffer,
  meta: Partial<{ filename: string; mime: string; sizeBytes: number; itemId: string }> = {},
) {
  const start = await t.request("POST", `/v1/trips/${tripId}/attachments/uploads`, {
    token: user.token,
    body: { filename: "機票.pdf", mime: "application/pdf", sizeBytes: content.length, ...meta },
  });
  return start;
}

async function put(url: string, headers: Record<string, string>, body: Buffer) {
  return t.app.request(new URL(url).pathname, { method: "PUT", headers, body });
}

describe("附件", () => {
  it("簽發上傳網址 → 直接上傳 → 完成 → 列出 → 下載", async () => {
    const trip = await createTrip();
    const pdf = Buffer.from("%PDF-1.4 test");
    const start = await upload(trip.id, editor, pdf);
    expect(start.status).toBe(201);
    expect(start.json.attachment.status).toBe("pending");
    // 還沒上傳就完成：拒絕
    const early = await t.request(
      "POST",
      `/v1/trips/${trip.id}/attachments/${start.json.attachment.id}/complete`,
      {
        token: editor.token,
      },
    );
    expect(early.status).toBe(409);
    // 上傳時 Content-Type 或大小不符都會被拒
    expect((await put(start.json.upload.url, { "Content-Type": "image/png" }, pdf)).status).toBe(
      400,
    );
    expect(
      (await put(start.json.upload.url, start.json.upload.headers, Buffer.from("x"))).status,
    ).toBe(400);
    expect((await put(start.json.upload.url, start.json.upload.headers, pdf)).status).toBe(200);

    const done = await t.request(
      "POST",
      `/v1/trips/${trip.id}/attachments/${start.json.attachment.id}/complete`,
      {
        token: editor.token,
      },
    );
    expect(done.json.status).toBe("ready");

    // 檢視者看得到也能下載，但不能上傳
    const list = await t.request("GET", `/v1/trips/${trip.id}/attachments`, {
      token: viewer.token,
    });
    expect(list.json.attachments.map((a: { filename: string }) => a.filename)).toEqual([
      "機票.pdf",
    ]);
    expect((await upload(trip.id, viewer, pdf)).status).toBe(403);
    const dl = await t.request("GET", `/v1/trips/${trip.id}/attachments/${done.json.id}/download`, {
      token: viewer.token,
    });
    const file = await t.app.request(new URL(dl.json.url).pathname);
    expect(file.status).toBe(200);
    expect(Buffer.from(await file.arrayBuffer()).toString()).toBe("%PDF-1.4 test");
    expect(file.headers.get("content-disposition")).toContain("inline");
    expect(file.headers.get("content-disposition")).toContain(encodeURIComponent("機票.pdf"));
    expect(file.headers.get("x-content-type-options")).toBe("nosniff");

    // 下載網址會過期；上傳網址不能拿來下載
    t.advance(6 * 60 * 1000);
    expect((await t.app.request(new URL(dl.json.url).pathname)).status).toBe(403);
    expect((await t.app.request(new URL(start.json.upload.url).pathname)).status).toBe(404);
    // 竄改簽章
    expect((await t.app.request(`${new URL(dl.json.url).pathname}x`)).status).toBe(404);

    // 不是成員看不到
    expect(
      (await t.request("GET", `/v1/trips/${trip.id}/attachments`, { token: stranger.token }))
        .status,
    ).toBe(404);

    const [row] = await t.db
      .select()
      .from(schema.attachments)
      .where(eq(schema.attachments.id, done.json.id));
    expect(await t.storage.stat(row?.storageKey as string)).toMatchObject({
      size: pdf.length,
      generation: expect.any(String),
    });
    // 只有上傳者或擁有者可以刪除
    expect(
      (
        await t.request("DELETE", `/v1/trips/${trip.id}/attachments/${done.json.id}`, {
          token: viewer.token,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await t.request("DELETE", `/v1/trips/${trip.id}/attachments/${done.json.id}`, {
          token: owner.token,
        })
      ).status,
    ).toBe(204);
    // Deletion waits for the signed PUT URL to expire, so it cannot recreate an orphan.
    await drainStorageDeletions({
      db: t.db,
      storage: t.storage,
      now: () => new Date(Date.now() + 16 * 60_000),
    });
    expect(await t.storage.stat(row?.storageKey as string)).toBeNull();
  });

  it("只收 PDF 與圖片，最大 10 MB，檔名不能含路徑", async () => {
    const trip = await createTrip();
    const bad = async (body: Record<string, unknown>) =>
      (
        await t.request("POST", `/v1/trips/${trip.id}/attachments/uploads`, {
          token: owner.token,
          body: { filename: "a.pdf", mime: "application/pdf", sizeBytes: 10, ...body },
        })
      ).status;
    expect(await bad({ mime: "text/html" })).toBe(422);
    expect(await bad({ mime: "image/svg+xml" })).toBe(422);
    expect(await bad({ sizeBytes: 10 * 1024 * 1024 + 1 })).toBe(422);
    expect(await bad({ filename: "../../etc/passwd" })).toBe(422);
    expect(await bad({ itemId: "00000000-0000-4000-8000-000000000000" })).toBe(404);
  });

  it("MCP 不能存取附件", async () => {
    const trip = await createTrip();
    const token = await t.tokens.issueInternalToken(
      owner.userId,
      ["trips:read", "trips:write"],
      "tlc_x",
    );
    expect((await t.request("GET", `/v1/trips/${trip.id}/attachments`, { token })).status).toBe(
      403,
    );
  });
});

describe("心得", () => {
  it("每人每個範圍一篇；只有作者能改，版本不符回 412；擁有者可以刪", async () => {
    const trip = await createTrip();
    const base = `/v1/trips/${trip.id}/journal`;
    const day1 = trip.days[0]?.id;
    const created = await t.request("POST", base, {
      token: editor.token,
      body: {
        target: { scope: "day", dayId: day1 },
        title: "第一天",
        body: doc("早上去伏見稻荷", "千本鳥居"),
      },
    });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({
      dayId: day1,
      bodyText: "早上去伏見稻荷\n千本鳥居",
      version: 1,
      visibility: "members",
    });

    const dup = await t.request("POST", base, {
      token: editor.token,
      body: { target: { scope: "day", dayId: day1 }, bodyText: "再一篇" },
    });
    expect(dup.status).toBe(409);
    expect(dup.json.entryId).toBe(created.json.id);

    // 檢視者也可以寫自己的心得（預設）
    const mine = await t.request("POST", base, {
      token: viewer.token,
      body: { target: { scope: "trip" }, bodyText: "整趟很開心" },
    });
    expect(mine.status).toBe(201);

    const entry = `${base}/${created.json.id}`;
    expect(
      (await t.request("PATCH", entry, { token: owner.token, body: { version: 1, title: "x" } }))
        .status,
    ).toBe(403);
    const updated = await t.request("PATCH", entry, {
      token: editor.token,
      body: { version: 1, bodyText: "改過了", visibility: "public" },
    });
    expect(updated.json).toMatchObject({ version: 2, bodyText: "改過了", visibility: "public" });
    expect(
      (
        await t.request("PATCH", entry, {
          token: editor.token,
          body: { version: 1, title: "舊版" },
        })
      ).status,
    ).toBe(412);

    const list = await t.request("GET", base, { token: viewer.token });
    expect(list.json.entries).toHaveLength(2);

    expect((await t.request("DELETE", entry, { token: viewer.token })).status).toBe(403);
    expect((await t.request("DELETE", entry, { token: owner.token })).status).toBe(204);
  });

  it("內容只允許文字節點：拒絕圖片與 javascript: 連結，剝除多餘屬性", async () => {
    const trip = await createTrip();
    const base = `/v1/trips/${trip.id}/journal`;
    const post = (body: unknown) =>
      t.request("POST", base, { token: owner.token, body: { target: { scope: "trip" }, body } });
    expect(
      (await post({ type: "doc", content: [{ type: "image", attrs: { src: "https://x/y.png" } }] }))
        .status,
    ).toBe(422);
    expect(
      (
        await post({
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: "x",
                  marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }],
                },
              ],
            },
          ],
        })
      ).status,
    ).toBe(422);
    const ok = await post({
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { class: "evil" },
          content: [
            {
              type: "text",
              text: "官網",
              marks: [
                {
                  type: "link",
                  attrs: { href: "https://example.com", target: "_blank", onclick: "x" },
                },
              ],
            },
          ],
        },
      ],
    });
    expect(ok.status).toBe(201);
    expect(ok.json.body.content[0]).toEqual({
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "官網",
          marks: [{ type: "link", attrs: { href: "https://example.com" } }],
        },
      ],
    });
  });

  it("擁有者可以關閉檢視者寫心得", async () => {
    const trip = await createTrip();
    const patch = (token: string) =>
      t.request("PATCH", `/v1/trips/${trip.id}`, {
        token,
        body: { viewerCanWriteJournal: false },
        headers: { "If-Match": '"v1"' },
      });
    expect((await patch(editor.token)).status).toBe(403);
    const ok = await patch(owner.token);
    expect(ok.status).toBe(200);
    expect(ok.json.viewerCanWriteJournal).toBe(false);
    const res = await t.request("POST", `/v1/trips/${trip.id}/journal`, {
      token: viewer.token,
      body: { target: { scope: "trip" }, bodyText: "x" },
    });
    expect(res.status).toBe(403);
  });

  it("筆記轉心得：依時間接到當天心得最後，已併入的不會重複", async () => {
    const trip = await createTrip();
    const base = `/v1/trips/${trip.id}`;
    const day1 = trip.days[0]?.id as string;
    // 東京 12/3 15:10 與 09:30（故意倒著建立）
    for (const [body, takenAt] of [
      ["抹茶冰淇淋超好吃", "2026-12-03T06:10:00Z"],
      ["清水寺人好多", "2026-12-03T00:30:00Z"],
    ]) {
      await t.request("POST", `${base}/notes`, { token: owner.token, body: { body, takenAt } });
    }
    // 別人的筆記不會被併入
    await t.request("POST", `${base}/notes`, {
      token: editor.token,
      body: { body: "小安的", takenAt: "2026-12-03T01:00:00Z" },
    });

    const first = await t.request("POST", `${base}/journal/merge-notes`, {
      token: owner.token,
      body: { dayId: day1 },
    });
    expect(first.status).toBe(201);
    expect(first.json.merged).toBe(2);
    expect(first.json.entry.bodyText).toBe("09:30　清水寺人好多\n15:10　抹茶冰淇淋超好吃");

    const again = await t.request("POST", `${base}/journal/merge-notes`, {
      token: owner.token,
      body: { dayId: day1 },
    });
    expect(again.status).toBe(409);

    await t.request("POST", `${base}/notes`, {
      token: owner.token,
      body: { body: "晚上散步", takenAt: "2026-12-03T11:00:00Z" },
    });
    const second = await t.request("POST", `${base}/journal/merge-notes`, {
      token: owner.token,
      body: { dayId: day1 },
    });
    expect(second.status).toBe(200);
    expect(second.json.entry.version).toBe(2);
    expect(second.json.entry.bodyText).toBe(
      "09:30　清水寺人好多\n15:10　抹茶冰淇淋超好吃\n20:00　晚上散步",
    );

    const notes = await t.request("GET", `${base}/notes?dayId=${day1}`, { token: owner.token });
    const ownerNotes = notes.json.notes.filter(
      (n: { author: { userId: string } }) => n.author.userId === owner.userId,
    );
    expect(
      ownerNotes.every(
        (n: { mergedIntoEntryId: string }) => n.mergedIntoEntryId === first.json.entry.id,
      ),
    ).toBe(true);
  });

  it("MCP 需要 journal:write 才能寫心得，可以用純文字", async () => {
    const trip = await createTrip();
    const readOnly = await t.tokens.issueInternalToken(owner.userId, ["trips:read"], "tlc_x");
    const writer = await t.tokens.issueInternalToken(
      owner.userId,
      ["trips:read", "journal:write"],
      "tlc_x",
    );
    const body = { target: { scope: "trip" }, bodyText: "AI 幫我整理的心得" };
    expect(
      (await t.request("POST", `/v1/trips/${trip.id}/journal`, { token: readOnly, body })).status,
    ).toBe(403);
    const ok = await t.request("POST", `/v1/trips/${trip.id}/journal`, { token: writer, body });
    expect(ok.status).toBe(201);
    expect(
      (await t.request("GET", `/v1/trips/${trip.id}/journal`, { token: readOnly })).status,
    ).toBe(200);
  });
});

describe("公開遊記", () => {
  it("只有擁有者（第一方）能建立分享；公開頁只有公開心得，不含訂位、筆記、住宿", async () => {
    const trip = await createTrip();
    const base = `/v1/trips/${trip.id}`;
    const [d1, d2] = trip.days;
    await t.request("POST", `${base}/items`, {
      token: owner.token,
      body: {
        dayId: d1?.id,
        type: "sight",
        title: "伏見稻荷大社",
        startAt: "2026-12-03T09:00:00+09:00",
      },
    });
    await t.request("POST", `${base}/items`, {
      token: owner.token,
      body: {
        dayId: d1?.id,
        type: "food",
        title: "先斗町晚餐",
        booking: { kind: "restaurant", confirmationCode: "PT-0312" },
      },
    });
    await t.request("POST", `${base}/items`, {
      token: owner.token,
      body: { dayId: d1?.id, type: "stay", title: "京都某飯店" },
    });
    await t.request("POST", `${base}/notes`, {
      token: owner.token,
      body: { body: "私人筆記", takenAt: "2026-12-03T01:00:00Z" },
    });
    await t.request("POST", `${base}/journal`, {
      token: editor.token,
      body: {
        target: { scope: "day", dayId: d1?.id },
        bodyText: "公開的第一天",
        visibility: "public",
      },
    });
    await t.request("POST", `${base}/journal`, {
      token: owner.token,
      body: { target: { scope: "day", dayId: d2?.id }, bodyText: "只給成員看" },
    });

    expect(
      (await t.request("POST", `${base}/share-links`, { token: editor.token, body: {} })).status,
    ).toBe(403);
    const mcp = await t.tokens.issueInternalToken(
      owner.userId,
      ["trips:read", "trips:write"],
      "tlc_x",
    );
    expect((await t.request("POST", `${base}/share-links`, { token: mcp, body: {} })).status).toBe(
      403,
    );

    const link = await t.request("POST", `${base}/share-links`, { token: owner.token, body: {} });
    expect(link.status).toBe(201);
    expect(link.json.url).toMatch(/\/s\/[2-9a-z]{12}$/);
    expect(link.json.options).toEqual({ hideLodging: true, journalOnly: false });

    const pub = await t.request("GET", `/v1/public/${link.json.slug}`);
    expect(pub.status).toBe(200);
    const day1 = pub.json.days[0];
    expect(day1.items.map((i: { title: string }) => i.title)).toEqual([
      "伏見稻荷大社",
      "先斗町晚餐",
    ]);
    expect(day1.items[0].time).toBe("09:00");
    expect(day1.entries.map((e: { author: string }) => e.author)).toEqual(["小安"]);
    expect(pub.json.days[1].entries).toEqual([]);
    const raw = JSON.stringify(pub.json);
    for (const secret of [
      "PT-0312",
      "私人筆記",
      "只給成員看",
      "京都某飯店",
      "@example.com",
      owner.userId,
    ]) {
      expect(raw).not.toContain(secret);
    }

    const links = await t.request("GET", `${base}/share-links`, { token: owner.token });
    expect(links.json.links).toHaveLength(1);
    expect(
      (await t.request("DELETE", `${base}/share-links/${link.json.id}`, { token: owner.token }))
        .status,
    ).toBe(204);
    expect((await t.request("GET", `/v1/public/${link.json.slug}`)).status).toBe(404);
    expect((await t.request("GET", "/v1/public/not-a-slug!")).status).toBe(404);
  });

  it("只顯示心得模式不回傳行程點", async () => {
    const trip = await createTrip();
    await t.request("POST", `/v1/trips/${trip.id}/items`, {
      token: owner.token,
      body: { dayId: trip.days[0]?.id, type: "sight", title: "金閣寺" },
    });
    const link = await t.request("POST", `/v1/trips/${trip.id}/share-links`, {
      token: owner.token,
      body: { journalOnly: true, hideLodging: false },
    });
    const pub = await t.request("GET", `/v1/public/${link.json.slug}`);
    expect(pub.json.days.every((d: { items: unknown[] }) => d.items.length === 0)).toBe(true);
  });
});

describe("邀請信", () => {
  it("內容會跳脫 HTML", () => {
    const m = invitationEmail({
      url: "https://x/invite/abc",
      tripTitle: "<script>京都</script>",
      inviterName: "陳",
    });
    expect(m.subject).toBe("陳 邀請你一起規劃「<script>京都</script>」");
    expect(m.html).toContain("&lt;script&gt;京都&lt;/script&gt;");
    expect(m.html).not.toContain("<script>");
  });

  it("透過 Resend API 寄送；失敗時丟出錯誤", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const ok = resendMailer({
      apiKey: "re_test",
      from: "Travelog <a@b.c>",
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
    await ok.sendInvitation({
      to: "x@y.z",
      url: "https://x",
      tripTitle: "京都",
      inviterName: "陳",
    });
    expect(calls[0]?.url).toBe("https://api.resend.com/emails");
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      to: ["x@y.z"],
      from: "Travelog <a@b.c>",
    });
    const bad = resendMailer({
      apiKey: "re_test",
      from: "a@b.c",
      fetch: (async () => new Response("nope", { status: 422 })) as unknown as typeof fetch,
    });
    await expect(
      bad.sendInvitation({ to: "x@y.z", url: "u", tripTitle: "t", inviterName: "" }),
    ).rejects.toThrow("422");
  });
});
