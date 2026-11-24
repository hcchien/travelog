# Travelog security review — 2026-11-23

## 結論與範圍

建議先處理登入／帳號生命週期、SSRF、資源耗盡與 MCP 撤銷問題，再擴大對外使用。本次列出 **13 項需處理的發現：6 項高風險、7 項中風險**。其中包含程式漏洞及部署設定風險；不是 13 項都已在正式環境完成利用驗證，也沒有宣稱系統已遭入侵。

- 基準：`e782b4c2ebfde365cf86866952f720971e58b5f8` **加上審查開始時的工作目錄修改**，包含未追蹤的 `cloudbuild.yaml` 與 migration 0010。
- 範圍：API、Google／Passkey／第一方 session、MCP／OAuth、所有 trip 子路由、個人地點、公開分享、Web／Mobile 的登入與快取、資料庫 schema／migration、GCS adapter、Docker、GitHub Actions、Cloud Build、Terraform、lockfile 與本機 Git 歷史。
- 方法：人工資料流與權限追蹤、來源函式局部執行、機密模式掃描、官方安全公告比對。
- 未修改產品程式碼、未 commit／push／部署；新增的檔案只有本報告與離線驗證腳本／結果。
- **限制**：沒有 `node_modules` 或可用的 pnpm。嘗試透過 npm 執行 pnpm audit 時，registry DNS 回 `ENOTFOUND registry.npmjs.org`，因此未執行完整測試套件、建置、完整 transitive dependency audit。沒有讀取實際 GCP IAM／SQL grants／網路設定，沒有對線上服務進行攻擊、負載或內網探測。

嚴重度以可達性、攻擊前提及影響判斷，不是 CVSS 計算。高風險優先於擴大公開部署處理；中風險應納入下一輪修補，部署權限項目宜一併處理。

## 發現總表

| ID | 風險 | 問題 | 證據層級 |
| --- | --- | --- | --- |
| SEC-01 | 高 | 任意網址 fragment 可替換 Web 登入 session | 來源函式重現＋後端流程追蹤 |
| SEC-02 | 高 | Google 帳號連結可跨瀏覽器轉交，形成帳號預先劫持 | 靜態完整流程追蹤，有受害者身分前提 |
| SEC-03 | 高 | CIMD metadata 抓取的 SSRF 防護漏掉 DNS／IPv6 | mocked fetch 重現；實際內網／TLS 未驗證 |
| SEC-04 | 高 | PATCH 單一日期繞過 60 天上限，造成資源放大 | 範圍判斷與日期產生器局部重現 |
| SEC-05 | 高 | 匿名端點、付費服務與 MCP 輸入缺少必要資源限制 | 程式／部署設定＋官方公告 |
| SEC-06 | 高 | 刪除帳號後舊 JWT 仍能寫入，並可建立新的長效授權 | 靜態跨路由追蹤 |
| SEC-07 | 中 | 撤銷後重新授權，舊 MCP token 的舊 scope 可恢復 | 原查詢方法＋mocked ORM 重現 |
| SEC-08 | 中 | OAuth 同意頁缺少防嵌入保護 | Web 設定缺口；線上 headers 未驗證 |
| SEC-09 | 中 | Mobile 換帳號未清 React Query；Web 快取忽略拒絕存取 | 靜態快取生命週期追蹤 |
| SEC-10 | 中 | 已完成附件仍能被舊 signed PUT URL 覆寫 | adapter／完成流程追蹤；GCS 未實測 |
| SEC-11 | 中 | 刪除行程不刪 GCS 物件；未完成上傳沒有清理 | 刪除路由與儲存設定追蹤 |
| SEC-12 | 中 | API 與 migration 共用高權限資料庫使用者 | Terraform 設定；實際 SQL grants 未驗證 |
| SEC-13 | 中 | Cloud Build 讓 Web／API／migration 共用 service account | Cloud Build 與 Terraform 設定差異 |

## 詳細發現與修補驗收

### SEC-01 — 網址可以把受害者登入到攻擊者的帳號

