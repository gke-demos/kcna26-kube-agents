#!/usr/bin/env bash
# Print the kube-agents release an install runs, from its pin: RELEASE= in
# scripts/install-staging.sh (staging) or scripts/install-hub.sh (prod). Staging's
# pin moves at the end of UPGRADING.md step 3, prod's at step 5, so staging can be
# ahead while prod waits for a go-ahead.
#
# Usage: current-release.sh staging|prod
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR

case "${1:-}" in
  staging) pin="$SCRIPT_DIR/install-staging.sh" ;;
  prod) pin="$SCRIPT_DIR/install-hub.sh" ;;
  *)
    sed -n '2,7p' "$0"
    exit 2
    ;;
esac
release="$(sed -n 's/^readonly RELEASE="\([0-9.]*\)"$/\1/p' "$pin" | head -1)"
[[ -n "$release" ]] || {
  echo "no RELEASE= pin in $pin" >&2
  exit 1
}
echo "$release"
