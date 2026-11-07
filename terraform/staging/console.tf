# The staging fleet-scope on kube-agents-stg, reached by port-forward (no Gateway,
# certificate or DNS). It reads the GKE API as its own service account and pulls
# the image the KubeCon console uses from kcna-2026-demos.

locals {
  console_namespace = "fleet-scope"
  console_ksa       = "fleet-scope"
  image_project     = "kcna-2026-demos"
  image_repository  = "fleet-scope"
}

data "google_project" "this" {
  project_id = var.project_id
}

resource "google_service_account" "console" {
  account_id   = "kcna26-stg-fleet-scope"
  display_name = "fleet-scope (kcna26 staging console): reads the GKE API"
}

resource "google_project_iam_member" "console_viewer" {
  project = var.project_id
  role    = "roles/container.viewer"
  member  = "serviceAccount:${google_service_account.console.email}"
}

resource "google_service_account_iam_member" "console_workload_identity" {
  service_account_id = google_service_account.console.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.project_id}.svc.id.goog[${local.console_namespace}/${local.console_ksa}]"
}

# kube-agents-stg is Autopilot on the Compute Engine default service account.
resource "google_artifact_registry_repository_iam_member" "console_image_pull" {
  project    = local.image_project
  location   = var.region
  repository = local.image_repository
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${data.google_project.this.number}-compute@developer.gserviceaccount.com"
}

output "console_service_account" {
  description = "The staging console's Workload Identity service account (console/deploy/fleet-scope-staging.yaml)."
  value       = google_service_account.console.email
}
