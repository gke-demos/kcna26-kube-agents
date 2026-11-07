terraform {
  required_version = ">= 1.6"

  # The kube-agents installer's state bucket in gke-demos, under this root's own
  # prefix: terraform init -backend-config=bucket=gke-demos-345619-kube-agents-tfstate
  backend "gcs" {
    prefix = "kcna26-staging/workload-clusters"
  }

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}
