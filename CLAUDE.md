# Travelog — 開發指引

旅程「行前規劃 → 行中查找 → 行後心得」的協作工具。Web、行動 App、MCP、App 內 AI 共用同一套 API。

## 必讀文件

- 產品規格：`docs/PRD.md`
- 系統架構：`docs/ARCHITECTURE.md`

實作與規格衝突時，先停下來確認，不要自行改規格。規格有變更時，同步更新這兩份文件。

## 開發流程

1. 每個工作開一個 `feat/…` 或 `fix/…` 分支，一個 PR 只做一件事。
2. Claude Code 完成實作後，**交給 Codex 做 code review**，處理完 review 意見才合併。
3. 合併前必須通過：`pnpm lint`、`pnpm typecheck`、`pnpm test`。

## 技術選擇（細節見 ARCHITECTURE.md）

- pnpm workspaces + Turborepo，全端 TypeScript（strict）。
- 後端：Hono + Drizzle ORM + PostgreSQL（PostGIS、pg_trgm）。部署在 GCP Cloud Run（asia-east1）。
- 測試：Vitest。Lint／格式：Biome。
- 本機開發使用本機安裝的 PostgreSQL，**不使用 Docker**。

## 目錄

- `apps/` — web、api、mcp、worker、mobile（陸續建立）
- `packages/domain` — 純商業邏輯（權限、確定行程點鎖定、城市歸類）。**不得依賴資料庫或框架**，所有入口（Web、App、MCP、AI）都必須經過這裡的規則。
- `packages/db` — Drizzle schema 與 migration。改 schema 後執行 `pnpm db:generate`；
  drizzle-kit 產生的 PostGIS 欄位會漏掉 SRID，請檢查 migration 中 `geometry(point, 4326)`。
- `packages/schema` — API 輸入的 zod schema（前端、App、MCP 共用）。
- `apps/api` — Hono API。`createApp(deps)` 注入 db、config、tokens、google、places、mailer、now，方便測試。
- `apps/web` — Next.js（App Router）前端，全部為 client component，以 access token 呼叫 API；
  refresh token 只存在 API 網域的 HttpOnly cookie。UI 色彩定義在 `globals.css` 的 `@theme`。
- `packages/tools`、`packages/api-client` — 之後建立。

## 測試慣例

- 沙盒（`pnpm sandbox`）：PGlite + 假 Google + 範例地點，用來手動試用與跑 `pnpm e2e`。只供本機，正式環境拒絕啟動。
- PGlite 只有一條連線：在交易內誤用 `db`（而不是 `tx`）查詢會直接卡住。測試因此能抓到這類錯誤；
  寫交易時所有查詢都要用 `tx`。

- 商業規則放 `packages/domain` 並寫單元測試。
- API 行為用 `apps/api/test/helpers.ts` 的 `createTestApp()`（PGlite）寫端到端測試，涵蓋權限、
  確定行程點、樂觀鎖等規則。
- 錯誤一律回 RFC 9457 Problem Details（`application/problem+json`），`type` 用 `/problems/...`。
- 修改需要 `If-Match`（ETag 為 `"v<version>"`）：沒帶回 428，版本不符回 412。

## 不可違反的規則

- 所有資料存取都要檢查行程成員角色（`packages/domain` 的權限函式），查詢一律帶 `trip_id`。
- 已確定（釘選）的行程點：日期、時間、時區、地點、類型、順序不能改，也不能刪除或移動；檢查在伺服器端 `assertItemMutable`，不能只靠前端。
- MCP 與 App 內 AI 都不能確定／解除確定行程點；App 內 AI 的寫入一律先轉成提案，由使用者套用。
- 時間一律存 UTC（timestamptz）並另存 IANA 時區；顯示以事件所在地時區為準。
- 不依 email 自動合併帳號；Passkey 只能由已登入使用者新增，不能用來註冊。
- 機密（OAuth secret、Apple `.p8`、JWT 金鑰）只放 Secret Manager 或 `.env.local`，不得進版控。

## 常用指令

```bash
corepack enable          # 第一次：啟用 pnpm
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm db:generate         # 依 schema 產生 migration
pnpm db:migrate          # 套用到 DATABASE_URL
```
