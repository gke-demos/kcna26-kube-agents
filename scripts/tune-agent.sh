#!/usr/bin/env bash
# Demo settings on the PlatformAgent that the installer has no flag for:
#   INCIDENT_TRIAGE_OPEN_PULL_REQUEST=true  the triage opens its recommended fix
#     as a PR itself (no Slack click); a human still merges. Drift and
#     controller-stall reports still wait for a reply.
#   INCIDENT_WORKLOAD_DEDUP_SECONDS         a workload that breaks again while
#     its fix PR is open gets a reminder, not a new triage.
# The installer renders spec.deployment.env from install.env, so re-run this
# after any install-hub.sh run. The operator restarts the agent pod.
#
# Usage: tune-agent.sh
set -euo pipefail

readonly CONTEXT="${HUB_CONTEXT:-kube-agents-hub}"
readonly NAMESPACE="kubeagents-system"
readonly PLATFORM_AGENT="platform-agent"
readonly AGENT_DEPLOYMENT="platform-agent-gateway"
readonly DEDUP_SECONDS="900"
readonly ROLLOUT_TIMEOUT="900s"
declare -A SETTINGS=(
  [INCIDENT_TRIAGE_OPEN_PULL_REQUEST]="true"
  [INCIDENT_WORKLOAD_DEDUP_SECONDS]="$DEDUP_SECONDS"
)

current="$(kubectl --context "$CONTEXT" -n "$NAMESPACE" get platformagent "$PLATFORM_AGENT" \
  -o json | jq -c '.spec.deployment.env // []')"
next="$current"
for name in "${!SETTINGS[@]}"; do
  next="$(jq -c --arg n "$name" --arg v "${SETTINGS[$name]}" \
    'map(select(.name != $n)) + [{name: $n, value: $v}]' <<<"$next")"
done
if [[ "$(jq -S . <<<"$current")" == "$(jq -S . <<<"$next")" ]]; then
  echo "already set"
  exit 0
fi
kubectl --context "$CONTEXT" -n "$NAMESPACE" patch platformagent "$PLATFORM_AGENT" --type merge \
  -p "$(jq -c '{spec: {deployment: {env: .}}}' <<<"$next")"
echo "waiting for the operator to roll the agent pod..."
sleep 5
kubectl --context "$CONTEXT" -n "$NAMESPACE" rollout status deploy/"$AGENT_DEPLOYMENT" --timeout="$ROLLOUT_TIMEOUT"
