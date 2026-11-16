#!/usr/bin/env bash
# Keep the staging install's SCOPE_EXCLUDE_CLUSTERS in ~/.kcna26/staging/install.env
# naming every cluster in gke-demos-345619 but staging's own two. Other demos add
# clusters to that project; one missing from the list is adopted by staging's agent
# on its next upgrade or install run.
#
# Usage: refresh-staging-scope.sh           rewrite the line if it is out of date
#        refresh-staging-scope.sh --check   exit 1 if it is out of date (no write)
# A rewrite takes effect on the next scripts/upgrade.sh staging run.
set -euo pipefail

readonly PROJECT="gke-demos-345619"
readonly OURS=" kube-agents-stg boutique-stg "
readonly INSTALL_ENV="${STAGING_INSTALL_ENV:-$HOME/.kcna26/staging/install.env}"
readonly KEY="SCOPE_EXCLUDE_CLUSTERS"
readonly ACCOUNT="${KCNA_ACCOUNT:-garisingh@gke.ninja}"

want=()
while read -r name location; do
  [[ "$OURS" == *" $name "* ]] || want+=("$PROJECT/$location/$name")
done < <(CLOUDSDK_CORE_ACCOUNT="$ACCOUNT" gcloud container clusters list --project "$PROJECT" --format="value(name,location)")
want_csv="$(printf '%s\n' "${want[@]}" | sort | paste -sd, -)"
have_csv="$(grep "^$KEY=" "$INSTALL_ENV" | cut -d= -f2- | tr ',' '\n' | sort | paste -sd, -)"

if [[ "$want_csv" == "$have_csv" ]]; then
  echo "ok    staging excludes all ${#want[@]} other clusters in $PROJECT"
  exit 0
fi
added="$(comm -13 <(tr ',' '\n' <<<"$have_csv") <(tr ',' '\n' <<<"$want_csv") | paste -sd' ' -)"
gone="$(comm -23 <(tr ',' '\n' <<<"$have_csv") <(tr ',' '\n' <<<"$want_csv") | paste -sd' ' -)"
echo "out of date: to exclude [${added}]; no longer exist [${gone}]"
if [[ "${1:-}" == "--check" ]]; then
  exit 1
fi
tmp="$(mktemp "$INSTALL_ENV.XXXX")"
grep -v "^$KEY=" "$INSTALL_ENV" >"$tmp" || true
echo "$KEY=$want_csv" >>"$tmp"
chmod 600 "$tmp"
mv "$tmp" "$INSTALL_ENV"
echo "rewrote $KEY in $INSTALL_ENV (${#want[@]} clusters); apply it with scripts/upgrade.sh staging <RELEASE>"
