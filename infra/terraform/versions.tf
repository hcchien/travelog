terraform {
  required_version = ">= 1.6"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
  }

  # 狀態存在 GCS：terraform init -backend-config="bucket=<狀態 bucket>" -backend-config="prefix=travelog/dev"
  backend "gcs" {}
}

provider "google" {
  project = var.project_id
  region  = var.region
}
