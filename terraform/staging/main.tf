# The staging workload cluster: one Online Boutique cluster in gke-demos-345619 for
# the staging kube-agents install (kube-agents-stg, installed by
# ../../scripts/install-staging.sh). gke-demos is shared with other demos, so this root
# creates only its own resources: it references the fleet's configmanagement feature
# rather than managing it (a destroy here must never turn Config Sync off for the
# fleet), and leaves out the console, DNS and certificate resources in ../console.tf.

locals {
  labels = { demo = "kcna26-kube-agents", stage = "staging" }

  clusters = {
    boutique-stg = { machine_type = "e2-standard-4", node_count = 2 }
  }
}

resource "google_service_account" "nodes" {
  account_id   = "kcna26-stg-nodes"
  display_name = "Node identity for the kcna26 staging workload cluster"
}

resource "google_project_iam_member" "nodes" {
  for_each = toset([
    "roles/logging.logWriter",
    "roles/monitoring.metricWriter",
    "roles/monitoring.viewer",
    "roles/artifactregistry.reader",
  ])
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.nodes.email}"
}

resource "google_container_cluster" "workload" {
  for_each = local.clusters

  name                     = each.key
  location                 = var.zone
  remove_default_node_pool = true
  initial_node_count       = 1
  deletion_protection      = false
  resource_labels          = local.labels

  release_channel {
    channel = "REGULAR"
  }

  workload_identity_config {
    workload_pool = "${var.project_id}.svc.id.goog"
  }

  fleet {
    project = var.project_id
  }
}

resource "google_container_node_pool" "default" {
  for_each = local.clusters

  name       = "default-pool"
  cluster    = google_container_cluster.workload[each.key].name
  location   = var.zone
  node_count = each.value.node_count

  node_config {
    machine_type    = each.value.machine_type
    service_account = google_service_account.nodes.email
    oauth_scopes    = ["https://www.googleapis.com/auth/cloud-platform"]
    resource_labels = local.labels

    workload_metadata_config {
      mode = "GKE_METADATA"
    }
  }

  lifecycle {
    ignore_changes = [version]
  }
}

# Each cluster syncs clusters/<name>/ from the staging fleet repo. The membership
# config overrides the fleet's default member config for this cluster only.
resource "google_gke_hub_feature_membership" "config_sync" {
  for_each = local.clusters

  location            = "global"
  feature             = "configmanagement"
  membership          = google_container_cluster.workload[each.key].fleet[0].membership_id
  membership_location = google_container_cluster.workload[each.key].fleet[0].membership_location

  configmanagement {
    management = "MANAGEMENT_MANUAL"
    config_sync {
      enabled       = true
      source_format = "unstructured"
      git {
        sync_repo   = var.fleet_repo_url
        sync_branch = var.fleet_repo_branch
        policy_dir  = "clusters/${each.key}"
        secret_type = "none"
      }
    }
  }

  depends_on = [google_container_node_pool.default]
}
