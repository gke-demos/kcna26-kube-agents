#!/usr/bin/env bash
# Install (or re-run the install of) kube-agents on kube-agents-hub, pinned to
# one release. Credentials and the generated install.env live in $CRED_DIR,
# outside every repo.
#
# Usage: install-hub.sh [--dry-run]
#   $CRED_DIR must hold app.pem (until KMS has imported it), slack-bot-token,
#   slack-app-token and install-<release>.sh (the release's own install.sh).
set -euo pipefail

readonly RELEASE="0.25.0"
readonly PROJECT="${PROJECT:-kcna-2026-demos}"
readonly CRED_DIR="${CRED_DIR:-$HOME/.kcna26}"
readonly HUB_CLUSTER="kube-agents-hub"
readonly REGION="us-central1"
# Gemini on Vertex AI through Workload Identity: no API key. Newer Gemini
# models are served from the global endpoint.
readonly VERTEX_LOCATION="global"
# The chart's Vertex default is gemini-3.5-flash; 3.8 Flash triaged faster in the
# 2026-11-07 rehearsals (bad image to healthy 3:31 against 4:21).
readonly MODEL="gemini-3.8-flash"
readonly FLEET_ORG="gke-demos"
readonly FLEET_REPO_NAME="kcna26-fleet-gitops"
readonly GITHUB_APP_ID="5579804"
readonly SLACK_HOME_CHANNEL="C0CEZ07K39N"
# Comma-separated Slack member IDs. Must match SLACK_ALLOWED_USERS in install.env.
readonly SLACK_ALLOWED_USERS="U0CDYBNMHV1"
readonly ALERT_CEILING=500

installer="$CRED_DIR/install-$RELEASE.sh"
[[ -f "$installer" ]] || {
  echo "missing $installer: gh api -H 'Accept: application/vnd.github.raw' \
'repos/gke-labs/kube-agents/contents/install.sh?ref=$RELEASE' > $installer" >&2
  exit 1
}

# The booth fires dozens of incidents a day; the default ceilings are 10/5.
install_env="$CRED_DIR/install.env"
touch "$install_env" && chmod 600 "$install_env"
for key in ALERT_DAILY_LIMIT_CRITICAL ALERT_DAILY_LIMIT_WARNING; do
  grep -q "^$key=" "$install_env" || echo "$key=$ALERT_CEILING" >>"$install_env"
done
# This script creates install.env before the installer's first run, and the
# installer writes its keys only into a new file, so --model-provider and
# --vertex-location are never recorded. upgrade.sh re-renders from install.env
# alone: without these a full upgrade plans to remove the Vertex AI gateway's
# identity.
grep -q "^MODEL_PROVIDER=" "$install_env" || echo "MODEL_PROVIDER=vertex_ai" >>"$install_env"
grep -q "^VERTEX_LOCATION=" "$install_env" || echo "VERTEX_LOCATION=$VERTEX_LOCATION" >>"$install_env"
grep -q "^MODEL_DEFAULT_NAME=" "$install_env" || echo "MODEL_DEFAULT_NAME=$MODEL" >>"$install_env"

pem_args=()
[[ -f "$CRED_DIR/app.pem" ]] && pem_args=(--github-pem-path="$CRED_DIR/app.pem")

cd "$HOME"
# The installer keeps its Terraform working directory in ./kube-agents; refuse one
# whose backend is another install's (install-staging.sh runs from its own directory).
override="kube-agents/terraform/examples/full-install/backend_override.tf"
if [[ -f "$override" ]] && ! grep -q "\"kube-agents/$HUB_CLUSTER\"" "$override"; then
  echo "refusing: ~/$override names another install's state:" >&2
  cat "$override" >&2
  exit 1
fi
CLOUDSDK_ACTIVE_CONFIG_NAME="${CLOUDSDK_ACTIVE_CONFIG_NAME:-kcna26}" \
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
  --enable-slack \
  --slack-bot-token="$(<"$CRED_DIR/slack-bot-token")" \
  --slack-app-token="$(<"$CRED_DIR/slack-app-token")" \
  --slack-home-channel="$SLACK_HOME_CHANNEL" \
  --slack-allowed-users="$SLACK_ALLOWED_USERS"
