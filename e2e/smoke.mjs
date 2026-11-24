/**
 * 端到端冒煙測試：以兩個使用者走過主要流程並截圖。
 * 先啟動沙盒 API 與 Web：
 *   pnpm --filter @travelog/api sandbox
 *   pnpm --filter @travelog/web build && pnpm --filter @travelog/web start
 * 再執行：
 *   pnpm e2e            （第一次需 npx playwright install chromium）
 * 截圖存在 e2e/screenshots/。每次執行前請重啟沙盒以清空資料。
 */
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const WEB = process.env.WEB_ORIGIN ?? "http://localhost:3000";
const SHOTS = new URL("./screenshots/", import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });
const out = (n) => `${SHOTS}${n}.png`;
const errors = [];
const log = (...a) => console.log("•", ...a);

const browser = await chromium.launch(
  process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {},
);
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
};
async function newUser() {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: "zh-TW",
  });
  const page = await ctx.newPage();
  page.on(
    "console",
    (m) => m.type() === "error" && errors.push(`console: ${m.text()} @ ${m.location()?.url ?? ""}`),
  );
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("response", (r) => {
    if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.request().method()} ${r.url()}`);
  });
  return { ctx, page };
}

async function sandboxLogin(page, name) {
  await page.getByRole("link", { name: "使用 Google 帳號繼續" }).click();
  await page.getByLabel("名字").fill(name);
  await page.getByRole("button", { name: "登入" }).click();
}

async function pickPlace(page, placeholder, query, option) {
  const box = page.getByRole("searchbox", { name: placeholder });
  await box.fill(query);
  await page
    .getByRole("button", { name: new RegExp(option) })
    .first()
    .click();
}

// ---- 使用者 1：陳
const { page } = await newUser();
await page.goto(`${WEB}/login`);
await page.screenshot({ path: out("01-login") });
await sandboxLogin(page, "陳");
await page.waitForURL("**/trips");
log("登入後進入", new URL(page.url()).pathname);

await page.getByRole("button", { name: "建立行程" }).click();
const dlg = page.getByRole("dialog", { name: "建立行程" });
await dlg.getByLabel("行程名稱").fill("京都秋楓之旅");
await dlg.getByLabel("出發日").fill("2026-12-03");
await dlg.getByLabel("回程日").fill("2026-12-06");
await pickPlace(page, "搜尋城市，例如：京都", "京都", "京都市");
await page.waitForTimeout(800);
await page.screenshot({ path: out("01b-create") });
await dlg.getByRole("button", { name: "移除 京都" }).waitFor();
log("時區自動設為", await dlg.getByLabel("主要時區").inputValue());
await dlg.getByRole("button", { name: "建立" }).click();
await page.waitForURL(/\/trips\/[0-9a-f-]{36}$/);
const tripUrl = page.url();
log("建立行程", tripUrl);

// 想去清單
await pickPlace(page, "搜尋地點加入清單", "清水", "清水寺");
await page.getByText("已把「清水寺」加入想去清單").waitFor();
await pickPlace(page, "搜尋地點加入清單", "伏見", "伏見稻荷大社");
await page.getByRole("button", { name: "投票支持" }).first().click();
await page.waitForTimeout(500);
for (const name of ["清水寺", "伏見稻荷大社"]) {
  const row = page
    .locator("li", { hasText: name })
    .filter({ has: page.getByRole("button", { name: "排入" }) });
  await row.getByRole("button", { name: "排入" }).click();
  await page.getByText("已排入Day 1").first().waitFor();
  await page.waitForTimeout(300);
}

// 已訂位的晚餐
await page.getByRole("button", { name: "新增行程點" }).click();
const item = page.getByRole("dialog", { name: "新增行程點" });
await pickPlace(page, "搜尋地點（選填）", "先斗", "先斗町");
await item.getByLabel("開始時間").fill("18:30");
await item.getByRole("button", { name: /加上訂位資訊/ }).click();
await item.getByLabel("種類").selectOption("restaurant");
await item.getByLabel("狀態").selectOption("booked");
await item.getByLabel("訂位代號").fill("PT-0312");
await item.getByRole("button", { name: "新增" }).click();
await page.getByText("已訂位", { exact: true }).waitFor();
log("已訂位的行程點顯示釘選標籤");
const dinnerType = await page
  .locator("li", { hasText: "先斗町" })
  .locator("span.rounded-md")
  .first()
  .textContent();
log("晚餐的類型", dinnerType);
if (dinnerType !== "餐廳") fail("晚餐應自動判斷為餐廳");

const titles = async () =>
  (await page.locator("ol > li strong.text-base").allTextContents()).map((s) => s.trim());
log("Day 1 順序", await titles());

// 拖拉：把第 2 個拉到第 1 個
const handles = page.getByRole("button", { name: /拖拉調整/ });
log("可拖拉的行程點數", await handles.count(), "（已訂位的晚餐不能拖）");
const a = await handles.nth(1).boundingBox();
const b = await handles.nth(0).boundingBox();
await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
await page.mouse.down();
await page.mouse.move(a.x + 5, a.y - 10, { steps: 4 });
await page.mouse.move(b.x + b.width / 2, b.y - 20, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(1200);
const after = await titles();
log("拖拉後順序", after);
if (after[0] !== "伏見稻荷大社" || after[2] !== "先斗町 川床料理") fail("拖拉排序結果不符");
await page.screenshot({ path: out("02-planner") });

// 打開已確定的行程點：時間欄位應該鎖住
await page
  .getByRole("button", { name: /先斗町/ })
  .first()
  .click();
const edit = page.getByRole("dialog", { name: "行程點" });
const lockedField = await edit.getByLabel("開始時間").isDisabled();
log("已確定行程點的開始時間欄位停用", lockedField);
if (!lockedField) fail("已確定行程點的時間欄位應停用");
await page.screenshot({ path: out("03-confirmed-item") });
await edit.getByRole("button", { name: "關閉" }).click();

// 成員：產生邀請連結
await page.getByRole("link", { name: "成員" }).click();
await page.getByRole("button", { name: "產生邀請連結" }).click();
const link = (await page.locator(".font-mono").textContent())?.trim();
log("邀請連結", link?.replace(/invite\/.+/, "invite/…"));
await page.screenshot({ path: out("04-members") });

// ---- 使用者 2：小安 透過邀請加入
const second = await newUser();
await second.page.goto(link);
await second.page
  .getByText("陳 邀請你")
  .waitFor()
  .catch(() => {});
await second.page.screenshot({ path: out("05-invite") });
await second.page.getByRole("link", { name: "使用 Google 帳號繼續" }).click();
await second.page.getByLabel("名字").fill("小安");
await second.page.getByRole("button", { name: "登入" }).click();
await second.page.getByRole("button", { name: /加入行程/ }).click();
await second.page.waitForURL(/\/trips\/[0-9a-f-]{36}$/);
await second.page.locator("ol > li").first().waitFor();
log(
  "小安加入後看到的 Day 1",
  (await second.page.locator("ol > li strong.text-base").allTextContents()).map((s) => s.trim()),
);

// 陳 看到活動紀錄
await page.reload();
await page.getByText("加入了行程").first().waitFor();
log("活動紀錄出現「小安 加入了行程」");

// ---- 我的地點庫
await page.goto(`${WEB}/places`);
await pickPlace(page, "搜尋地點加入收藏", "Fuglen", "Fuglen");
await page.getByText(/已收藏到「東京」/).waitFor();
await page.getByRole("button", { name: "編輯" }).first().click();
await page.getByLabel("標籤").fill("早餐、必去");
await page.getByLabel("私人備註").fill("週末要排隊");
await page.getByRole("button", { name: "儲存" }).click();
await page.getByText("週末要排隊").waitFor();
await page.screenshot({ path: out("06-places") });
log("地點庫：Fuglen 歸到東京，標籤與備註已儲存");

// 手機寬度
await page.setViewportSize({ width: 390, height: 844 });
await page.goto(tripUrl);
await page.getByRole("heading", { name: "京都秋楓之旅" }).waitFor();
await page.screenshot({ path: out("07-mobile"), fullPage: true });

// ---- M4：行程中
await page.setViewportSize({ width: 1440, height: 1000 });
const tripId = tripUrl.split("/").pop();
const API = process.env.API_ORIGIN ?? "http://localhost:8080";

// 即時更新：小安新增行程點，陳的頁面不重新整理也會看到
await page.goto(tripUrl);
await page.locator("ol > li").first().waitFor();
await page.waitForTimeout(800); // 等 SSE 連上
await second.page.getByRole("button", { name: "新增行程點" }).click();
const add2 = second.page.getByRole("dialog", { name: "新增行程點" });
await add2.getByLabel("名稱").fill("錦市場午餐");
await add2.getByRole("button", { name: "新增" }).click();
await page.getByText("錦市場午餐").first().waitFor({ timeout: 8000 });
log("即時更新：陳不重新整理就看到小安新增的「錦市場午餐」");

// 行程內搜尋
await page.getByRole("button", { name: "搜尋這趟行程" }).click();
await page.getByRole("searchbox", { name: "搜尋這趟行程" }).fill("PT-0312");
await page.getByRole("dialog", { name: "搜尋這趟行程" }).getByText("先斗町").first().waitFor();
log("搜尋訂位代號 PT-0312 找到先斗町");
await page.keyboard.press("Escape");

// 今日頁（手機）＋快速筆記
await page.setViewportSize({ width: 390, height: 844 });
await page.goto(`${WEB}/trips/${tripId}/today`);
await page.getByRole("heading", { name: /Day 1/ }).waitFor();
await page.getByRole("button", { name: "新增快速筆記" }).click();
await page.getByLabel("筆記內容").fill("清水寺的楓葉正紅");
await page.getByRole("button", { name: "記下" }).click();
await page.getByText("清水寺的楓葉正紅").waitFor();
await page.screenshot({ path: out("08-today"), fullPage: true });
log("今日頁：顯示 Day 1 並新增筆記");

// 離線：service worker 提供頁面，資料來自離線快照
await page.waitForTimeout(1500); // 讓 service worker 啟用並快取頁面
await page.reload();
await page.getByText("清水寺的楓葉正紅").waitFor();
await page.context().setOffline(true);
await page.reload();
await page.getByText(/離線中/).waitFor({ timeout: 10000 });
await page.getByText("清水寺的楓葉正紅").waitFor();
await page.screenshot({ path: out("09-today-offline"), fullPage: true });
log("離線：今日頁仍可開啟，顯示離線徽章與筆記");
await page.context().setOffline(false);
await page.setViewportSize({ width: 1440, height: 1000 });

// ---- M3：附件（訂位憑證）
await page.goto(tripUrl);
await page
  .getByRole("button", { name: /先斗町/ })
  .first()
  .click();
const itemDlg = page.getByRole("dialog", { name: "行程點" });
await itemDlg.getByLabel("選擇要上傳的檔案").setInputFiles({
  name: "先斗町訂位確認.pdf",
  mimeType: "application/pdf",
  buffer: Buffer.from("%PDF-1.4\n% travelog e2e\n"),
});
await page.getByText("已上傳「先斗町訂位確認.pdf」").waitFor();
await itemDlg.getByRole("button", { name: "先斗町訂位確認.pdf", exact: true }).waitFor();
await page.screenshot({ path: out("13-attachment") });
const [popup] = await Promise.all([
  page.waitForEvent("popup"),
  itemDlg.getByRole("button", { name: "先斗町訂位確認.pdf", exact: true }).click(),
]);
// 先開空白視窗再導向簽章網址（避免被擋彈出視窗）
await popup.waitForURL(/\/v1\/local-storage\//).catch(() => fail("附件沒有導向簽章網址"));
log("附件：上傳後可開啟短效簽章網址");
await popup.close();
await itemDlg.getByRole("button", { name: "關閉" }).click();

// ---- M3／M6：心得、筆記轉心得、公開遊記
await page.getByRole("link", { name: "心得" }).click();
await page.getByRole("heading", { name: "心得" }).waitFor();
const day1 = page.getByRole("region", { name: /^Day 1/ });
await day1.getByRole("button", { name: "把 1 則筆記加進心得" }).click();
await page.getByText("已把 1 則筆記加進心得").waitFor();
await day1.getByText("清水寺的楓葉正紅").waitFor();
log("筆記轉心得：今日頁的筆記併入 Day 1 心得");
await day1.getByRole("button", { name: "編輯" }).click();
const editor = day1.getByRole("textbox", { name: "心得內容" });
await editor.click();
await page.keyboard.press("End");
await page.keyboard.press("Control+End");
await page.keyboard.press("Enter");
await page.keyboard.type("傍晚的鴨川很美，");
await page.keyboard.press("Control+b");
await page.keyboard.type("一定要再來");
await day1.getByLabel(/放進公開遊記/).check();
await day1.getByRole("button", { name: "儲存" }).click();
await page.getByText("已儲存").waitFor();
await day1.getByText("公開", { exact: true }).waitFor();
await day1.locator("strong", { hasText: "一定要再來" }).waitFor();
await page.screenshot({ path: out("14-journal"), fullPage: true });
log("心得：編輯器粗體與公開設定已儲存");

await page.getByRole("button", { name: "建立分享連結" }).click();
await page.getByText("已建立分享連結").waitFor();
const shareUrl = (await page.locator("span.font-mono").first().textContent())?.trim();
const anon = await browser.newContext({ locale: "zh-TW", viewport: { width: 390, height: 844 } });
const pub = await anon.newPage();
await pub.goto(shareUrl);
await pub.getByRole("heading", { name: "京都秋楓之旅" }).waitFor();
await pub.getByText("一定要再來").waitFor();
const pubText = (await pub.locator("body").textContent()) ?? "";
await pub.screenshot({ path: out("15-public"), fullPage: true });
for (const secret of ["PT-0312", "先斗町訂位確認.pdf"]) {
  if (pubText.includes(secret)) fail(`公開遊記不應出現 ${secret}`);
}
log("公開遊記：未登入可看，訂位代號與附件不公開");
await anon.close();

// ---- M5：MCP 授權
const reg = await (
  await fetch(`${API}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "E2E 助理", redirect_uris: ["http://127.0.0.1:9/cb"] }),
  })
).json();
const { createHash, randomBytes } = await import("node:crypto");
const verifier = randomBytes(32).toString("base64url");
const qs = new URLSearchParams({
  response_type: "code",
  client_id: reg.client_id,
  redirect_uri: "http://127.0.0.1:9/cb",
  scope: "trips:read trips:write",
  state: "s1",
  code_challenge: createHash("sha256").update(verifier).digest("base64url"),
  code_challenge_method: "S256",
  resource: `${API}/mcp`,
});
let callback;
await page.route("http://127.0.0.1:9/**", (r) => {
  callback = new URL(r.request().url());
  return r.fulfill({ body: "ok" });
});
await page.goto(`${API}/oauth/authorize?${qs}`);
await page.getByRole("heading", { name: /E2E 助理 想要存取/ }).waitFor();
await page.screenshot({ path: out("10-consent") });
await page.getByRole("button", { name: "允許" }).click();
await page.waitForURL("http://127.0.0.1:9/**");
const tok = await (
  await fetch(`${API}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: callback.searchParams.get("code"),
      client_id: reg.client_id,
      redirect_uri: "http://127.0.0.1:9/cb",
      code_verifier: verifier,
    }),
  })
).json();
log("同意頁授權完成，取得 scope", tok.scope);

let rpcId = 0;
async function mcp(method, params) {
  const res = await fetch(`${API}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tok.access_token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  return res.json();
}
await mcp("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "e2e", version: "1" },
});
const added = await mcp("tools/call", {
  name: "add_itinerary_item",
  arguments: { tripId, day: 2, title: "MCP 加的嵐山散步", type: "sight" },
});
if (added.result?.isError || added.error) fail(`MCP 新增失敗：${JSON.stringify(added)}`);
log("MCP 新增行程點");

