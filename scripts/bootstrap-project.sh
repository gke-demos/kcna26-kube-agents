#!/usr/bin/env bash
# One-time project prep before terraform/: enable the APIs the workload stack
# and lagging-version.sh need, and create the bucket terraform/ keeps state in.
# kube-agents' installer enables its own APIs.
#
# Usage: bootstrap-project.sh <project>
set -euo pipefail

readonly APIS=(container.googleapis.com gkehub.googleapis.com cloudresourcemanager.googleapis.com
  anthosconfigmanagement.googleapis.com storage.googleapis.com)
readonly STATE_LOCATION="us-central1"
readonly STATE_BUCKET_SUFFIX="-tfstate"

project="${1:?usage: bootstrap-project.sh <project>}"
bucket="gs://${project}${STATE_BUCKET_SUFFIX}"

gcloud services enable "${APIS[@]}" --project "$project"
if gcloud storage buckets describe "$bucket" --project "$project" >/dev/null 2>&1; then
  echo "$bucket exists"
else
  gcloud storage buckets create "$bucket" --project "$project" \
    --location "$STATE_LOCATION" --uniform-bucket-level-access
fi
gcloud storage buckets update "$bucket" --versioning
echo "state bucket: $bucket (terraform init -backend-config=bucket=${bucket#gs://})"