**位置**：`apps/web/src/lib/api.ts:24`、`:45`、`:68`；`apps/api/src/auth/routes.ts:104`。

`takeHashRefreshToken()` 無條件接受 `#tl_rt=...`，直接覆寫 `localStorage` 的 refresh token，再由 `refreshAccessToken()` 優先拿它換發 access token。沒有檢查瀏覽器是否曾發起對應的登入交易，也沒有 state／nonce 或一次性兌換碼。

攻擊者可取得**自己帳號**的 refresh token，讓受害者開啟 `/trips#tl_rt=<攻擊者的 token>`。頁面重新載入後就可能登入攻擊者帳號，受害者往後建立的行程、筆記與附件會進入攻擊者可存取的帳號。攻擊者仍可用另一個 session／Google 身分存取自己的帳號，不需要重用那枚被輪替的 token。

這不是「不用憑證就登入任意既有受害者帳號」。它是 login CSRF／session injection。且不只影響 `run.app`：前端在所有環境解析 fragment，後端 body refresh 分支始終接受 `cid=app` 的 token。

額外影響：目前 run.app fallback 把長效 bearer credential 放在網址 fragment 與 JavaScript 可讀取的 localStorage，擴大 XSS／第三方腳本遭入侵時的影響。**fragment 通常不會隨 HTTP request 或 Referer 送到伺服器，不能將它誤報成一般 access log 外洩。**

**修補**：優先使用同站 API／Web 網域或 BFF 保持 HttpOnly session。如果必須跨站交接，改為短效、一次性、綁定發起瀏覽器交易的 code，兌換時驗證預先保存的隨機 state／PKCE；不得接受任意 refresh token 作為登入交接。

**驗收**：已登入與未登入瀏覽器開啟別人的 `#tl_rt` 都不能切換帳號；正常 Google／Passkey 登入仍成功；交接 code 不可跨瀏覽器兌換或重播。

### SEC-02 — 帳號連結 URL 未綁定原本 session

**位置**：`apps/api/src/auth/routes.ts:51`、`:77`、`/v1/me/identities/link/google`；`apps/api/src/auth/tokens.ts:165`；`apps/api/src/auth/identities.ts` 的 `linkIdentity()`。

登入的攻擊者可替自己的 Travelog 帳號取得 link JWT，再把整個 Google link URL 轉交受害者。GET `/v1/auth/google?link=...` 不驗證當前使用者，而是直接取 JWT 的 `sub` 寫入新 OAuth cookie；受害者完成 Google 登入後，callback 將受害者的 Google 身分接到攻擊者指定的 Travelog 帳號。

**前提**：該 Google 身分尚未綁定其他 Travelog 帳號，且受害者配合完成 Google 選帳號／登入。已綁定其他帳號的身分會回 conflict，因此不能宣稱能直接奪取所有既有帳號。符合前提時，受害者之後用 Google 登入，會進入仍由攻擊者控制的同一個帳號。

此外，註解稱 link token 為「一次性」，實際只驗 JWT 到期與 purpose，沒有消耗 `jti` 的紀錄；有效期內可再次發起交易。

**修補**：以原本已驗證的 session 建立伺服器端 link transaction，綁定 user、session、瀏覽器隨機 challenge；callback 必須確認仍是同一個 session，並以原子操作消耗交易。連結前顯示明確帳號確認，對新增登入方式要求近期重新驗證。

**驗收**：A 建立的 link URL 在 B 瀏覽器不能完成連結；完成後重播失敗；登出、刪除帳號後未完成的 link transaction 失效。

### SEC-03 — CIMD SSRF 防護只檢查字面 hostname

**位置**：`apps/api/src/oauth/clients.ts:33`–`:49`；`apps/api/src/oauth/routes.ts:112`–`:114`。

