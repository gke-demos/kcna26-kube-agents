#!/usr/bin/env bash
# Shorten Config Sync's reconcile timeout on the workload clusters.
#
# Config Sync waits for what it last applied to become healthy before it moves
# to the next commit, for up to reconcileTimeout (default 5m). After a planted
# incident the last apply never becomes healthy, so a merged fix waited up to
# five minutes. 15s makes a fix land about half a minute after the merge.
# The fleet API has no field for this; the override on the fleet-managed
# RootSync is not reverted (checked over 5 minutes on 2026-11-03). Run after
# terraform/ and whenever a cluster is re-created.
#
# Usage: tune-config-sync.sh [CLUSTER...]   (default: the KubeCon clusters; staging: boutique-stg)
set -euo pipefail

readonly DEFAULT_CLUSTERS=(boutique-prod bank-prod)
readonly NAMESPACE="config-management-system"
readonly ROOTSYNC="root-sync"
readonly TIMEOUT="15s"

clusters=("$@")
[[ ${#clusters[@]} -gt 0 ]] || clusters=("${DEFAULT_CLUSTERS[@]}")
for c in "${clusters[@]}"; do
  kubectl --context "$c" -n "$NAMESPACE" patch rootsync "$ROOTSYNC" --type merge \
    -p "{\"spec\":{\"override\":{\"reconcileTimeout\":\"$TIMEOUT\"}}}"
done
