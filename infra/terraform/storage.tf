# 附件（訂位憑證、票券）：不公開，讀寫一律走 API 簽發的短效 Signed URL（ARCHITECTURE §6.1）
resource "google_storage_bucket" "attachments" {
  name                        = "${var.project_id}-${local.name}-attachments"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = var.env != "prod"

  # 瀏覽器直接 PUT 到 Signed URL，需要允許 Web 的 origin
  cors {
    origin          = [local.app_origin]
    method          = ["PUT", "GET"]
    response_header = ["Content-Type", "x-goog-content-length-range"]
    max_age_seconds = 3600
  }

  depends_on = [google_project_service.apis]
}

resource "google_storage_bucket_iam_member" "api_objects" {
  bucket = google_storage_bucket.attachments.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.api.email}"
}
