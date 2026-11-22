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
- `packages/db`：需要 `TEST_DATABASE_URL`，在真的 PostgreSQL 上驗證 migration 與 trigger；
  沒設定時會跳過。CI 會用 PostGIS 容器執行。
- 端到端冒煙測試：先開沙盒 API 與 Web（`pnpm --filter @travelog/web build && pnpm --filter @travelog/web start`），
  再執行 `pnpm e2e`（第一次需 `npx playwright install chromium`）。兩個使用者走過建立行程、想去清單、
  訂位釘選、拖拉排序、邀請加入、我的地點庫等流程，截圖存在 `e2e/screenshots/`。

## 目前進度

- [x] 專案骨架、商業規則、資料庫 schema
- [x] 登入：Google（網頁、App）、Passkey、refresh token 輪替
- [x] 行程、行程點、拖拉排序、確定（釘選）／解除確定、訂位狀態、活動紀錄
- [x] 地點搜尋（Google Places）、想去清單（投票、排入某天）、我的地點庫
- [x] 成員與邀請（連結、email）、角色、移除、離開、轉移擁有權
- [x] Web 前端：登入、我的行程、行程規劃、成員與分享、我的地點、帳號設定
- [ ] Apple 登入（需要 Apple Developer 帳號）
- [ ] 邀請信實際寄送（目前只記錄在 log）
- [ ] 文件附件上傳、心得、PWA 離線、即時同步、MCP、App 內 AI、行動 App

## 授權

MIT
