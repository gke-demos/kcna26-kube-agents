#!/usr/bin/env bash
# Verify a kube-agents install after an upgrade (UPGRADING.md, "Verify"). Prints
# one line per check, "ok" or "FAIL", plus advisory "note" lines, and exits
# non-zero if any check failed.
#
# Usage: verify-install.sh staging|prod RELEASE     e.g. verify-install.sh staging 0.33.0
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly NAMESPACE="kubeagents-system"
readonly AGENT_DEPLOYMENT="platform-agent-gateway"
readonly AGENT_CONTAINER="platform-agent"
readonly A2A_GATEWAY="platform-agent-a2a-gateway"
readonly OPERATOR="kube-agents-controller-manager"
readonly PROFILES_DIR="/opt/data/profiles"
readonly IMAGE_REPO_PREFIX="ghcr.io/gke-labs/kube-agents/"
readonly MODEL="gemini-3.8-flash"
# Conditions that are expected True; anything else True is reported as a note.
readonly HEALTHY_TRUE="Ready BusCredentialsReady BusProvisioned A2AIdentityMapApplied DispatcherCeiling DispatcherJobMode GatewayElected BusStreamsPresent"

target="${1:-}" release="${2:-}"
case "$target" in
  staging)
    ctx="kube-agents-stg"
    slack_user="kubeagentsstaging"
    profiles="cluster-gke-demos-345619-boutique-stg-us-central1-b cluster-gke-demos-345619-kube-agents-stg-us-central1"
    ;;
  prod)
    ctx="kube-agents-hub"
    slack_user="kubeagents"
    profiles="cluster-kcna-2026-demos-autoscale-arcade-us-central1 cluster-kcna-2026-demos-bank-prod-us-central1-b cluster-kcna-2026-demos-boutique-prod-us-central1-b cluster-kcna-2026-demos-kube-agents-hub-us-central1"
    ;;
  *)
    sed -n '2,7p' "$0"
    exit 2
    ;;
esac
[[ -n "$release" ]] || {
  echo "usage: verify-install.sh staging|prod RELEASE" >&2
  exit 2
}

failed=0
ok() { echo "ok    $*"; }
bad() {
  echo "FAIL  $*"
  failed=1
}
note() { echo "note  $*"; }
k() { kubectl --context "$ctx" -n "$NAMESPACE" "$@"; }

cr="$(k get platformagent platform-agent -o json 2>/dev/null)" || {
  bad "cannot read the PlatformAgent on $ctx"
  exit 1
}
observed="$(jq -r '.status.observedVersion // empty' <<<"$cr")"
[[ "$observed" == "$release" ]] && ok "observedVersion $observed" || bad "observedVersion ${observed:-<unset>}, want $release"
ready="$(jq -r '.status.conditions[]? | select(.type == "Ready") | .status' <<<"$cr")"
[[ "$ready" == "True" ]] && ok "Ready" || bad "Ready=${ready:-<unset>} (wait a minute after an apply, then re-run)"
while IFS=$'\t' read -r type status reason; do
  [[ -z "$type" ]] && continue
  if [[ " $HEALTHY_TRUE " == *" $type "* ]]; then
    [[ "$status" == "True" ]] || bad "condition $type=$status ($reason)"
  elif [[ "$status" == "True" ]]; then
    note "condition $type=True ($reason): read its message (kubectl get platformagent -o yaml)"
  fi
done < <(jq -r '.status.conditions[]? | [.type, .status, .reason] | @tsv' <<<"$cr")
note "bus servers: $(jq -r '.status.busReplicas // "?"' <<<"$cr")"

for d in "$OPERATOR" "$AGENT_DEPLOYMENT" "$A2A_GATEWAY"; do
  image="$(k get deploy "$d" -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null)"
  [[ "$image" == "$IMAGE_REPO_PREFIX"*":$release" ]] && ok "$d on $release" || bad "$d image ${image:-<missing>}"
done

if HUB_CONTEXT="$ctx" "$SCRIPT_DIR/tune-agent.sh" >/dev/null; then
  ok "agent settings (auto-PR, 15-minute fold-in)"
else
  bad "agent settings: run HUB_CONTEXT=$ctx scripts/tune-agent.sh"
fi

model="$(k get configmap litellm-config -o jsonpath='{.data.config\.yaml}' 2>/dev/null | grep -m1 -o 'vertex_ai/[a-z0-9.-]*')"
[[ "$model" == "vertex_ai/$MODEL" ]] && ok "model $model" || bad "model ${model:-<none>}, want vertex_ai/$MODEL"

# The A2A gateway runs two replicas with an elected leader; read every pod, since
# `logs deploy/…` picks one and it may be the standby.
slack_lines=""
for pod in $(k get pods -o name 2>/dev/null | grep "/$A2A_GATEWAY-"); do
  slack_lines+="$(k logs "$pod" -c gateway 2>/dev/null | grep '"slack connected"')"
done
if grep -q "\"user\":\"$slack_user\"" <<<"$slack_lines"; then
  ok "Slack connected as $slack_user"
else
  bad "no 'slack connected' as $slack_user in the A2A gateway's log"
fi

have="$(k exec "deploy/$AGENT_DEPLOYMENT" -c "$AGENT_CONTAINER" -- ls "$PROFILES_DIR" 2>/dev/null | grep '^cluster-' | sort | tr '\n' ' ')"
want="$(tr ' ' '\n' <<<"$profiles" | sort | tr '\n' ' ')"
if [[ "$have" == "$want" ]]; then
  ok "Cluster Agent profiles: $(wc -w <<<"$have")"
else
  bad "Cluster Agent profiles: have [${have% }], want [${want% }] (a new cluster in the project, or lost exclusions; the reconcile runs hourly)"
fi

stuck="$(k get pods --no-headers 2>/dev/null | awk '$3 != "Running" && $3 != "Completed" {print $1" "$3}')"
if [[ -z "$stuck" ]]; then
  ok "every pod Running or Completed"
else
  bad "pods not running: $(tr '\n' ';' <<<"$stuck") (a failed attempt of a Job that then Completed can be deleted)"
fi

exit "$failed"
