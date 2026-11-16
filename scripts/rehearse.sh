#!/usr/bin/env bash
# Rehearse the bad-image incident end to end on staging or prod, for checking an
# upgrade: roll a workload out to a missing image tag, wait for the agent's fix
# PR, show its diff, merge it, wait for the rollout, and print the timings. On
# staging it presses the console's button and prints what the console recorded.
#
# Usage: rehearse.sh staging|prod [frontend|checkoutservice|productcatalogservice]
#   It merges the agent's PR itself. Pick a workload that has not broken in the
#   last 15 minutes, or the alert folds into that incident and no PR opens.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly REPO_ROOT="$SCRIPT_DIR/.."
readonly NAMESPACE="online-boutique"
readonly DEFAULT_TARGET="checkoutservice"
readonly PR_POLL_SECONDS=15
readonly PR_TIMEOUT_SECONDS=900
readonly ROLLOUT_TIMEOUT="300s"
readonly STAGING_HUB="kube-agents-stg"
readonly STAGING_PORT=18085
readonly CONSOLE_HEADER="X-Fleet-Scope: 1"

target_env="${1:-}"
target="${2:-$DEFAULT_TARGET}"
case "$target_env" in
  staging) repo="gke-demos/kcna26-fleet-gitops-staging" cluster="boutique-stg" ;;
  prod) repo="gke-demos/kcna26-fleet-gitops" cluster="boutique-prod" ;;
  *)
    sed -n '2,10p' "$0"
    exit 2
    ;;
esac

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
secs() { date -u -d "$1" +%s; }
pf_pid=""
cleanup() { [[ -z "$pf_pid" ]] || kill "$pf_pid" 2>/dev/null || true; }
trap cleanup EXIT

pressed="$(now)"
if [[ "$target_env" == staging ]]; then
  kubectl --context "$STAGING_HUB" -n fleet-scope port-forward svc/fleet-scope "$STAGING_PORT:80" >/dev/null 2>&1 &
  pf_pid=$!
  sleep 5
  pressed="$(now)"
  curl -sf -X POST "http://localhost:$STAGING_PORT/api/actions/trigger-badimage" \
    -H "$CONSOLE_HEADER" -H "Origin: http://localhost:$STAGING_PORT" -H 'Content-Type: application/json' \
    -d "{\"target\":\"$target\"}"
  echo
else
  "$SCRIPT_DIR/trigger-badimage.sh" "$target"
fi
echo "pressed $pressed: $target on $cluster"

pr=""
deadline=$(($(date +%s) + PR_TIMEOUT_SECONDS))
while [[ -z "$pr" && $(date +%s) -lt $deadline ]]; do
  sleep "$PR_POLL_SECONDS"
  pr="$(gh pr list -R "$repo" --state all --limit 5 --json number,createdAt \
    --template '{{range .}}{{.createdAt}} {{.number}}{{"\n"}}{{end}}' | awk -v s="$pressed" '$1 >= s {print; exit}')"
done
[[ -n "$pr" ]] || {
  echo "no fix PR on $repo within $PR_TIMEOUT_SECONDS s: check the channel and the board" >&2
  exit 1
}
pr_at="${pr%% *}" number="${pr##* }"
echo "PR #$number opened $pr_at ($(($(secs "$pr_at") - $(secs "$pressed"))) s after the press):"
gh pr diff "$number" -R "$repo" | grep -E '^[+-] ' || true
gh pr merge "$number" -R "$repo" --merge
merged="$(now)"
kubectl --context "$cluster" -n "$NAMESPACE" rollout status "deploy/$target" --timeout="$ROLLOUT_TIMEOUT" >/dev/null
healthy="$(now)"
echo "merged $merged; healthy $healthy: $(($(secs "$healthy") - $(secs "$pressed"))) s from press to healthy"

if [[ "$target_env" == staging ]]; then
  echo "--- the console's events"
  node "$REPO_ROOT/tools/console_events.mjs" "ws://localhost:$STAGING_PORT/api/stream" "$pressed"
fi
