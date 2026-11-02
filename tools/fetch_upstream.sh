#!/usr/bin/env bash
# Fetch the pinned upstream app manifests vendor_apps.py splits.
# Usage: fetch_upstream.sh <out-dir>
set -euo pipefail

readonly BOUTIQUE_REPO="GoogleCloudPlatform/microservices-demo"
readonly BOUTIQUE_TAG="v0.10.7"
readonly BANK_REPO="GoogleCloudPlatform/bank-of-anthos"
readonly BANK_TAG="v0.6.11"
readonly BANK_COMPONENTS=(accounts-db balance-reader config contacts frontend ledger-db
  ledger-writer loadgenerator transaction-history userservice)
readonly RAW_ACCEPT="Accept: application/vnd.github.raw"

out="${1:?usage: fetch_upstream.sh <out-dir>}"
mkdir -p "$out/online-boutique" "$out/bank-of-anthos"

fetch() { gh api -H "$RAW_ACCEPT" "repos/$1/contents/$2?ref=$3" >"$4"; }

fetch "$BOUTIQUE_REPO" release/kubernetes-manifests.yaml "$BOUTIQUE_TAG" \
  "$out/online-boutique/kubernetes-manifests.yaml"
fetch "$BANK_REPO" extras/jwt/jwt-secret.yaml "$BANK_TAG" "$out/bank-of-anthos/jwt-secret.yaml"
for c in "${BANK_COMPONENTS[@]}"; do
  fetch "$BANK_REPO" "kubernetes-manifests/$c.yaml" "$BANK_TAG" "$out/bank-of-anthos/$c.yaml"
done
echo "fetched $BOUTIQUE_REPO@$BOUTIQUE_TAG and $BANK_REPO@$BANK_TAG into $out"
