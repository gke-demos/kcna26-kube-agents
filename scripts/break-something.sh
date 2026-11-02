#!/usr/bin/env bash
# Booth button: fire the next incident in the rotation, so repeat visitors see
# a different service and cluster. The watcher dedups per pod, and every
# trigger rolls out new pods, so each run alerts afresh; the limit is the daily
# alert ceiling (ALERT_DAILY_LIMIT_*, raised in the RUNBOOK's install step).
# Run reset.sh between visitors.
#
# Usage: break-something.sh [--list]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

readonly ROTATION=(
  "trigger-oom.sh recommendationservice"
  "trigger-badimage.sh frontend"
  "trigger-oom.sh userservice"
  "trigger-oom.sh currencyservice"
  "trigger-badimage.sh productcatalogservice"
  "trigger-oom.sh contacts"
  "trigger-oom.sh emailservice"
  "trigger-badimage.sh checkoutservice"
)
readonly INDEX_FILE="$STATE_DIR/rotation-index"

if [[ "${1:-}" == "--list" ]]; then
  printf '%s\n' "${ROTATION[@]}"
  exit 0
fi

mkdir -p "$STATE_DIR"
index="$(cat "$INDEX_FILE" 2>/dev/null || echo 0)"
scenario="${ROTATION[$((index % ${#ROTATION[@]}))]}"
echo $(((index + 1) % ${#ROTATION[@]})) >"$INDEX_FILE"

echo "scenario $((index % ${#ROTATION[@]} + 1))/${#ROTATION[@]}: $scenario"
# shellcheck disable=SC2086 # the scenario is a script name plus its argument
"$SCRIPT_DIR"/$scenario
