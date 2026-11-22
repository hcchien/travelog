# ---- 由 Terraform 產生的秘密

resource "random_password" "cookie" {
  length  = 48
  special = false
}

resource "tls_private_key" "jwt" {
  algorithm   = "ECDSA"
  ecdsa_curve = "P256"
}

locals {
  generated_secrets = {
    "database-url"    = "postgres://${google_sql_user.app.name}:${random_password.db.result}@localhost/${google_sql_database.app.name}?host=/cloudsql/${google_sql_database_instance.main.connection_name}"
    "cookie-secret"   = random_password.cookie.result
    "jwt-private-key" = tls_private_key.jwt.private_key_pem_pkcs8
  }
  # 需要手動填入的秘密：先放 "unset"，之後用 gcloud secrets versions add 更新（Terraform 不會覆蓋）
  manual_secrets = ["google-client-secret", "resend-api-key", "maps-server-key"]
}

resource "google_secret_manager_secret" "generated" {
  for_each  = local.generated_secrets
  secret_id = "${local.name}-${each.key}"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "generated" {
  for_each    = local.generated_secrets
  secret      = google_secret_manager_secret.generated[each.key].id
  secret_data = each.value
}

resource "google_secret_manager_secret" "manual" {
  for_each  = toset(local.manual_secrets)
  secret_id = "${local.name}-${each.key}"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "manual_placeholder" {
  for_each    = toset(local.manual_secrets)
  secret      = google_secret_manager_secret.manual[each.key].id
  secret_data = "unset"
  lifecycle {
    ignore_changes = [secret_data]
  }
}

resource "google_secret_manager_secret_iam_member" "api_generated" {
  for_each  = google_secret_manager_secret.generated
  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.api.email}"
}

resource "google_secret_manager_secret_iam_member" "api_manual" {
  for_each  = google_secret_manager_secret.manual
  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.api.email}"
}