未登入的 `/oauth/authorize` 會先解析並抓取 URL 型的 client ID。`PRIVATE_HOST` 擋了一部分 IPv4，但沒有解析 A／AAAA，也漏掉 IPv4-mapped IPv6、ULA、link-local IPv6。局部測試確認 `https://[::ffff:127.0.0.1]/...`、`https://[fc00::1]/...`、`https://[fe80::1]/...` 均通過現有檢查到達 mocked fetch；一般 DNS 名稱亦沒有解析後的位址檢查。

可被用作對 API 可達網路的 HTTPS 請求來源。**實際資料讀取還受路由、TLS 憑證、回應格式限制；本次沒有證實能讀 GCP metadata，也沒有把 HTTP metadata 端點或缺少必要 metadata header 的請求當成已成功的憑證外洩。**

**修補**：使用成熟 IP 分類函式檢查所有解析結果，拒絕 loopback、private、link-local、reserved、mapped IPv6；連線必須使用已核准的解析結果，避免 DNS rebinding／檢查與連線不同步。搭配 egress policy／proxy；保留禁止 redirects、timeout，並以串流 byte counter 限制回應大小。

**驗收**：所有私有與特殊 IPv4／IPv6、DNS 指向內網、多筆 A／AAAA、DNS 切換及 redirect 案例均拒絕，合法 CIMD 正常。MCP 官方安全指南明確涵蓋 authorization server 抓取 CIMD 的 SSRF 風險，見文末來源。

### SEC-04 — 單欄 PATCH 繞過日期跨度限制

**位置**：`packages/schema/src/trips.ts:24`–`:27`、`:43`–`:51`；`apps/api/src/trips/routes.ts:113`–`:118`；`apps/api/src/trips/days.ts`。

schema 只在 startDate 與 endDate 同時出現時檢查 60 天。PATCH 合併舊資料後只檢查先後順序，接著呼叫無上限的 `datesBetween()`，產生陣列並批次建日期資料。

已登入者可對自己建立的行程只更新 `endDate`。局部測試中，`{endDate: '2026-04-01'}` 通過 predicate，配上舊的 `2026-01-01` 會產生 91 天；`9999-12-31` 也通過，對應 **2,912,443 天**。沒有實際配置數百萬列或對線上送出這個 payload；風險是同步 CPU／記憶體、ORM SQL 建構、資料庫資源耗盡，即使 SQL 最後失敗也已消耗應用資源。

**修補**：在合併完整日期後重新驗證跨度，於 `datesBetween()` 加防禦性上限；資料庫也限制合理區間。不要只靠請求大小，因為幾十 bytes 就能觸發放大。

**驗收**：只更新開始／結束、同時更新兩者，60 天通過、61 天拒絕；極端合法日期在陣列／SQL 建構前就回 4xx。

### SEC-05 — 公開端點與付費資源缺少限制

**位置**：`apps/api/src/app.ts`；`apps/api/src/oauth/routes.ts` 的 register／authorize；`apps/api/src/auth/passkey.ts` 的 login/options；`apps/api/src/oauth/clients.ts:47`；`packages/schema/src/items.ts` 的 `details`；`apps/api/src/mcp/routes.ts:85`。

- 匿名 DCR 每次可新增 client，匿名 Passkey options 每次可新增 challenge；repo 沒有 IP／client／帳號配額、速率限制或過期資料清理。authorize 亦可持續寫 pending request。
- REST JSON 解析之前沒有 body limit；`details` 接受無大小上限的 record，journal 的總大小檢查在遞迴驗證之後。CIMD 先 `res.text()` 才做 64 KiB 判斷，不能阻止大回應先被完整收進記憶體。
- 普通使用者能反覆使用 Google Places、邀請寄信、申請附件，沒有單使用者／行程／總容量及費用配額。`max-instances=3` 不是對每個攻擊者的限制，也不能限制 GCS 儲存增長或付費 API 次數。
- `McpServer` 只傳 `instructions`，沒有 `maxToolInputElements`。官方 GHSA-46jr-4wx8-v453 說明：1.32.0 以後仍需顯式開啟此防護；**僅升級 SDK 並不夠**。現有 SDK 是 1.32.2，所以不能把舊版 HTTP body／batch 無上限的 GHSA-f897-62hf-6gxq 原樣套在它身上；此處是輸入元素防護未啟用及應用層資源限制不足。

