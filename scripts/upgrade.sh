#!/usr/bin/env bash
# Run a kube-agents release's upgrade.sh (full mode) against the staging install or
# the KubeCon install. UPGRADING.md is the procedure; plan first, then apply:
#
#   scripts/upgrade.sh staging 0.33.0 --plan   # exit 2: changes to read; 1: the plan failed
#   scripts/upgrade.sh staging 0.33.0
#   scripts/upgrade.sh prod 0.33.0 --plan
#   scripts/upgrade.sh prod 0.33.0
#
# The release is required: the script runs ~/.kcna26/upgrade-<RELEASE>.sh, fetched with
#   gh api -H 'Accept: application/vnd.github.raw' \
#     'repos/gke-labs/kube-agents/contents/upgrade.sh?ref=<RELEASE>' > ~/.kcna26/upgrade-<RELEASE>.sh
# That engine re-renders the install from install.env alone, in a temporary clone of
# its release (the state backend comes from the project and cluster below, so read
# the plan's "state backend" line). Everything set by hand must live in install.env:
# MODEL_PROVIDER, VERTEX_LOCATION, MODEL_DEFAULT_NAME, SCOPE_PROJECTS,
# TF_VAR_extra_helm_values and, for staging, SCOPE_EXCLUDE_CLUSTERS, which must name
# every cluster in its project but staging's own (scripts/refresh-staging-scope.sh).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly KCNA_DIR="$HOME/.kcna26"
readonly REGION="us-central1"
# Both installs are administered by this account; prod also uses its own gcloud config.
readonly ACCOUNT="${KCNA_ACCOUNT:-garisingh@gke.ninja}"
readonly PROD_GCLOUD_CONFIG="kcna26"
readonly RELEASE_RE='^[0-9]+\.[0-9]+\.[0-9]+$'

target="${1:-}"
release="${2:-}"
case "$target" in
  prod)
    project="kcna-2026-demos"
    cluster="kube-agents-hub"
    cred_dir="$KCNA_DIR"
    gcloud_config="$PROD_GCLOUD_CONFIG"
    ;;
  staging)
    project="gke-demos-345619"
    cluster="kube-agents-stg"
    cred_dir="$KCNA_DIR/staging"
    gcloud_config=""
    ;;
  *)
    sed -n '2,18p' "$0"
    exit 2
    ;;
esac
[[ "$release" =~ $RELEASE_RE ]] || {
  echo "usage: upgrade.sh staging|prod <RELEASE, e.g. 0.33.0> [--plan]" >&2
  exit 2
}
shift 2

script="$KCNA_DIR/upgrade-$release.sh"
[[ -f "$script" ]] || {
  echo "missing $script (fetch it: see the top of this script)" >&2
  exit 1
}
grep -q "^BAKED_RELEASE_VERSION=\"$release\"" "$script" || {
  echo "refusing: $script is not release $release" >&2
  exit 1
}
install_env="$cred_dir/install.env"
required=(MODEL_PROVIDER VERTEX_LOCATION MODEL_DEFAULT_NAME TF_VAR_extra_helm_values SCOPE_PROJECTS)
# Staging shares its project with other demos' clusters; without the exclusions
# the agent adopts every one of them (it did, 2026-11-07 to 11-14).
[[ "$target" == staging ]] && required+=(SCOPE_EXCLUDE_CLUSTERS)
for key in "${required[@]}"; do
  grep -q "^$key=" "$install_env" || {
    echo "refusing: $install_env has no $key; the upgrade would drop that setting" >&2
    exit 1
  }
done
if [[ "$target" == staging ]]; then
  "$SCRIPT_DIR/refresh-staging-scope.sh" --check || {
    echo "refusing: staging's exclusions are out of date; run scripts/refresh-staging-scope.sh" >&2
    exit 1
  }
fi

env ${gcloud_config:+CLOUDSDK_ACTIVE_CONFIG_NAME="$gcloud_config"} \
  CLOUDSDK_CORE_ACCOUNT="$ACCOUNT" \
  GOOGLE_CLOUD_QUOTA_PROJECT="$project" \
  KUBE_AGENTS_INSTALL_ENV="$install_env" \
  bash "$script" \
  --upgrade-mode=full \
  --non-interactive \
  --gcp-project-id="$project" \
  --gke-cluster-name="$cluster" \
  --gcp-region="$REGION" \
  "$@"
