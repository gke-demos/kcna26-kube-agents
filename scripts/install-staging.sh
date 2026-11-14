#!/usr/bin/env bash
# Install (or re-run the install of) the staging kube-agents on kube-agents-stg in the
# shared gke-demos project, where a new release is tried before kube-agents-hub moves
# to it. Credentials and the generated install.env live in $CRED_DIR, outside every
# repo.
#
# gke-demos already holds another kube-agents install (kube-agents-host) and other
# demos' clusters, so this install:
#   - names its own service accounts, KSA and key rings (the defaults are one fixed
#     name per project and belong to kube-agents-host; a shared database key ring
#     would have its key versions scheduled for destruction by a staging teardown);
#   - excludes every cluster in the project except its own two, listed when this
#     runs (a cluster created later is picked up by the hourly reconcile: re-run);
#   - turns the drift detector off (its log sink reads every cluster in the project).
#
# Accepted: the token minter's and LiteLLM's KSAs (kubeagents-system/
# kubeagents-github-minter, kubeagents-litellm) cannot be renamed, and
# kube-agents-host uses the same ones. Workload Identity ignores the cluster, so
# each install's minter could act as the other's minter service account. Staging
# is kept for upgrade testing; to retire it, destroy terraform/staging, then run
# the installer's uninstall.
#
# To try a new release: bump RELEASE, fetch its install.sh into $CRED_DIR, and use
# that release's upgrade.sh --upgrade-mode=full (--plan first) from $WORK_DIR's
# checkout moved to the release, with KUBE_AGENTS_INSTALL_ENV=$CRED_DIR/install.env.
#
# It also turns on the web console (kube-agents' own browser workspace, read-only
# incident threads while Slack is on), to judge it beside fleet-scope:
#   kubectl --context <hub> port-forward -n kubeagents-system svc/kube-agents-web-console 8080:8080
#
# Usage: install-staging.sh [--dry-run]
#   $CRED_DIR must hold app.pem (until KMS has imported it), slack-bot-token,
#   slack-app-token and install-<release>.sh (the release's own install.sh).
set -euo pipefail

readonly RELEASE="0.31.0"
readonly PROJECT="gke-demos-345619"
readonly CRED_DIR="${CRED_DIR:-$HOME/.kcna26/staging}"
readonly HUB_CLUSTER="kube-agents-stg"
readonly WORKLOAD_CLUSTERS=("boutique-stg")
readonly REGION="us-central1"
readonly VERTEX_LOCATION="global"
readonly MODEL="gemini-3.8-flash"
# The agent's auto-PR and fold-in settings, as chart values: since 0.26 the chart
# replaces entries added to the PlatformAgent's env by hand.
readonly EXTRA_HELM_VALUES='{platformAgent={deployment={env=[{name="INCIDENT_TRIAGE_OPEN_PULL_REQUEST",value="true"}],incidentWorkloadDedupSeconds=900}}}'
readonly FLEET_ORG="gke-demos"
readonly FLEET_REPO_NAME="kcna26-fleet-gitops-staging"
readonly GITHUB_APP_ID="5579804"
readonly SLACK_HOME_CHANNEL="C0CFAPAV3HD"
readonly SLACK_ALLOWED_USERS="U0CDYBNMHV1"
readonly ALERT_CEILING=500
readonly NAME_PREFIX="kagents-stg"
# The installer keeps its Terraform working directory (backend_override.tf,
# terraform.tfvars) in its kube-agents checkout: $HOME/kube-agents, unless it runs
# from inside a checkout. ~/kube-agents is install-hub.sh's, and sharing it planned
# the KubeCon install's state for replacement, so this install runs from its own.
readonly WORK_DIR="${WORK_DIR:-$HOME/kcna26-staging}"
readonly CHECKOUT="$WORK_DIR/kube-agents"
readonly REPO_URL="https://github.com/gke-labs/kube-agents.git"
readonly TF_DIR="terraform/examples/full-install"
readonly STATE_PREFIX="kube-agents/$HUB_CLUSTER"

installer="$CRED_DIR/install-$RELEASE.sh"
[[ -f "$installer" ]] || {
  echo "missing $installer: gh api -H 'Accept: application/vnd.github.raw' \
'repos/gke-labs/kube-agents/contents/install.sh?ref=$RELEASE' > $installer" >&2
  exit 1
}