**修補**：解析前限制 body bytes／深度／元素數；設定 MCP 元素與合適 body 上限；CIMD 串流限額；匿名端點分層限流、認證端點失敗節流、按 user/client 控制付費操作、附件總配額、過期資料與 pending upload 清理。若使用 Cloud Armor，需限制 Cloud Run ingress，避免直接 run.app URL 繞過 LB。

**驗收**：oversized／過深／過多元素快速回 4xx，不耗盡記憶體；超額回 429；多 instance 共享限額；有效期過後資料確實清理。本次未執行壓力測試或計費操作。

### SEC-06 — 軟刪除帳號沒有在認證入口失效

**位置**：`apps/api/src/lib/middleware.ts:5`；`apps/api/src/auth/tokens.ts:136`；`apps/api/src/auth/account.ts`；`apps/api/src/auth/identities.ts`。

刪帳號移除 refresh tokens／identities／members，並設 `users.deletedAt`，但 `verifyAccessToken()` 只驗簽章、issuer、audience 與時間。`requireAuth()` 不查使用者是否仍有效。只有 GET `/v1/me` 與 Passkey 登入等少數位置會拒絕 deleted user。

因此刪除前的 access token 在剩餘 15 分鐘內，仍能直接 POST `/v1/trips`、寫個人地點等。更重要的是，舊 token 仍可呼叫 OAuth decision 產生新的 refresh grant，或啟動 Google link 把新的未綁定身分加到被刪的 user；`findOrCreateUser()` 的 existing identity 分支不查 deletedAt，後續可再簽發第一方長效憑證。

**影響邊界**：既有 trip membership 已移除，並不代表能直接讀取已轉移行程；問題是被撤銷的帳號仍可操作、重新加入或建立資料，且可重新建立長效授權。前端 GET `/v1/me` 失敗並不能擋住直接 API client。

**修補**：在所有第一方／MCP token 驗證及簽發、refresh、link callback、OAuth code exchange 的共用入口檢查 active user；採用 session／grant version 或撤銷 epoch。刪除帳號時一併使未完成登入／連結交易失效，處理與新授權併發的競態。

**驗收**：刪帳號後，原 access token 對所有受保護 endpoint 回 401；不能建立 trip、重新 link、同意 OAuth、換新 token；保留正常的共同行程去識別化行為。

### SEC-07 — 新授權會讓被撤銷的舊 MCP token 復活

**位置**：`apps/api/src/auth/tokens.ts` 的 `hasActiveGrant()`；`apps/api/src/mcp/routes.ts:58`–`:65`。

MCP access token 帶 user、client、scope，卻沒有 grant／family ID。授權檢查只要同一 user/client 存在任意未撤銷 refresh row 就回 true，不檢查該 JWT 對應的 grant 或有效 scope。

流程：取得讀寫 token → 撤銷 client → 同一 client 重新取得唯讀授權 → 原本尚未到期的讀寫 JWT 再次通過 gate，接著以它的舊 scope 簽內部 token。另一個仍活著的 family 也會讓被單獨撤銷 family 的 access token 繼續通過。局部原方法測試確認 gate 為 `true → false → true`；未執行完整 JWT／HTTP 流程。

**修補**：access token 綁 grant ID／version，查該 grant 是否有效；有效 scope 由目前 grant 約束，且不因後來新 grant 出現而復活。refresh rotation 維持同一 grant，撤銷操作明確區分 family 與整個 client。

**驗收**：撤銷後重授權唯讀，舊讀寫 token 持續 401；同 client 的不同 family 不互相替對方通過撤銷檢查。

### SEC-08 — 同意頁缺少防 clickjacking 保護

**位置**：`apps/web/next.config.ts:4`；`apps/web/src/app/oauth/consent/page.tsx`。

