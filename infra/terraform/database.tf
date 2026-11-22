resource "google_sql_database_instance" "main" {
  name                = local.name
  database_version    = "POSTGRES_16"
  region              = var.region
  deletion_protection = var.deletion_protection

  settings {
    tier              = var.db_tier
    edition           = "ENTERPRISE"
    availability_type = "ZONAL"
    disk_size         = 10
    disk_autoresize   = true

    backup_configuration {
      enabled    = true
      start_time = "19:00" # 台灣時間 03:00
      backup_retention_settings {
        retained_backups = 7
      }
    }

    ip_configuration {
      # 只透過 Cloud SQL connector（IAM 驗證）連線，不開放任何網段
      ipv4_enabled = true
      ssl_mode     = "ENCRYPTED_ONLY"
    }

    insights_config {
      query_insights_enabled = true
    }
  }

  depends_on = [google_project_service.apis]
}

resource "google_sql_database" "app" {
  name     = "travelog"
  instance = google_sql_database_instance.main.name
}

resource "random_password" "db" {
  length  = 32
  special = false
}

# 內建使用者屬於 cloudsqlsuperuser，migration 可以建立 postgis 等 extension
resource "google_sql_user" "app" {
  name     = "travelog"
  instance = google_sql_database_instance.main.name
  password = random_password.db.result
}