# Every cluster in the project but ours, as project/location/cluster.
ours=" $HUB_CLUSTER ${WORKLOAD_CLUSTERS[*]} "
exclude=()
while read -r name location; do
  [[ "$ours" == *" $name "* ]] || exclude+=("$PROJECT/$location/$name")
done < <(gcloud container clusters list --project "$PROJECT" --format="value(name,location)")
exclude_csv="$(
  IFS=,
  echo "${exclude[*]}"
)"
echo "excluding ${#exclude[@]} clusters that are not staging's"

install_env="$CRED_DIR/install.env"
touch "$install_env" && chmod 600 "$install_env"
set_once() { grep -q "^$1=" "$install_env" || echo "$1=$2" >>"$install_env"; }
set_once ALERT_DAILY_LIMIT_CRITICAL "$ALERT_CEILING"
set_once ALERT_DAILY_LIMIT_WARNING "$ALERT_CEILING"
set_once PLATFORM_AGENT_GSA_NAME "$NAME_PREFIX-platform"
set_once GITHUB_MINTER_GSA_NAME "$NAME_PREFIX-minter"
set_once LITELLM_GSA_NAME "$NAME_PREFIX-litellm"
set_once GKE_DB_KMS_KEYRING "$NAME_PREFIX-keyring"
set_once KMS_KEYRING "$NAME_PREFIX-minter-keyring"
set_once TF_VAR_agent_ksa_name "$NAME_PREFIX-platform-agent"
set_once ENABLE_DRIFT_DETECTOR false
# The installer records flags only into an install.env it creates, and this
# script creates it first; upgrade.sh re-renders from install.env alone.
set_once MODEL_PROVIDER vertex_ai
set_once VERTEX_LOCATION "$VERTEX_LOCATION"
set_once MODEL_DEFAULT_NAME "$MODEL"
# Single-quoted: install.env is read as shell, and the HCL carries double quotes.
set_once TF_VAR_extra_helm_values "'$EXTRA_HELM_VALUES'"
# The exclusions change as other demos add clusters, so this one is rewritten on
# every run. Passed only as a flag, it was lost on the first upgrade.sh run
# (2026-11-07), and the agent covered every cluster in the project for a week.
grep -v "^SCOPE_EXCLUDE_CLUSTERS=" "$install_env" >"$install_env.tmp" || true
echo "SCOPE_EXCLUDE_CLUSTERS=$exclude_csv" >>"$install_env.tmp"
mv "$install_env.tmp" "$install_env"
chmod 600 "$install_env"

pem_args=()
[[ -f "$CRED_DIR/app.pem" ]] && pem_args=(--github-pem-path="$CRED_DIR/app.pem")

if [[ ! -d "$CHECKOUT/.git" ]]; then
  mkdir -p "$WORK_DIR"
  git clone -q --filter=blob:none --branch "$RELEASE" "$REPO_URL" "$CHECKOUT"
fi
cd "$CHECKOUT"
[[ "$(git describe --tags --exact-match 2>/dev/null)" == "$RELEASE" ]] ||
  git -c advice.detachedHead=false checkout -q "$RELEASE"
override="$TF_DIR/backend_override.tf"
if [[ -f "$override" ]] && ! grep -q "\"$STATE_PREFIX\"" "$override"; then
  echo "refusing: $CHECKOUT/$override names another install's state:" >&2
  cat "$override" >&2
  exit 1
fi
GOOGLE_CLOUD_QUOTA_PROJECT="$PROJECT" \
  KUBE_AGENTS_INSTALL_ENV="$install_env" \
  bash "$installer" "$@" \
  --non-interactive \
  --mode=next \
  --gcp-project-id="$PROJECT" \
  --gke-cluster-name="$HUB_CLUSTER" \
  --gcp-region="$REGION" \
  --model-provider=vertex_ai \
  --vertex-location="$VERTEX_LOCATION" \
  --permission-set=read-only \
  --gitops-org="$FLEET_ORG" \
  --gitops-repo="$FLEET_REPO_NAME" \
  --github-app-id="$GITHUB_APP_ID" \
  "${pem_args[@]}" \
  --scope-exclude-clusters="$exclude_csv" \
  --enable-web-console \
  --enable-slack \
  --slack-bot-token="$(<"$CRED_DIR/slack-bot-token")" \
  --slack-app-token="$(<"$CRED_DIR/slack-app-token")" \
  --slack-home-channel="$SLACK_HOME_CHANNEL" \
  --slack-allowed-users="$SLACK_ALLOWED_USERS"