Hono 的 `secureHeaders()` 保護 API 回應，沒有覆蓋 Next.js 產生的同意頁。Web 設定沒有 `frame-ancestors` 或 `X-Frame-Options`。攻擊者可註冊自己的 OAuth client、建立授權請求，再嘗試用透明／誤導 iframe 引導已登入者按「允許」。

**前提／限制**：需瀏覽器在被嵌入情境能取得登入狀態，取決於 cookies／storage partitioning；也可能由線上 reverse proxy 補 header，本次未驗證。此項是明確的 repo 保護缺口，不是已確認的線上 iframe 利用。

**修補**：至少對登入、設定、OAuth consent 頁加入 `Content-Security-Policy: frame-ancestors 'none'` 及 `X-Frame-Options: DENY`；再規劃符合 Next／Maps 需求的完整 CSP。

**驗收**：直接 Next 與實際部署網址均有 header；跨站 iframe 無法顯示同意頁，正常頂層授權流程不受影響。

### SEC-09 — 本機快取沒有完整跟著帳號／權限切換

**位置**：`apps/mobile/src/lib/auth.tsx:59`–`:64`；`apps/mobile/app/_layout.tsx:30`；`apps/mobile/src/lib/queries.ts`；`apps/web/src/app/trips/[tripId]/today/page.tsx:116`–`:127`；`apps/web/src/lib/offline.ts`。

Mobile `reset()` 清 SecureStore／AsyncStorage，但不清除 RootLayout 持續持有的 QueryClient。query key 是 `['trips']`、`['snapshot', tripId]`，沒有 user ID；使用者 A 登出後 B 登入同一個 App process，可能先看到 A 的仍新鮮快取（staleTime 30 秒），或看到背景重抓前的舊 trip／訂位／筆記資料。

Web 的快照只以 tripId 存，今日頁對所有 API 錯誤都落入離線快取，包含 401／403／404；被移出行程也繼續顯示舊快照。已下載資料無法保證遠端抹除，但 client 在收到明確拒絕後仍主動顯示，與離線例外不應混為一談。

**修補**：登出／刪帳號／換使用者時取消 in-flight queries、清除 QueryClient 並處理舊請求回寫；持久與記憶體快取以 user ID 隔離。只有真正網路不可達才 fallback；401／403／404 清除對應快取並顯示拒絕／登入。離線 outbox 也需綁 user 與 session generation。

**驗收**：A→登出→B，B 在線上／離線／舊請求延遲回覆情境都看不到 A 資料；被移出後收到拒絕時不再顯示快照。

### SEC-10 — 附件完成後仍可覆寫同一物件

**位置**：`apps/api/src/lib/storage.ts:35`–`:61`；`apps/api/src/trips/attachments.ts:105`–`:122`。

15 分鐘 signed PUT URL 指向最終 storage key，沒有 create-only generation precondition。complete 只驗大小再標 ready，下載也未固定 object generation。URL 在有效期內仍可重用，同大小／MIME 的新檔案可取代已完成的票券或憑證；已被移出的上傳者仍可在 URL 到期前改內容，且不再經過 API 權限或 activity log。

**修補**：採 staging object 上傳，完成時驗證後複製至不可覆寫的 final key，保存並固定 generation／checksum；或使用可驗證的一次建立 precondition 與 generation 綁定。不得只在 complete 增加狀態判斷，因為 PUT 直接到 GCS。

**驗收**：完成後重送原 PUT 不能改變下載內容；移除成員後舊 PUT 不能改最終物件；並行 complete／PUT 一致。需在專用測試 bucket 實測，不應以本機 adapter 結果代替 GCS 驗證。

### SEC-11 — 刪行程會留下失去追蹤的附件

**位置**：`apps/api/src/trips/routes.ts:142`–`:146`；`packages/db/src/schema/itinerary.ts` attachments FK；`infra/terraform/storage.tf`。

DELETE trip 只刪 PostgreSQL row。FK cascade 刪附件 metadata，但沒有 `storage.remove()` 或 cleanup job；不同於帳號刪除流程有收集孤兒 key。未 complete 的 pending upload 也沒有 TTL 清理。bucket 沒有對應 lifecycle／清理工作。

