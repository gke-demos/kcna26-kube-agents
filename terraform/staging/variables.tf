variable "project_id" {
  type        = string
  description = "The shared project the staging install lives in."
  default     = "gke-demos-345619"
}

variable "region" {
  type    = string
  default = "us-central1"
}

variable "zone" {
  type    = string
  default = "us-central1-b"
}

variable "fleet_repo_url" {
  type    = string
  default = "https://github.com/gke-demos/kcna26-fleet-gitops-staging"
}

variable "fleet_repo_branch" {
  type    = string
  default = "main"
}
