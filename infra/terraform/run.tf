locals {
  api_secret_env = {
    DATABASE_URL           = google_secret_manager_secret.generated["database-url"].secret_id
    COOKIE_SECRET          = google_secret_manager_secret.generated["cookie-secret"].secret_id
    JWT_PRIVATE_KEY        = google_secret_manager_secret.generated["jwt-private-key"].secret_id
    GOOGLE_CLIENT_SECRET   = google_secret_manager_secret.manual["google-client-secret"].secret_id
    RESEND_API_KEY         = google_secret_manager_secret.manual["resend-api-key"].secret_id
    GOOGLE_MAPS_SERVER_KEY = google_secret_manager_secret.manual["maps-server-key"].secret_id
  }
  api_env = {
    NODE_ENV                 = "production"
    APP_ORIGIN               = local.app_origin
    API_ORIGIN               = local.api_origin
    WEBAUTHN_RP_ID           = var.domain
    GOOGLE_CLIENT_ID         = var.google_client_id != "" ? var.google_client_id : "unset"
    GOOGLE_NATIVE_CLIENT_IDS = var.google_native_client_ids
    STORAGE_DRIVER           = "gcs"
    GCS_BUCKET               = google_storage_bucket.attachments.name
    MAIL_FROM                = var.mail_from
  }
}

resource "google_cloud_run_v2_service" "api" {
  name                = "${local.name}-api"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false

  template {
    service_account = google_service_account.api.email
    # SSE（即時同步）是長連線：Cloud Run 單一請求最長 60 分鐘，前端會自動重連
    timeout                          = "3600s"
    max_instance_request_concurrency = 80

    scaling {
      min_instance_count = 0
      max_instance_count = var.max_instances
    }

    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [google_sql_database_instance.main.connection_name]
      }
    }

    containers {
      image = local.placeholder_image
      ports {
        container_port = 8080
      }
      resources {
        limits = { cpu = "1", memory = "512Mi" }
      }
      dynamic "env" {
        for_each = local.api_env
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.api_secret_env
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }
      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }
      startup_probe {
        http_get {
          path = "/healthz"
        }
        initial_delay_seconds = 0
        period_seconds        = 3
        failure_threshold     = 20
      }
    }
  }

  lifecycle {
    # 映像檔由 GitHub Actions 部署
    ignore_changes = [template[0].containers[0].image, client, client_version]
  }

  depends_on = [
    google_secret_manager_secret_version.generated,
    google_secret_manager_secret_version.manual_placeholder,
    google_secret_manager_secret_iam_member.api_generated,
    google_secret_manager_secret_iam_member.api_manual,
    google_project_iam_member.api_sql,
  ]
}

resource "google_cloud_run_v2_service" "web" {
  name                = "${local.name}-web"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false

  template {
    service_account = google_service_account.web.email
    scaling {
      min_instance_count = 0
      max_instance_count = var.max_instances
    }
    containers {
      image = local.placeholder_image
      ports {
        container_port = 8080
      }
      resources {
        limits = { cpu = "1", memory = "512Mi" }
      }
      env {
        name  = "APP_ORIGIN"
        value = local.app_origin
      }
      env {
        name  = "API_ORIGIN"
        value = local.api_origin
      }
      # 公開遊記頁在伺服器端呼叫 API：直接走 run.app 網址，不繞自訂網域
      env {
        name  = "API_INTERNAL_ORIGIN"
        value = google_cloud_run_v2_service.api.uri
      }
    }
  }

  lifecycle {
    ignore_changes = [template[0].containers[0].image, client, client_version]
  }
}

# 資料庫 migration：與 API 同一個映像檔，部署時先執行
resource "google_cloud_run_v2_job" "migrate" {
  name                = "${local.name}-migrate"
  location            = var.region
  deletion_protection = false

  template {
    task_count = 1
    template {
      service_account = google_service_account.migration.email
      max_retries     = 0
      timeout         = "600s"
      volumes {
        name = "cloudsql"
        cloud_sql_instance {
          instances = [google_sql_database_instance.main.connection_name]
        }
      }
      containers {
        image   = local.placeholder_image
        command = ["node", "dist/migrate.js"]
        env {
          name = "DATABASE_URL"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.generated["migration-database-url"].secret_id
              version = "latest"
            }
          }
        }
        env {
          name = "RUNTIME_DATABASE_URL"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.generated["database-url"].secret_id
              version = "latest"
            }
          }
        }
        volume_mounts {
          name       = "cloudsql"
          mount_path = "/cloudsql"
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [template[0].template[0].containers[0].image, client, client_version]
  }

  depends_on = [
    google_secret_manager_secret_version.generated,
    google_secret_manager_secret_version.manual_placeholder,
    google_secret_manager_secret_iam_member.migration_database,
    google_project_iam_member.migration_sql,
  ]
}

# 公開服務（登入與權限由 API 自己處理）
resource "google_cloud_run_v2_service_iam_member" "public" {
  for_each = { api = google_cloud_run_v2_service.api.name, web = google_cloud_run_v2_service.web.name }
  name     = each.value
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# ---- 自訂網域：app.<domain> → web、api.<domain> → api

resource "google_cloud_run_domain_mapping" "app" {
  count    = var.create_domain_mappings ? 1 : 0
  name     = "app.${var.domain}"
  location = var.region
  metadata {
    namespace = var.project_id
  }
  spec {
    route_name = google_cloud_run_v2_service.web.name
  }
}

resource "google_cloud_run_domain_mapping" "api" {
  count    = var.create_domain_mappings ? 1 : 0
  name     = "api.${var.domain}"
  location = var.region
  metadata {
    namespace = var.project_id
  }
  spec {
    route_name = google_cloud_run_v2_service.api.name
  }
}
