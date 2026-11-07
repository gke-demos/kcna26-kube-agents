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
# It also turns on the web console (kube-agents' own browser workspace, read-only
# incident threads while Slack is on), to judge it beside fleet-scope:
#   kubectl --context <hub> port-forward -n kubeagents-system svc/kube-agents-web-console 8080:8080
#
# Usage: install-staging.sh [--dry-run]
#   $CRED_DIR must hold app.pem (until KMS has imported it), slack-bot-token,
#   slack-app-token and install-<release>.sh (the release's own install.sh).
set -euo pipefail

readonly RELEASE="0.25.0"
readonly PROJECT="gke-demos-345619"
readonly CRED_DIR="${CRED_DIR:-$HOME/.kcna26/staging}"
readonly HUB_CLUSTER="kube-agents-stg"
readonly WORKLOAD_CLUSTERS=("boutique-stg")
readonly REGION="us-central1"
readonly VERTEX_LOCATION="global"
readonly FLEET_ORG="gke-demos"
readonly FLEET_REPO_NAME="kcna26-fleet-gitops-staging"
readonly GITHUB_APP_ID="5579804"
readonly SLACK_HOME_CHANNEL="C0CFAPAV3HD"
readonly SLACK_ALLOWED_USERS="U0CDYBNMHV1"
readonly ALERT_CEILING=500
readonly NAME_PREFIX="kagents-stg"

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

pem_args=()
[[ -f "$CRED_DIR/app.pem" ]] && pem_args=(--github-pem-path="$CRED_DIR/app.pem")

cd "$HOME"
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
