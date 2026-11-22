locals {
  name       = "travelog-${var.env}"
  app_origin = "https://app.${var.domain}"
  api_origin = "https://api.${var.domain}"
  # Terraform 只建立服務骨架；實際映像檔由 GitHub Actions 部署
  placeholder_image = "us-docker.pkg.dev/cloudrun/container/hello"
  registry          = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.images.repository_id}"
}

resource "google_project_service" "apis" {
  for_each = toset([
    "artifactregistry.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "run.googleapis.com",
    "secretmanager.googleapis.com",
    "sqladmin.googleapis.com",
    "storage.googleapis.com",
    "sts.googleapis.com",
  ])
  service            = each.value
  disable_on_destroy = false
}

resource "google_artifact_registry_repository" "images" {
  repository_id = local.name
  location      = var.region
  format        = "DOCKER"
  description   = "Travelog ${var.env} 映像檔"

  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = 15
    }
  }
  cleanup_policies {
    id     = "delete-old"
    action = "DELETE"
    condition {
      older_than = "2592000s" # 30 天
    }
  }

  depends_on = [google_project_service.apis]
}
