# Dedicated scheduled job works even when the API is idle or scaled to zero.
resource "google_cloud_run_v2_job" "maintenance" {
  name                = "${local.name}-maintenance"
  location            = var.region
  deletion_protection = false
  template {
    task_count = 1
    template {
      service_account = google_service_account.api.email
      max_retries     = 2
      timeout         = "600s"
      volumes {
        name = "cloudsql"
        cloud_sql_instance {
          instances = [google_sql_database_instance.main.connection_name]
        }
      }
      containers {
        image   = local.placeholder_image
        command = ["node", "dist/maintain.js"]
        env {
          name = "DATABASE_URL"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.generated["database-url"].secret_id
              version = "latest"
            }
          }
        }
        env {
          name  = "GCS_BUCKET"
          value = google_storage_bucket.attachments.name
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
  depends_on = [google_secret_manager_secret_iam_member.api_generated, google_project_iam_member.api_sql]
}

resource "google_service_account" "scheduler" {
  account_id   = "${local.name}-cleanup"
  display_name = "Travelog cleanup scheduler"
}
resource "google_cloud_run_v2_job_iam_member" "maintenance_invoker" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_job.maintenance.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler.email}"
}
resource "google_cloud_scheduler_job" "maintenance" {
  name      = "${local.name}-maintenance"
  region    = var.region
  schedule  = "*/10 * * * *"
  time_zone = "Etc/UTC"
  http_target {
    uri         = "https://run.googleapis.com/v2/projects/${var.project_id}/locations/${var.region}/jobs/${google_cloud_run_v2_job.maintenance.name}:run"
    http_method = "POST"
    oauth_token {
      service_account_email = google_service_account.scheduler.email
    }
  }
  depends_on = [google_project_service.apis, google_cloud_run_v2_job_iam_member.maintenance_invoker]
}
