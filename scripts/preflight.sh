#!/usr/bin/env bash
# Pre-talk / pre-shift check. Prints one line per check and exits non-zero if
# any failed. Needs the contexts contexts.sh creates.
#
# Usage: preflight.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

readonly HUB_CONTEXT="kube-agents-hub"
readonly AGENT_NAMESPACE="kubeagents-system"
readonly AGENT_DEPLOYMENT="platform-agent-gateway"
readonly AGENT_CONTAINER="platform-agent"
readonly PLATFORM_HERMES_HOME="/opt/data/profiles/platform"
readonly ROOTSYNC_NAMESPACE="config-management-system"
readonly ROOTSYNC_NAME="root-sync"
readonly AUDIT_LABEL="agent:audit"
# The audit card on screen should be from last night.
readonly AUDIT_MAX_AGE_HOURS=24
readonly SECONDS_PER_HOUR=3600
declare -A APP_NAMESPACE=([boutique-prod]=online-boutique [bank-prod]=bank-of-anthos)

failures=0
ok() { echo "  ok    $*"; }
bad() {
  echo "  FAIL  $*"
  failures=$((failures + 1))
}

not_ready_pods() {
  kubectl --context "$1" get pods -n "$2" --no-headers 2>/dev/null |
    awk '{split($2, r, "/"); if (r[1] != r[2] && $3 != "Completed") print $1}'
}

echo "fleet repo ($FLEET_REPO)"
head_sha="$(gh api "repos/$FLEET_REPO/commits/$FLEET_BRANCH" --jq .sha 2>/dev/null)"
[[ -n "$head_sha" ]] && ok "$FLEET_BRANCH at ${head_sha:0:7}" || bad "cannot read $FLEET_BRANCH"
changed="$(gh api "repos/$FLEET_REPO/compare/$BASELINE_TAG...$FLEET_BRANCH" \
  --jq '[.files[].filename | select(startswith("clusters/"))] | length' 2>/dev/null)"
[[ "$changed" == "0" ]] && ok "clusters/ matches $BASELINE_TAG" ||
  bad "clusters/ differs from $BASELINE_TAG in ${changed:-?} files: run reset.sh"
incident_prs="$(gh pr list -R "$FLEET_REPO" --state open --json headRefName \
  --jq "[.[] | select(.headRefName | startswith(\"$AUDIT_PR_PREFIX\") | not)] | length")"
[[ "$incident_prs" == "0" ]] && ok "no open incident PRs" || bad "$incident_prs incident PRs open: run reset.sh"
audit_prs="$(gh pr list -R "$FLEET_REPO" --state open --json headRefName \
  --jq "[.[] | select(.headRefName | startswith(\"$AUDIT_PR_PREFIX\"))] | length")"
[[ "$audit_prs" -gt 0 ]] && ok "$audit_prs audit fix PRs open" || bad "no audit fix PRs open: run the audits"
newest_audit="$(gh issue list -R "$FLEET_REPO" --label "$AUDIT_LABEL" --state all --json updatedAt \
  --jq 'map(.updatedAt) | max // empty')"
if [[ -z "$newest_audit" ]]; then
  bad "no audit issues: run the audits"
else
  age_hours=$((($(date +%s) - $(date -d "$newest_audit" +%s)) / SECONDS_PER_HOUR))
  ((age_hours <= AUDIT_MAX_AGE_HOURS)) && ok "newest audit issue updated ${age_hours}h ago" ||
    bad "newest audit issue is ${age_hours}h old: re-run the audits"
fi

for cluster in "${!APP_NAMESPACE[@]}"; do
  echo "$cluster"
  synced="$(kubectl --context "$cluster" get rootsync "$ROOTSYNC_NAME" -n "$ROOTSYNC_NAMESPACE" \
    -o jsonpath='{.status.sync.commit}' 2>/dev/null)"
  [[ -n "$head_sha" && "$synced" == "$head_sha" ]] && ok "Config Sync at ${synced:0:7}" ||
    bad "Config Sync at '${synced:0:7}', repo at '${head_sha:0:7}'"
  errors="$(kubectl --context "$cluster" get rootsync "$ROOTSYNC_NAME" -n "$ROOTSYNC_NAMESPACE" \
    -o jsonpath='{.status.sync.errorSummary.totalCount}' 2>/dev/null)"
  [[ -z "$errors" || "$errors" == "0" ]] && ok "no sync errors" || bad "$errors sync errors (nomos status)"
  pending="$(not_ready_pods "$cluster" "${APP_NAMESPACE[$cluster]}")"
  [[ -z "$pending" ]] && ok "all ${APP_NAMESPACE[$cluster]} pods ready" || bad "not ready: $(echo "$pending" | paste -sd' ')"
done

echo "$HUB_CONTEXT"
pending="$(not_ready_pods "$HUB_CONTEXT" "$AGENT_NAMESPACE")"
[[ -z "$pending" ]] && ok "all $AGENT_NAMESPACE pods ready" || bad "not ready: $(echo "$pending" | paste -sd' ')"
# Background cards share a few worker slots; anything left running or queued
# delays the demo's incident triage behind it.
busy="$(kubectl --context "$HUB_CONTEXT" exec -n "$AGENT_NAMESPACE" deploy/"$AGENT_DEPLOYMENT" \
  -c "$AGENT_CONTAINER" -- sh -c "HERMES_HOME=$PLATFORM_HERMES_HOME hermes kanban list" 2>/dev/null |
  grep -E -c ' (running|ready) ')"
[[ "$busy" == "0" ]] && ok "agent board idle" ||
  bad "$busy cards running or queued on the agent board: finish or archive them (RUNBOOK §3)"

echo
((failures == 0)) && echo "preflight passed" || echo "preflight: $failures failed"
exit $((failures > 0))