票券／訂位文件因此在使用者刪除行程後仍保留、持續計費，且資料列消失後更難清查。這不代表它們變成公開；既有 signed download URL 仍可能在剩餘 5 分鐘內有效。

**修補**：交易內記錄待刪 key／generation 到 durable outbox，再由可重試 worker 刪除；pending upload 設 expiry 與清理。bucket soft delete／versioning／備份保留需納入對使用者承諾的刪除語意。

**驗收**：刪除 trip 後物件按政策刪除；暫時 GCS 失敗會重試；重跑 idempotent；不誤刪其他行程附件。

### SEC-12 — 執行期 DB 帳號也能做 migration

**位置**：`infra/terraform/database.tf:46`–`:51`；`infra/terraform/secrets.tf` 的 generated database-url；`infra/terraform/run.tf` 的 API 與 migrate 環境。

Terraform 建立一個內建 SQL user，程式註解明確指出其具有 `cloudsqlsuperuser`；同一 DATABASE_URL 提供 API 與 migration，沒有獨立的 runtime 最小權限角色。這會放大未來 SQL injection／API RCE／憑證外洩的影響，可及 schema／DDL／其他授權能力，而不只是必要資料 CRUD。

**限制**：未取得實際 SQL grants；也未在本 repo 確認 SQL injection。這是部署權限風險，不能把 Cloud SQL 管理角色當成無限制 OS／PostgreSQL 原生 superuser。

**修補**：migration owner 與 runtime login 分開；runtime 只給必要 table／sequence 操作，無 CREATE／ALTER／DROP／role 管理；各環境 credentials 分開。建立 extension 只用 migration 身分。

**驗收**：以 runtime 連線執行必要 API 查詢成功，DDL／新增 role／改 trigger 失敗；migration 使用另一個受限用途帳號。

### SEC-13 — Cloud Build 合併了 Web／API 的 IAM 邊界

**位置**：`cloudbuild.yaml:95`、`:126` 與 migrate 步驟；對照 `infra/terraform/iam.tf`、`infra/terraform/run.tf`。

Terraform 為 API、Web 分別建立 service account，但新增的 Cloud Build 部署三者都傳 `_SERVICE_ACCOUNT`。若該身分具 API 所需的 Secret Manager、GCS、Cloud SQL 權限，Web process 也可透過服務身分使用相同權限；即使 Web 沒有注入那些 secret 環境變數，也不等於無法呼叫 Secret Manager。

**限制**：已確認 YAML 行為，但尚未證實這份尚未追蹤的檔案已部署，以及該共享身分的實際 IAM 範圍。

**修補**：分開 `_API_SERVICE_ACCOUNT`、`_WEB_SERVICE_ACCOUNT`、`_MIGRATION_SERVICE_ACCOUNT`；Web 不授予 API secrets／bucket／DB 權限；讓兩套部署方式一致，避免每次 Cloud Build 覆蓋回共用身分。

**驗收**：實際 Cloud Run services／job 的 runtime identity 各自正確；Web identity 讀 API secret／bucket／Cloud SQL 被拒絕。

## 已有的有效防護

本次追蹤的資料路由普遍先查 trip membership，再檢查角色與 tripId；saved places 使用 userId 限制。沒有確認到一般跨行程 IDOR、直接 SQL injection、命令注入或 journal stored XSS。這是本次檢查結果，不是不存在任何漏洞的保證。

- JWT 指定 ES256、issuer、audience、`at+jwt`；MCP resource token 與第一方 API token 分開。
- OAuth code 使用 PKCE S256、精確 redirect URI 比對、code hash 與 `approved → used` 條件更新。
- Refresh token 雜湊保存、交易鎖定輪替、reuse 時撤銷整個 family。
- Cookie refresh／logout 要求允許的 Origin；Google callback 驗 state／nonce。
- 身分以 provider/sub 對應，沒有依 email 自動合併；Passkey 註冊需要登入，challenge 單次消耗。
- MCP 工具呼叫沿用 API 權限；已確定行程點有 domain 與 DB trigger 雙重防線。
- 公開遊記用欄位白名單，沒有直接輸出附件 signed URL、booking confirmation、私人快速筆記或成員 email。
- Journal 使用受限節點／連結 schema，再轉 React 元素，沒有 dangerouslySetInnerHTML；email HTML 有跳脫。
- GCS 設 public access prevention；附件 object key 由伺服器產生；Docker runtime 使用非 root 使用者；CI 有 frozen lockfile。

