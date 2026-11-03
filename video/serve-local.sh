#!/usr/bin/env bash
# fleet-scope on 127.0.0.1:18081 against the live fleet, for headless
# recording (IAP's sign-in can't be driven headlessly). Same code and data as
# the deployed console; a fixed dev identity stands in for IAP, and the
# buttons commit to the real fleet repo with the caller's gh login.
#
# Usage: serve-local.sh
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly CONSOLE_DIR="$SCRIPT_DIR/../console"
readonly ADDR="127.0.0.1:18081"
readonly IDENTITY="garisingh@google.com"
readonly BIN="/tmp/fleet-scope-video"
readonly TOKEN_FILE="/tmp/fleet-scope-video-gh-token"
readonly SLACK_TOKEN_FILE="$HOME/.kcna26/slack-bot-token"
readonly LINKS="Slack #platform-ops=https://kubeagentsdemo.slack.com/archives/C0CEZ07K39N,Fleet repo=https://github.com/gke-demos/kcna26-fleet-gitops,Online Boutique=http://35.253.85.127,Bank of Anthos=http://34.30.225.161"

gh auth token >"$TOKEN_FILE"
trap 'rm -f "$TOKEN_FILE"' EXIT
(cd "$CONSOLE_DIR" && go build -o "$BIN" ./cmd/fleet-scope)
export CLOUDSDK_ACTIVE_CONFIG_NAME="${CLOUDSDK_ACTIVE_CONFIG_NAME:-kcna26}"
export GOOGLE_CLOUD_QUOTA_PROJECT="${GOOGLE_CLOUD_QUOTA_PROJECT:-kcna-2026-demos}"
"$BIN" --addr="$ADDR" --dev-identity="$IDENTITY" --writers="$IDENTITY" \
  --github-token-file="$TOKEN_FILE" --slack-token-file="$SLACK_TOKEN_FILE" \
  --web-dir="$CONSOLE_DIR/web" --links="$LINKS"
