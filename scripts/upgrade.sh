#!/usr/bin/env bash
# Run a kube-agents release's upgrade.sh (full mode) against the KubeCon install or
# the staging install. Plan first, then apply:
#
#   scripts/upgrade.sh staging --plan     # exit 2 means changes; read them
#   scripts/upgrade.sh staging
#   scripts/upgrade.sh prod --plan
#   scripts/upgrade.sh prod
#
# RELEASE (default below) picks $CRED_DIR/upgrade-<RELEASE>.sh, fetched with:
#   gh api -H 'Accept: application/vnd.github.raw' \
#     'repos/gke-labs/kube-agents/contents/upgrade.sh?ref=<RELEASE>' > ~/.kcna26/upgrade-<RELEASE>.sh
# upgrade.sh re-renders the install from install.env alone, so everything set by
# hand must live there: MODEL_PROVIDER, VERTEX_LOCATION, MODEL_DEFAULT_NAME and the
# TF_VAR_extra_helm_values line (the agent's auto-PR and fold-in settings), and for
# staging SCOPE_EXCLUDE_CLUSTERS. A staging run whose cluster list may have changed
# should go through scripts/install-staging.sh, which rewrites the exclusions.
# Afterwards: archive the drift cards the apply raises, run scripts/preflight.sh.
set -euo pipefail

readonly DEFAULT_RELEASE="0.31.0"
readonly RELEASE="${RELEASE:-$DEFAULT_RELEASE}"
readonly KCNA_DIR="$HOME/.kcna26"
readonly REGION="us-central1"
readonly TF_DIR="kube-agents/terraform/examples/full-install"

target="${1:-}"
shift || true
case "$target" in
  prod)
    project="kcna-2026-demos"
    cluster="kube-agents-hub"
    cred_dir="$KCNA_DIR"
    work_dir="$HOME"
    gcloud_config="${CLOUDSDK_ACTIVE_CONFIG_NAME:-kcna26}"
    ;;
  staging)
    project="gke-demos-345619"
    cluster="kube-agents-stg"
    cred_dir="$KCNA_DIR/staging"
    work_dir="$HOME/kcna26-staging"
    gcloud_config="${CLOUDSDK_ACTIVE_CONFIG_NAME:-}"
    ;;
  *)
    sed -n '2,17p' "$0"
    exit 2
    ;;
esac

script="$KCNA_DIR/upgrade-$RELEASE.sh"
[[ -f "$script" ]] || {
  echo "missing $script (see the fetch command at the top of this script)" >&2
  exit 1
}
install_env="$cred_dir/install.env"
required=(MODEL_PROVIDER VERTEX_LOCATION MODEL_DEFAULT_NAME TF_VAR_extra_helm_values)
# Staging shares its project with other demos' clusters; without the exclusions
# the agent adopts every one of them (it did, 2026-11-07 to 11-14).
[[ "$target" == staging ]] && required+=(SCOPE_EXCLUDE_CLUSTERS)
for key in "${required[@]}"; do
  grep -q "^$key=" "$install_env" || {
    echo "refusing: $install_env has no $key; the upgrade would drop that setting" >&2
    exit 1
  }
done
# A checkout's backend_override.tf names one install's state; never run against
# another install's.
override="$work_dir/$TF_DIR/backend_override.tf"
if [[ -f "$override" ]] && ! grep -q "\"kube-agents/$cluster\"" "$override"; then
  echo "refusing: $override names another install's state" >&2
  exit 1
fi

cd "$work_dir"
env ${gcloud_config:+CLOUDSDK_ACTIVE_CONFIG_NAME="$gcloud_config"} \
  GOOGLE_CLOUD_QUOTA_PROJECT="$project" \
  KUBE_AGENTS_INSTALL_ENV="$install_env" \
  bash "$script" \
  --upgrade-mode=full \
  --non-interactive \
  --gcp-project-id="$project" \
  --gke-cluster-name="$cluster" \
  --gcp-region="$REGION" \
  "$@"