## 套件安全公告比對

以下是 **特定公告比對，不是完整 SCA 通過**。版本來自 lockfile 的 workspace dependency document；該 lockfile 同時含 package-manager 與 workspace 兩段 YAML，不能只讀第一段就誤判沒有相依套件。

| 套件／鎖定版本 | 已核對公告 | 判斷 |
| --- | --- | --- |
| Next 16.4.6 | GHSA-pc58-hwjq-p385；16.4.5 修補 | 高於該公告修補版本 |
| Next 16.4.6、sharp 0.35.5 | GHSA-2464-fhr4-w9xw；Next 16.4.1／sharp 0.35.5 修補 | 鎖定版本已包含該修補 |
| Hono 4.13.19 | GHSA-92p4-j3wq-jmqx；4.13.18 修補 | 高於該公告修補版本 |
| MCP SDK 1.32.2 | GHSA-f897-62hf-6gxq；1.30.1 修補 | 已有該版本的 HTTP body／batch 保護 |
| MCP SDK 1.32.2 | GHSA-46jr-4wx8-v453；1.32.0 新增 opt-in 保護 | **仍需啟用 maxToolInputElements，見 SEC-05** |
| Web React 19.3.1、Mobile React 19.3.0 | GHSA-xqc2-xf4c-x3h3 針對 react-server-dom-* | 不能因 Mobile 的 react 19.3.0 就認定有 server RCE；原生 App 不是 RSC server。Next 內嵌 RSC 實際版本仍需檢查建置 artifact |

完整 dependency closure、容器 OS 套件、Next 內嵌版本、native iOS／Android 產物都需在可安裝／建置的環境再做 SBOM 與漏洞掃描。

## 機密掃描與其他加固項目

本機工作檔 241 個、3 個本機 commits、286 個不重複歷史 blobs 做模式掃描。涵蓋 PEM private key、Google OAuth secret、GitHub token、AWS access ID、Resend key 與 Google API key；**未命中前五類**。工作目錄 `cloudbuild.yaml` 命中一個 `NEXT_PUBLIC_GOOGLE_MAPS_KEY`，沒有在報告輸出值。瀏覽器 Maps key 本來就會進前端，不能只因出現在 YAML 就判定秘密外洩；需要到 Google Cloud 確認 HTTP referrer／API restrictions／quota，且必須與 server key 分開。此掃描不是 entropy detector，也未抓取遠端 refs／CI logs。

另外建議：

