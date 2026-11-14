#!/usr/bin/env bash
# Check the demo's agent settings on the PlatformAgent:
#   INCIDENT_TRIAGE_OPEN_PULL_REQUEST=true  the triage opens its recommended fix
#     as a PR itself (no Slack click); a human still merges. Drift and
#     controller-stall reports still wait for a reply.
#   INCIDENT_WORKLOAD_DEDUP_SECONDS=900     a workload that breaks again within 15
#     minutes folds into its open incident (the chart's default is an hour).
#
# Since kube-agents 0.26 these are chart values, set by the TF_VAR_extra_helm_values
# line in install.env (install-hub.sh and install-staging.sh write it), and the
# chart replaces entries added to the PlatformAgent's env by hand. So this script
# only checks; to change a setting, edit that line and run scripts/upgrade.sh.
#
# Usage: tune-agent.sh   (HUB_CONTEXT selects the install; default kube-agents-hub)
set -euo pipefail

readonly CONTEXT="${HUB_CONTEXT:-kube-agents-hub}"
readonly NAMESPACE="kubeagents-system"
readonly PLATFORM_AGENT="platform-agent"
declare -A WANT=(
  [INCIDENT_TRIAGE_OPEN_PULL_REQUEST]="true"
  [INCIDENT_WORKLOAD_DEDUP_SECONDS]="900"
)

env_json="$(kubectl --context "$CONTEXT" -n "$NAMESPACE" get platformagent "$PLATFORM_AGENT" \
  -o json | jq -c '.spec.deployment.env // []')"
bad=0
for name in "${!WANT[@]}"; do
  have="$(jq -r --arg n "$name" '.[] | select(.name == $n) | .value' <<<"$env_json")"
  if [[ "$have" == "${WANT[$name]}" ]]; then
    echo "ok    $name=$have"
  else
    echo "FAIL  $name=${have:-<unset>} (want ${WANT[$name]}): set it in TF_VAR_extra_helm_values and run scripts/upgrade.sh"
    bad=1
  fi
done
exit "$bad"
