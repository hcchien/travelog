output "app_origin" {
  value = local.app_origin
}

output "api_origin" {
  value = local.api_origin
}

output "run_urls" {
  description = "Cloud Run 預設網址（自訂網域生效前可用來檢查服務是否啟動）"
  value = {
    api = google_cloud_run_v2_service.api.uri
    web = google_cloud_run_v2_service.web.uri
  }
}

output "dns_records" {
  description = "請在網域的 DNS 加上這些紀錄"
  value = var.create_domain_mappings ? {
    for m in [google_cloud_run_domain_mapping.app[0], google_cloud_run_domain_mapping.api[0]] :
    m.name => [for r in m.status[0].resource_records : "${r.type} ${r.rrdata}"]
  } : {}
}

output "google_oauth_redirect_uri" {
  description = "加到 Google OAuth 用戶端的「已授權的重新導向 URI」"
  value       = "${local.api_origin}/v1/auth/google/callback"
}

output "manual_secrets" {
  description = "需要手動填入的 Secret Manager 秘密"
  value       = [for s in google_secret_manager_secret.manual : s.secret_id]
}

output "github_variables" {
  description = "GitHub repo → Settings → Secrets and variables → Actions → Variables"
  value = {
    GCP_PROJECT_ID   = var.project_id
    GCP_REGION       = var.region
    GCP_WIF_PROVIDER = google_iam_workload_identity_pool_provider.github.name
    GCP_DEPLOYER_SA  = google_service_account.deployer.email
    GCP_REGISTRY     = local.registry
    SERVICE_PREFIX   = local.name
    APP_ORIGIN       = local.app_origin
    API_ORIGIN       = local.api_origin
  }
}