1. **CI／供應鏈**：Cloud Build 沒有 lint／typecheck／test／audit gate，與 GitHub Actions 不一致；image、Actions 仍有可變 tags。加入安全 gate、SBOM／image scan，固定受審查的 action SHA 與 image digest，保留可追溯的部署證據。
2. **敏感動作重新驗證**：新增／移除登入方式、Passkey、刪帳號、轉移 owner，要求近期 Google／Passkey 驗證。第一方登出只撤 refresh family，尚未到期的 access token 可繼續使用；若產品需要即時撤銷，需 session ID／epoch，而不是只縮短 JWT 時效。
3. **併發權限操作**：OAuth decision 更新沒有 `status=pending` 條件；移除登入方式先 count 再 delete；ownership transfer 沒有先鎖定 trip。應補 PostgreSQL 併發測試，避免雙重決策、刪光身分或多 owner。此處未以單連線 PGlite 宣稱競態已驗證。
4. **快取與 SSE**：public API 有 `s-maxage=300`，Next fetch revalidate 60 秒，service worker 亦可離線保留公開頁；分享撤銷不是已下載副本的遠端刪除。依產品要求設停用延遲／cache invalidation。SSE 只在 member.removed 關閉，未處理 token 到期、member.left、帳號刪除，且 queue 沒上限；應定期驗權、限制連線數／queue 與清理 timer。
5. **記錄與備援**：未設定 Resend 時邀請完整 URL／email 寫 log；未預期 Drizzle 錯誤可能帶 query params。以結構化 allowlist／redaction 記錄；Terraform state 含產生的秘密，應驗證 remote backend IAM／加密／版本保留。Cloud SQL 有每日備份，但 repo 未配置 PITR／還原演練或安全告警，實際營運設定待確認。
6. **公開資訊最小化**：撤銷／過期邀請的預覽仍回 trip 名稱、日期與邀請人；CIMD 更新失敗無期限沿用舊 metadata；前端 login safeReturnTo 沒有像 API 排除反斜線。應限制失效邀請回應、設定 metadata stale 上限，並統一相對 URL 正規化與同 origin 驗證。
7. **MCP 語意**：journal:write 同意文字僅寫「新增筆記」，實際包含 write_journal／replace；所有工具一律 destructiveHint=false，且並非所有修改都能 undo。修正授權文案及工具 annotations；對包含他人輸入的筆記／遊記明確標示不可信內容。prompt 的「先取得同意」本身不是伺服器授權控制。

## 驗證紀錄與修補順序

離線驗證檔案：

- [probes.mjs](security-review-2026-11-23/probes.mjs)：直接讀取來源函式，Node 內建 TypeScript stripping 執行；所有 fetch 與 ORM 都是 mock，不發網路請求。
- [probe-results.json](security-review-2026-11-23/probe-results.json)：Node v26.7.0 執行，4 組成功重現上述問題行為。這不是測試套件通過，也不是修補驗收通過。

重跑：`node docs/security-review-2026-11-23/probes.mjs`。腳本刻意 assert 目前不安全行為，修正後應更新為正式安全回歸測試，不應直接加進 CI 當作「安全通過」標準。

建議修補順序：

1. SEC-01／02／06：登入交接、連結帳號與刪帳號後撤銷。
2. SEC-03／04／05：SSRF、日期放大、限流與輸入上限。
3. SEC-07／08：grant 綁定與 OAuth consent 防嵌入。
4. SEC-12／13：runtime DB／IAM 最小權限，兩套部署設定一致。
5. SEC-09／10／11：帳號快取隔離、附件不可覆寫及可重試刪除。

在能安裝相依套件的環境，補上各項驗收案例，再跑原有 domain／API tests、真正 PostgreSQL 的 migration／race tests、Web／Mobile 換帳號與 iframe E2E、隔離 GCS bucket 測試，以及完整 package／image audit。最後以實際部署設定驗證 IAM、headers、ingress、配額、金鑰限制及備份。

## 外部來源（審查日查閱）

- [MCP security best practices：包括 CIMD authorization-server SSRF](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/docs/2026-07-28/tutorials/security/security_best_practices.mdx)
- [MCP：GHSA-46jr-4wx8-v453，輸入元素數量限制需要顯式設定](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-46jr-4wx8-v453)
- [MCP：GHSA-f897-62hf-6gxq，HTTP body／batch limits](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-f897-62hf-6gxq)
- [Next：GHSA-pc58-hwjq-p385](https://github.com/vercel/next.js/security/advisories/GHSA-pc58-hwjq-p385)
- [Next／sharp：GHSA-2464-fhr4-w9xw](https://github.com/vercel/next.js/security/advisories/GHSA-2464-fhr4-w9xw)
- [Hono：GHSA-92p4-j3wq-jmqx](https://github.com/honojs/hono/security/advisories/GHSA-92p4-j3wq-jmqx)
- [React Server Components：GHSA-xqc2-xf4c-x3h3](https://github.com/react/react/security/advisories/GHSA-xqc2-xf4c-x3h3)
