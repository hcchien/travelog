variable "project_id" {
  description = "GCP 專案 ID"
  type        = string
}

variable "region" {
  description = "部署區域（Cloud Run、Cloud SQL、GCS 都在這裡）"
  type        = string
  default     = "asia-east1"
}

variable "env" {
  description = "環境名稱，用在資源名稱，例如 dev、staging、prod"
  type        = string
  default     = "dev"
}

variable "domain" {
  description = <<-EOT
    這個環境的根網域，例如 dev.travelog.app。
    Web 在 app.<domain>、API 在 api.<domain>：兩者必須同站（same-site），refresh token cookie（SameSite=Lax）才送得出去。
    也是 Passkey 的 RP ID，定了之後不要改。
  EOT
  type        = string
}

variable "create_domain_mappings" {
  description = "建立 Cloud Run 網域對應（需要先在 Search Console 驗證網域擁有權）"
  type        = bool
  default     = true
}

variable "github_repository" {
  description = "可以部署的 GitHub repo，例如 hcchien/travelog"
  type        = string
}

variable "deploy_branch" {
  description = "推到這個分支就部署"
  type        = string
  default     = "dev"
}

variable "db_tier" {
  description = "Cloud SQL 機型；dev 用最小的"
  type        = string
  default     = "db-f1-micro"
}

variable "deletion_protection" {
  description = "Cloud SQL 刪除保護（正式環境務必開啟）"
  type        = bool
  default     = false
}

variable "google_client_id" {
  description = "Google OAuth 網頁用戶端 ID（不是秘密）。secret 請另外放到 Secret Manager。"
  type        = string
  default     = ""
}

variable "google_native_client_ids" {
  description = "iOS／Android 原生 Google Sign-In 的 client ID，逗號分隔"
  type        = string
  default     = ""
}

variable "mail_from" {
  description = "寄件者（網域需先在 Resend 驗證）"
  type        = string
  default     = "Travelog <onboarding@resend.dev>"
}

variable "max_instances" {
  description = "每個 Cloud Run 服務的最大執行個體數"
  type        = number
  default     = 3
}
