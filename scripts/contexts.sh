#!/usr/bin/env bash
# Fetch credentials for the demo's clusters and name each kubeconfig context
# after its cluster, which is what preflight.sh and the RUNBOOK use.
#
# Usage: contexts.sh <project>
set -euo pipefail

readonly HUB_CLUSTER="kube-agents-hub"
readonly HUB_REGION="us-central1"
readonly WORKLOAD_ZONE="us-central1-a"
readonly WORKLOAD_CLUSTERS=(boutique-prod bank-prod)

project="${1:?usage: contexts.sh <project>}"

add_context() {
  local name="$1" location_flag="$2" location="$3"
  gcloud container clusters get-credentials "$name" "$location_flag" "$location" --project "$project"
  kubectl config delete-context "$name" >/dev/null 2>&1 || true
  kubectl config rename-context "gke_${project}_${location}_${name}" "$name"
}

add_context "$HUB_CLUSTER" --region "$HUB_REGION"
for c in "${WORKLOAD_CLUSTERS[@]}"; do
  add_context "$c" --zone "$WORKLOAD_ZONE"
done
