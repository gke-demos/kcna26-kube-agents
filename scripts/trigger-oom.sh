#!/usr/bin/env bash
# Live incident: a "memory tuning" commit squeezes one service below what it
# needs, Config Sync applies it, the new pods are OOMKilled on start, and the
# kube-agents event watcher raises the alert within seconds.
#
# Usage: trigger-oom.sh [recommendationservice|emailservice|currencyservice|userservice|contacts]
# Default: recommendationservice (the talk's scenario).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

readonly DEFAULT_TARGET="recommendationservice"
# Below what the runtime needs to start (recommendationservice idles at 31Mi,
# so 32Mi was not enough; measured 2026-11-02), so the kill is immediate and
# certain. Python and Node only: a JVM sizes its heap to the limit and exits
# with its own OutOfMemoryError (a crashloop, which alerts minutes later).
readonly SQUEEZED_MEMORY="20Mi"
readonly SQUEEZE_TOOL="$SCRIPT_DIR/../tools/squeeze_memory.py"

target="${1:-$DEFAULT_TARGET}"
case "$target" in
  recommendationservice | emailservice | currencyservice)
    file="$BOUTIQUE_DIR/$target.yaml" cluster="boutique-prod" ;;
  userservice | contacts)
    file="$BANK_DIR/$target.yaml" cluster="bank-prod" ;;
  *) die "unknown target '$target'" ;;
esac

dir="$(clone_fleet)"
trap 'rm -rf "$dir"' EXIT
python3 -I "$SQUEEZE_TOOL" "$dir/$file" "$target" "$SQUEEZED_MEMORY"
git -C "$dir" add "$file"
sha="$(commit_and_push "$dir" "perf($target): right-size memory to $SQUEEZED_MEMORY

Profiling showed steady-state usage well under the old request.")"

echo "pushed $sha: $target on $cluster squeezed to $SQUEEZED_MEMORY."
echo "Config Sync applies it within ~15s; watch the Slack channel for the alert."
