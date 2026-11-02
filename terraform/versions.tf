terraform {
  required_version = ">= 1.6"

  # Partial config: terraform init -backend-config=bucket=<project>-tfstate
  backend "gcs" {
    prefix = "workload-clusters"
  }

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.0"
    }
    time = {
      source  = "hashicorp/time"
      version = "~> 0.12"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}
