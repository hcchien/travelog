# ---- 執行身分

resource "google_service_account" "api" {
  account_id   = "${local.name}-api"
  display_name = "Travelog ${var.env} API"
}

resource "google_service_account" "web" {
  account_id   = "${local.name}-web"
  display_name = "Travelog ${var.env} Web"
}

resource "google_project_iam_member" "api_sql" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.api.email}"
}

# Cloud Run 上沒有私鑰：簽 V4 Signed URL 要透過 IAM signBlob 簽自己
resource "google_service_account_iam_member" "api_sign_self" {
  service_account_id = google_service_account.api.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${google_service_account.api.email}"
}

# ---- GitHub Actions 部署（Workload Identity Federation，不用金鑰檔）

resource "google_service_account" "deployer" {
  account_id   = "${local.name}-deployer"
  display_name = "Travelog ${var.env} GitHub Actions 部署"
}

resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "${local.name}-github"
  display_name              = "GitHub Actions (${var.env})"
  depends_on                = [google_project_service.apis]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  display_name                       = "GitHub"
  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
  }
  # 只有指定 repo 的部署分支能換到權杖
  attribute_condition = "assertion.repository == '${var.github_repository}' && assertion.ref == 'refs/heads/${var.deploy_branch}'"
  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account_iam_member" "deployer_wif" {
  service_account_id = google_service_account.deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_repository}"
}

resource "google_artifact_registry_repository_iam_member" "deployer_push" {
  repository = google_artifact_registry_repository.images.name
  location   = var.region
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.deployer.email}"
}

# 部署新版服務與執行 migration job
resource "google_project_iam_member" "deployer_run" {
  project = var.project_id
  role    = "roles/run.developer"
  member  = "serviceAccount:${google_service_account.deployer.email}"
}

# 部署時以 api／web 的身分執行
resource "google_service_account_iam_member" "deployer_act_as" {
  for_each           = { api = google_service_account.api.name, web = google_service_account.web.name, migration = google_service_account.migration.name }
  service_account_id = each.value
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.deployer.email}"
}

resource "google_service_account" "migration" {
  account_id   = "${local.name}-migrate"
  display_name = "Travelog ${var.env} migration"
}

resource "google_project_iam_member" "migration_sql" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.migration.email}"
}
