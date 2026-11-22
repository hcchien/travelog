# Travelog

和旅伴一起規劃行程、旅途中隨時查資料、回來後寫下心得。

- 產品規格：[docs/PRD.md](docs/PRD.md)
- 系統架構：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## 最快試用：沙盒模式（不需要資料庫與 Google 金鑰）

```bash
corepack enable
pnpm install
pnpm build
pnpm sandbox                         # API：http://localhost:8080（記憶體資料庫、假登入、範例地點）
pnpm --filter @travelog/web dev      # Web：http://localhost:3000
```

在登入頁按「使用 Google 帳號繼續」會進到沙盒登入頁，輸入名字即可登入；用不同名字可以模擬多個旅伴。
地點搜尋內建京都、東京、台北的範例地點（例如輸入「京都」「清水」「Fuglen」）。沙盒資料在重啟後清空。

## 本機開發（真的資料庫與 Google）

需求：Node.js 22 以上、PostgreSQL 16 以上（需 `postgis` 與 `pg_trgm` extension）。

```bash
cp .env.example .env.local                  # API 設定：資料庫、Google OAuth、Maps 伺服器金鑰
cp apps/web/.env.example apps/web/.env.local  # Web 設定：API 位址、Maps 瀏覽器金鑰

createdb travelog
createdb travelog_test
pnpm db:migrate

pnpm --filter @travelog/api dev      # http://localhost:8080
pnpm --filter @travelog/web dev      # http://localhost:3000
```

- macOS 若用 Homebrew 安裝 PostgreSQL，PostGIS 可用 `brew install postgis` 安裝。
- Google 登入：在 GCP 建立 OAuth 用戶端，重新導向 URI 加入 `http://localhost:8080/v1/auth/google/callback`。
- 地點搜尋：API 需要 `GOOGLE_MAPS_SERVER_KEY`（Places API New）；地圖需要 `NEXT_PUBLIC_GOOGLE_MAPS_KEY`（Maps JavaScript API）。
  沒有設定時，地點搜尋回 503，地圖改顯示清單，其他功能照常。

## 測試

```bash
pnpm lint && pnpm typecheck && pnpm test
```

- `packages/domain`：純單元測試。
- `apps/api`：在 PGlite（記憶體中的 PostgreSQL，含 PostGIS）上跑完整 API 流程，不需要任何設定。
  Passkey 以軟體 authenticator 產生真的 WebAuthn 簽章來測試；Google 與 Places 以假的實作替換。
- `packages/db`：需要 `TEST_DATABASE_URL`，在真的 PostgreSQL（含 PostGIS）上驗證 migration 與 trigger；
  沒設定時會跳過。CI 會用 PostGIS 容器執行。
- 端到端冒煙測試：先開沙盒 API 與 Web（`pnpm --filter @travelog/web build && pnpm --filter @travelog/web start`），
  再執行 `pnpm e2e`（第一次需 `npx playwright install chromium`）。兩個使用者走過建立行程、想去清單、
  訂位釘選、拖拉排序、邀請加入、我的地點庫、即時同步、行程內搜尋、今日頁與快速筆記、離線開啟、
  MCP 授權同意、MCP 修改後一鍵復原、撤銷授權等流程，截圖存在 `e2e/screenshots/`。

## App（apps/mobile）

Expo SDK 58。Google Sign-In 與推播是原生模組，需要 development build（不能用 Expo Go）：

```bash
cp apps/mobile/.env.example apps/mobile/.env   # 填 API 網址與 Google client ID
pnpm --filter @travelog/mobile ios             # 或 android；需要 Xcode／Android Studio
pnpm --filter @travelog/mobile bundle:check    # 不需要模擬器：確認 JS 能打包
```

配合 `pnpm sandbox` 時設 `EXPO_PUBLIC_SANDBOX_LOGIN=1`，登入頁會出現沙盒登入。App 以查看與記錄為主：
行程規劃、邀請、分享在網站上做。

## 部署

推到 `dev` 分支就會部署到 GCP dev 環境；第一次設定見 [`docs/DEPLOY.md`](docs/DEPLOY.md)。

## 用 AI 操作行程（MCP）

Travelog 不內建 AI，而是提供 MCP 連接器，讓你在自己慣用的 AI（例如 Claude）裡查詢與調整行程。

1. 在 AI 工具新增自訂連接器，網址填 `https://<API 網域>/mcp`（本機為 `http://localhost:8080/mcp`）。
2. AI 工具會自動註冊並開啟 Travelog 的授權頁，選擇要給的權限（讀取／修改行程／新增筆記）後按「允許」。
3. 之後就能說「Day 2 下午幫我加嵐山散步」「明天第一站在哪」。

- AI 以你的身分操作，權限與你在每趟行程的角色相同；不能修改已訂位的行程點、不能邀請成員或刪除行程。
- 透過 MCP 的修改都會在「成員與分享」的活動紀錄標示 MCP，可以一鍵復原。
- 在「帳號設定 → 已連結的 AI 工具」可隨時撤銷，撤銷後立即失效。

## 目前進度

- [x] 專案骨架、商業規則、資料庫 schema
- [x] 登入：Google（網頁、App）、Passkey、refresh token 輪替
- [x] 行程、行程點、拖拉排序、確定（釘選）／解除確定、訂位狀態、活動紀錄
- [x] 地點搜尋（Google Places）、想去清單（投票、排入某天）、我的地點庫
- [x] 成員與邀請（連結、email）、角色、移除、離開、轉移擁有權
- [x] Web 前端：登入、我的行程、行程規劃、成員與分享、我的地點、帳號設定
- [x] M4 行中：今日頁、快速筆記、PWA 與離線快照、SSE 即時同步、行程內搜尋
- [x] M5 MCP：OAuth 2.1 授權伺服器（DCR、Client ID Metadata Document、PKCE）、`/mcp` 端點與 15 個工具、
      同意頁、已連結的 AI 工具與撤銷、MCP 修改一鍵復原、連結多個 Google 帳號
- [x] M3：文件附件（PDF／截圖，直接上傳到 GCS Signed URL）、心得編輯器（受限的 Tiptap，只有文字）
- [x] M6：筆記轉心得、公開遊記（分享連結、隱藏住宿／只公開心得、可停用）
- [x] 邀請信：Resend（沒有金鑰時只寫 log）
- [x] M7 App（Expo）：Google 登入、行程表、今日頁、離線快取、離線筆記佇列、心得、附件、推播、刪除帳號
- [x] 部署：Dockerfile、Terraform（Cloud Run、Cloud SQL、GCS、Secret Manager、WIF）、推到 `dev` 自動部署（`docs/DEPLOY.md`）
- [ ] Apple 登入（需要 Apple Developer 帳號）
- [ ] App 上架（EAS Build、App Store／Play 審核）、Passkey 原生登入

## 授權

MIT
