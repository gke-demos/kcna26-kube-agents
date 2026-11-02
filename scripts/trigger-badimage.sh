#!/usr/bin/env bash
# Live incident: a rollout to an image tag that does not exist. The surge pod
# sits in ErrImagePull while the old replicas keep serving, so the shop stays
# up and the rollout is stuck: the watcher alerts on the pull failure at once.
#
# Usage: trigger-badimage.sh [frontend|checkoutservice|productcatalogservice]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

readonly DEFAULT_TARGET="frontend"
readonly UPSTREAM_TAG="v0.10.7"
# Looks like a plausible next patch; the registry has no such tag.
readonly MISSING_TAG="v0.10.70"

target="${1:-$DEFAULT_TARGET}"
case "$target" in
  frontend | checkoutservice | productcatalogservice) ;;
  *) die "unknown target '$target'" ;;
esac
file="$BOUTIQUE_DIR/$target.yaml"

dir="$(clone_fleet)"
trap 'rm -rf "$dir"' EXIT
grep -q "/$target:$UPSTREAM_TAG" "$dir/$file" || die "$file is not at $UPSTREAM_TAG; run reset.sh first"
sed -i "s|/$target:$UPSTREAM_TAG|/$target:$MISSING_TAG|" "$dir/$file"
git -C "$dir" add "$file"
sha="$(commit_and_push "$dir" "chore($target): roll out $MISSING_TAG")"

echo "pushed $sha: $target on boutique-prod set to $MISSING_TAG."
echo "Config Sync applies it within ~15s; watch the Slack channel for the alert."
