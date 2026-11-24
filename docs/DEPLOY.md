# 部署到 GCP（dev 環境）

推到 `dev` 分支就會自動部署（`.github/workflows/deploy-dev.yml`）。第一次需要先用 Terraform 建好基礎設施。

## 架構

| 元件      | 服務                                          | 說明                                                                                |
| --------- | --------------------------------------------- | ----------------------------------------------------------------------------------- |
| Web       | Cloud Run `travelog-dev-web`                  | `https://app.<domain>`，Next.js standalone                                          |
| API       | Cloud Run `travelog-dev-api`                  | `https://api.<domain>`，含 OAuth 授權伺服器、`/mcp`、SSE                            |
| Migration | Cloud Run Job `travelog-dev-migrate`          | 與 API 同一個映像檔，每次部署前執行                                                 |
| 資料庫    | Cloud SQL PostgreSQL 16（db-f1-micro）        | 透過 Cloud SQL connector 以 unix socket 連線，不開放任何 IP                         |
| 附件      | Cloud Storage（不公開）                       | 讀寫一律用 API 簽發的短效 Signed URL                                                |
| 秘密      | Secret Manager                                | 資料庫連線、cookie 金鑰、JWT 私鑰由 Terraform 產生；Google／Resend／Maps 金鑰手動填 |
| 映像檔    | Artifact Registry                             | 保留最近 15 版，30 天以上自動清除                                                   |
| CI/CD     | GitHub Actions + Workload Identity Federation | 不使用金鑰檔；只有指定 repo 的 `dev` 分支能部署                                     |

> **為什麼一定要自訂網域？** refresh token 存在 API 網域的 HttpOnly cookie（SameSite=Lax）。Web 與 API 必須是同一個站（例如 `app.dev.example.com` 與 `api.dev.example.com`），瀏覽器才會送出 cookie。兩個 `*.run.app` 網址屬於不同的站，登入後重新整理就會被登出。網域同時也是 Passkey 的 RP ID，定了之後不要改。

預估費用（dev、流量很小）：Cloud SQL db-f1-micro 約每月 US$10，其他（Cloud Run 縮到 0、Storage、Secret Manager、Artifact Registry）通常在免費額度內或幾塊美元。

## 第一次設定

需要：GCP 專案（已啟用計費）、`gcloud`、`terraform` ≥ 1.6、一個可以設定 DNS 的網域。

### 1. 驗證網域擁有權

Cloud Run 網域對應需要先驗證根網域（用執行 Terraform 的帳號）：

```bash
gcloud domains verify example.com   # 依畫面指示在 DNS 加 TXT 紀錄
```

### 2. 建立 Terraform 狀態 bucket

```bash
export PROJECT=your-gcp-project
gcloud storage buckets create gs://$PROJECT-tfstate --project $PROJECT --location asia-east1 --uniform-bucket-level-access
gcloud storage buckets update gs://$PROJECT-tfstate --versioning
```

### 3. 建立基礎設施

```bash
cd infra/terraform
cp dev.tfvars.example dev.tfvars      # 填入 project_id、domain、github_repository、google_client_id
gcloud auth application-default login
terraform init -backend-config="bucket=$PROJECT-tfstate" -backend-config="prefix=travelog/dev"
terraform apply -var-file=dev.tfvars
```

Cloud SQL 第一次建立約需 10 分鐘。完成後看輸出：

```bash
terraform output dns_records        # 2. 加到 DNS
terraform output github_variables   # 5. 設到 GitHub
terraform output google_oauth_redirect_uri
```

### 4. DNS 與 Google 登入

1. 依 `dns_records` 在 DNS 加上 `app.<domain>`、`api.<domain>` 的紀錄。憑證由 Google 自動簽發，DNS 生效後約 15–60 分鐘。
2. GCP 主控台 → API 和服務 → 憑證 → OAuth 用戶端（網頁應用程式）：
   - 已授權的 JavaScript 來源：`https://app.<domain>`
   - 已授權的重新導向 URI：`google_oauth_redirect_uri` 的值
   - 把用戶端 ID 填進 `dev.tfvars` 的 `google_client_id`，再 `terraform apply` 一次

### 5. 填入手動管理的秘密

Terraform 先放了 `unset`，用新版本取代（Terraform 不會覆蓋）：

