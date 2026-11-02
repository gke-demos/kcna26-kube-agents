#!/usr/bin/env bash
# Print the newest REGULAR-channel version one minor behind REGULAR's default,
# for terraform's bank_prod_master_version. Uses REGULAR's own valid list: a
# patch only RAPID carries cannot be upgraded off until REGULAR catches up.
#
# Usage: lagging-version.sh <project> [zone]
set -euo pipefail

readonly DEFAULT_ZONE="us-central1-b"
readonly CHANNEL="REGULAR"

project="${1:?usage: lagging-version.sh <project> [zone]}"
zone="${2:-$DEFAULT_ZONE}"

config="$(gcloud container get-server-config --project "$project" --zone "$zone" \
  --format=json --flatten="channels" --filter="channels.channel=$CHANNEL" 2>/dev/null)"
default="$(jq -r '.[0].channels.defaultVersion' <<<"$config")"
major_minor="$(cut -d. -f1,2 <<<"$default")"
lag_minor="$(cut -d. -f1 <<<"$major_minor").$(($(cut -d. -f2 <<<"$major_minor") - 1))"
version="$(jq -r --arg m "$lag_minor." \
  '[.[0].channels.validVersions[] | select(startswith($m))] | first // empty' <<<"$config")"

[[ -n "$version" ]] || {
  echo "error: $CHANNEL offers no $lag_minor version (default is $default)" >&2
  exit 1
}
echo "$version"
