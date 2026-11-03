# The 3D demo console (console/): its image registry, its read-only identity,
# and the address and certificate its Gateway serves. The Gateway, IAP and the
# workload itself are Kubernetes objects in console/deploy/.

variable "dns_project" {
  type        = string
  description = "Project holding the public zone the console's hostname lives in."
  default     = "gke-demos-345619"
}

variable "dns_zone" {
  type    = string
  default = "demo-gke-ninja"
}

variable "dns_domain" {
  type        = string
  description = "The zone's domain. The certificate is a wildcard under it, so other demos in this project can reuse it."
  default     = "demo.gke.ninja"
}

variable "console_host" {
  type    = string
  default = "kcna26.demo.gke.ninja"
}

variable "console_viewers" {
  type        = list(string)
  description = "IAP principals allowed to open the console (user:..., group:...). Who may press its buttons is the Deployment's SCOPE_WRITERS."
  default     = ["user:garisingh@google.com", "user:garisingh@gke.ninja"]
}

provider "google" {
  alias   = "dns"
  project = var.dns_project
}

locals {
  console_namespace = "fleet-scope"
  console_ksa       = "fleet-scope"
  console_apis = [
    "artifactregistry.googleapis.com",
    "certificatemanager.googleapis.com",
    "compute.googleapis.com",
    "iap.googleapis.com",
  ]
}

# Project-wide, so it covers the backend service the Gateway creates (whose
# name changes if the Gateway is re-created).
resource "google_project_iam_member" "console_viewers" {
  for_each   = toset(var.console_viewers)
  project    = var.project_id
  role       = "roles/iap.httpsResourceAccessor"
  member     = each.value
  depends_on = [google_project_service.console]
}

resource "google_project_service" "console" {
  for_each           = toset(local.console_apis)
  service            = each.value
  disable_on_destroy = false
}

resource "google_artifact_registry_repository" "console" {
  repository_id = "fleet-scope"
  location      = var.region
  format        = "DOCKER"
  depends_on    = [google_project_service.console]
}

# Reads every cluster in the project (Kubernetes objects included, through
# GKE's IAM integration) and nothing else.
resource "google_service_account" "console" {
  account_id   = "fleet-scope"
  display_name = "3D demo console (read-only)"
}

resource "google_project_iam_member" "console_viewer" {
  project = var.project_id
  role    = "roles/container.viewer"
  member  = "serviceAccount:${google_service_account.console.email}"
}

resource "google_service_account_iam_member" "console_wi" {
  service_account_id = google_service_account.console.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.project_id}.svc.id.goog[${local.console_namespace}/${local.console_ksa}]"
}

resource "google_compute_global_address" "console" {
  name       = "fleet-scope-ip"
  depends_on = [google_project_service.console]
}

# A per-project authorization, so it coexists with the zone project's own
# authorization of the same domain (_acme-challenge.<domain>).
resource "google_certificate_manager_dns_authorization" "console" {
  name       = "demo-gke-ninja"
  domain     = var.dns_domain
  type       = "PER_PROJECT_RECORD"
  depends_on = [google_project_service.console]
}

resource "google_dns_record_set" "console_authorization" {
  provider     = google.dns
  managed_zone = var.dns_zone
  name         = google_certificate_manager_dns_authorization.console.dns_resource_record[0].name
  type         = google_certificate_manager_dns_authorization.console.dns_resource_record[0].type
  ttl          = 300
  rrdatas      = [google_certificate_manager_dns_authorization.console.dns_resource_record[0].data]
}

resource "google_certificate_manager_certificate" "console" {
  name = "star-demo-gke-ninja"
  managed {
    domains            = ["*.${var.dns_domain}"]
    dns_authorizations = [google_certificate_manager_dns_authorization.console.id]
  }
}

resource "google_certificate_manager_certificate_map" "console" {
  name       = "fleet-scope"
  depends_on = [google_project_service.console]
}

resource "google_certificate_manager_certificate_map_entry" "console" {
  name         = "kcna26"
  map          = google_certificate_manager_certificate_map.console.name
  hostname     = var.console_host
  certificates = [google_certificate_manager_certificate.console.id]
}

resource "google_dns_record_set" "console" {
  provider     = google.dns
  managed_zone = var.dns_zone
  name         = "${var.console_host}."
  type         = "A"
  ttl          = 300
  rrdatas      = [google_compute_global_address.console.address]
}

output "console" {
  value = {
    url             = "https://${var.console_host}"
    ip              = google_compute_global_address.console.address
    image_repo      = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.console.repository_id}"
    gsa             = google_service_account.console.email
    certificate_map = google_certificate_manager_certificate_map.console.name
  }
}