```bash
printf '%s' 'GOCSPX-...' | gcloud secrets versions add travelog-dev-google-client-secret --data-file=-
printf '%s' 're_...'     | gcloud secrets versions add travelog-dev-resend-api-key --data-file=-     # 沒有就維持 unset：邀請信只寫 log
printf '%s' 'AIza...'    | gcloud secrets versions add travelog-dev-maps-server-key --data-file=-    # 沒有就維持 unset：地點搜尋停用
```

Resend：在 Resend 驗證寄件網域後，把 `mail_from` 改成該網域的地址（預設的 `onboarding@resend.dev` 只能寄給 Resend 帳號本人）。

改了秘密之後，下一次部署才會生效；要立即生效可以 `gcloud run services update travelog-dev-api --region asia-east1`。

### 6. 設定 GitHub

1. Repo → Settings → Environments 建立 `dev`（可以加保護規則，例如只允許 `dev` 分支）。
2. Settings → Secrets and variables → Actions → **Variables**，依 `terraform output github_variables` 逐一新增：
   `GCP_PROJECT_ID`、`GCP_REGION`、`GCP_WIF_PROVIDER`、`GCP_DEPLOYER_SA`、`GCP_REGISTRY`、`SERVICE_PREFIX`、`APP_ORIGIN`、`API_ORIGIN`。
3. 選填：`NEXT_PUBLIC_GOOGLE_MAPS_KEY`、`NEXT_PUBLIC_GOOGLE_MAP_ID`（瀏覽器端地圖用的金鑰，請在主控台限制 HTTP referrer 為 `https://app.<domain>/*`）。

### 7. 部署

```bash
git checkout -b dev && git push -u origin dev
```

Actions 會依序：lint／typecheck／test／Terraform 驗證 → 建置並推送兩個映像檔 → 執行 migration job → 部署 API 與 Web → 健康檢查。

## 日常

- **部署**：合併或推到 `dev`。
- **回復上一版**：`gcloud run services update-traffic travelog-dev-api --region asia-east1 --to-revisions=<上一個 revision>=100`（Web 同理）。migration 只會往前，回復程式前先確認 schema 相容。
- **看 log**：`gcloud run services logs read travelog-dev-api --region asia-east1 --limit 100`
- **連資料庫**：`gcloud sql connect travelog-dev --user=travelog --database=travelog`（密碼在 `travelog-dev-database-url` 秘密中）
- **MCP 連接器網址**：`https://api.<domain>/mcp`

## 注意事項

- 組織政策若禁止 `allUsers`（`iam.allowedPolicyMemberDomains`），Cloud Run 服務無法公開，需要調整政策或改用 Load Balancer。
- Cloud Run 單一請求最長 60 分鐘，SSE 連線到時會中斷，前端會自動重連。
- Cloud Run 網域對應只有部分區域支援（`asia-east1` 有支援）；換到不支援的區域時，改用外部 HTTPS Load Balancer（ARCHITECTURE §10）。
- `terraform destroy` 會刪除資料庫（dev 預設沒有刪除保護）與附件 bucket。

## Google Maps browser key rotation

Do not put the Maps key value in `cloudbuild.yaml` or other tracked files. Configure `_NEXT_PUBLIC_GOOGLE_MAPS_KEY` in the Cloud Build trigger/submission (or the existing GitHub Actions variable for that deployment path). The Cloud Build Web step rejects an empty value to avoid deploying a map without its configured key.

For GitHub secret-scanning alert #1 (introduced in commit `7945756`):

1. Identify the owning Google Cloud project and check API usage and restrictions. The alert currently reports validity as unknown; repository configuration alone cannot establish whether the key is active or restricted.
2. Create a replacement browser key with the required website referrers and Maps APIs restricted. Keep server-side Places credentials separate.
3. Update the build configuration, rebuild/deploy Web, and verify the map and Places workflows before revoking the old key. `NEXT_PUBLIC_*` is embedded at build time; changing only the running container environment does not replace it.
4. Revoke/delete the exposed key in its owning project, then check API-key administration audit logs and API usage/error/quota metrics from before the exposure through revocation. Google Maps API usage may not provide individual end-user request audit logs; do not treat absent audit logs as proof of no misuse.
5. Close the GitHub alert as **revoked** only after Google confirms revocation. Removing the current value from Git does not revoke it or remove historical commits.

This repository change removes the committed default only. It does not rotate/revoke the Google credential, change deployed builds, inspect cloud logs, or close the alert.
