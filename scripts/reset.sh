#!/usr/bin/env bash
# Return the demo to its starting state: clusters/ back to the `baseline` tag
# (which still carries the planted audit defects), and every open incident PR
# closed with its branch deleted. The overnight audits' PRs stay open.
#
# Usage: reset.sh [--dry-run]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

readonly PR_LIMIT=100
readonly CLOSE_COMMENT="Closed by the demo reset (kcna26-kube-agents/scripts/reset.sh)."

dry_run=false
[[ "${1:-}" == "--dry-run" ]] && dry_run=true

dir="$(clone_fleet)"
trap 'rm -rf "$dir"' EXIT
git -C "$dir" fetch --quiet origin "refs/tags/$BASELINE_TAG:refs/tags/$BASELINE_TAG" ||
  die "no '$BASELINE_TAG' tag on $FLEET_REPO"

# rm then checkout, so files added since the baseline (an agent's new PDB, say)
# go too.
git -C "$dir" rm -r --quiet clusters
git -C "$dir" checkout "$BASELINE_TAG" -- clusters
if git -C "$dir" diff --cached --quiet; then
  echo "clusters/ already at $BASELINE_TAG"
else
  git -C "$dir" diff --cached --stat
  if $dry_run; then
    echo "(dry run: not pushing)"
  else
    echo "pushed $(commit_and_push "$dir" "chore: restore demo baseline")"
  fi
fi

gh pr list -R "$FLEET_REPO" --state open --limit "$PR_LIMIT" --json number,headRefName \
  --jq ".[] | select(.headRefName | startswith(\"$AUDIT_PR_PREFIX\") | not) | \"\(.number) \(.headRefName)\"" |
  while read -r number branch; do
    echo "closing #$number ($branch)"
    $dry_run || gh pr close "$number" -R "$FLEET_REPO" --delete-branch --comment "$CLOSE_COMMENT"
  done
