# The demo's two workload clusters. kube-agents-hub is installed by kube-agents'
# own installer (../RUNBOOK.md); the compute demo cluster belongs to another demo
# and is only read by the agents.

locals {
  labels = { demo = "kcna26-kube-agents" }

  clusters = {
    boutique-prod = { machine_type = "e2-standard-4", node_count = 2, version = null }
    bank-prod     = { machine_type = "e2-standard-4", node_count = 2, version = var.bank_prod_master_version }
  }

  apis = [
    "container.googleapis.com",
    "gkehub.googleapis.com",
    "anthosconfigmanagement.googleapis.com",
    "cloudresourcemanager.googleapis.com",
  ]
}

resource "google_project_service" "apis" {
  for_each           = toset(local.apis)
  service            = each.value
  disable_on_destroy = false
}

resource "google_service_account" "nodes" {
  account_id   = "kcna26-workload-nodes"
  display_name = "Node identity for boutique-prod and bank-prod"
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

# Fixed at first apply so re-applies do not move the exclusion window.
resource "time_static" "exclusion_start" {}

resource "google_container_cluster" "workload" {
  for_each = local.clusters

  name                     = each.key
  location                 = var.zone
  remove_default_node_pool = true
  initial_node_count       = 1
  deletion_protection      = false
  resource_labels          = local.labels
  min_master_version       = each.value.version

  release_channel {
    channel = "REGULAR"
  }

  workload_identity_config {
    workload_pool = "${var.project_id}.svc.id.goog"
  }

  fleet {
    project = var.project_id
  }

  # bank-prod is held one minor behind its channel: the "is it safe to
  # upgrade?" question needs a cluster that is due an upgrade.
  dynamic "maintenance_policy" {
    for_each = each.value.version == null ? [] : [1]
    content {
      daily_maintenance_window {
        start_time = "08:00"
      }
      maintenance_exclusion {
        exclusion_name = "hold-minor"
        start_time     = time_static.exclusion_start.rfc3339
        end_time       = timeadd(time_static.exclusion_start.rfc3339, "${var.exclusion_days * 24}h")
        exclusion_options {
          scope = "NO_MINOR_UPGRADES"
        }
      }
    }
  }

  depends_on = [google_project_service.apis]
}

resource "google_container_node_pool" "default" {
  for_each = local.clusters

  name       = "default-pool"
  cluster    = google_container_cluster.workload[each.key].name
  location   = var.zone
  node_count = each.value.node_count
  version    = each.value.version

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
    # Patch upgrades inside the held minor are allowed; do not fight them.
    ignore_changes = [version]
  }
}

resource "google_gke_hub_feature" "configmanagement" {
  name       = "configmanagement"
  location   = "global"
  depends_on = [google_project_service.apis]
}

# Each cluster syncs clusters/<name>/ from the public fleet repo. A merged
# agent PR reaches the cluster within Config Sync's poll interval (15s default).
resource "google_gke_hub_feature_membership" "config_sync" {
  for_each = local.clusters

  location            = "global"
  feature             = google_gke_hub_feature.configmanagement.name
  membership          = google_container_cluster.workload[each.key].fleet[0].membership_id
  membership_location = google_container_cluster.workload[each.key].fleet[0].membership_location

  configmanagement {
    # New installs refuse MANAGEMENT_AUTOMATIC. Manual installs the current
    # version and holds it, which suits a frozen demo.
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