// 成員頁：活動紀錄標示 MCP，可以一鍵復原
await page.goto(`${tripUrl}/members`);
const mcpRow = page
  .locator("div", { hasText: "MCP 加的嵐山散步" })
  .filter({ has: page.getByRole("button", { name: "復原" }) })
  .last();
await mcpRow.waitFor();
page.once("dialog", (d) => d.accept());
await mcpRow.getByRole("button", { name: "復原" }).click();
await page.getByText("已復原", { exact: true }).first().waitFor();
await page
  .getByText(/・已復原/)
  .first()
  .waitFor();
await page.screenshot({ path: out("11-undo") });
log("復原 MCP 的新增");
await page.goto(tripUrl);
await page.locator("ol > li").first().waitFor();
await page
  .getByRole("button", { name: /Day 2/ })
  .first()
  .click()
  .catch(() => {});
await page.waitForTimeout(500);
if (await page.getByText("MCP 加的嵐山散步").count()) fail("復原後行程點應該被刪除");

// 設定：已連結的工具，撤銷後 MCP 立即失效
await page.goto(`${WEB}/settings`);
await page.getByText("E2E 助理").waitFor();
await page.screenshot({ path: out("12-settings"), fullPage: true });
page.once("dialog", (d) => d.accept());
await page.getByRole("button", { name: "撤銷" }).click();
await page.getByText("還沒有連結任何工具。").waitFor();
const afterRevoke = await fetch(`${API}/mcp`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${tok.access_token}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  },
  body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list" }),
});
log("撤銷後呼叫 MCP 的狀態碼", afterRevoke.status);
if (afterRevoke.status !== 401) fail("撤銷後 MCP 應回 401");

// 401 為未登入時的 refresh 檢查；字型與 Google 服務在離線環境會連不上
const unexpected = errors.filter(
  (e) =>
    !/auth\/refresh|ERR_CONNECTION_REFUSED|ERR_INTERNET_DISCONNECTED|fonts\.g|favicon\.ico|127\.0\.0\.1:9/.test(
      e,
    ) && !/status of 401/.test(e),
);
console.log("\n非預期錯誤：", unexpected.length ? unexpected : "無");
if (unexpected.some((e) => /HTTP 5\d\d|pageerror/.test(e))) fail("有伺服器錯誤或頁面例外");
await browser.close();
