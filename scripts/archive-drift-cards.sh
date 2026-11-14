#!/usr/bin/env bash
# Archive every open drift triage card ("Triage out-of-band change …") on an
# install's Platform Agent board. An upgrade's Helm apply and a console deploy
# run under a person's account, so the drift detector files a triage card for
# each object they touch, and those cards hold the worker slots an incident needs.
# Other cards are left alone.
#
# Usage: archive-drift-cards.sh [CONTEXT]   (default kube-agents-hub)
set -euo pipefail

readonly NAMESPACE="kubeagents-system"
readonly DEPLOYMENT="platform-agent-gateway"
readonly CONTAINER="platform-agent"
readonly HERMES_HOME_DIR="/opt/data/profiles/platform"
readonly DRIFT_TITLE="Triage out-of-band change"
readonly DEFAULT_CONTEXT="kube-agents-hub"

ctx="${1:-$DEFAULT_CONTEXT}"
board() {
  kubectl --context "$ctx" -n "$NAMESPACE" exec "deploy/$DEPLOYMENT" -c "$CONTAINER" -- \
    env HERMES_HOME="$HERMES_HOME_DIR" hermes kanban "$@"
}
mapfile -t cards < <(board list 2>/dev/null | grep -v -E '\bdone\b' | grep -F "$DRIFT_TITLE" | grep -o -E '\bt_[0-9a-f]+\b' || true)
echo "archiving ${#cards[@]} drift cards on $ctx"
for card in "${cards[@]}"; do
  board archive "$card"
done
