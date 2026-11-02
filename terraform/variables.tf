variable "project_id" {
  type        = string
  description = "The demo project. kube-agents-hub (installed separately) and the compute demo cluster live here too."
}

variable "region" {
  type    = string
  default = "us-central1"
}

variable "zone" {
  type    = string
  default = "us-central1-b"
}

variable "bank_prod_master_version" {
  type        = string
  description = "A REGULAR-channel version one minor behind REGULAR's default. Print it with ../scripts/lagging-version.sh; bank-prod is created at it and held there by a NO_MINOR_UPGRADES exclusion."
}

variable "fleet_repo_url" {
  type    = string
  default = "https://github.com/gke-demos/kcna26-fleet-gitops"
}

variable "fleet_repo_branch" {
  type    = string
  default = "main"
}

variable "exclusion_days" {
  type        = number
  description = "How long bank-prod's minor-upgrade exclusion lasts from the first apply. Must end before the held minor's end of life."
  default     = 45
}
