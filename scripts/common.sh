#!/usr/bin/env bash
# Shared by the trigger, reset and preflight scripts. Source it; do not run it.
#
# Every incident is caused the way a real one would be: a commit to the fleet
# repo that Config Sync applies. Nothing here writes to a cluster directly, so a
# merged agent fix (or reset.sh) is what heals it.

readonly FLEET_REPO="${FLEET_REPO:-gke-demos/kcna26-fleet-gitops}"
readonly FLEET_BRANCH="${FLEET_BRANCH:-main}"
readonly BASELINE_TAG="baseline"
readonly BOUTIQUE_DIR="clusters/boutique-prod/namespaces/online-boutique"
readonly BANK_DIR="clusters/bank-prod/namespaces/bank-of-anthos"
# Branch prefix of the PRs the overnight audits open. reset.sh leaves these
# open: they are the pre-staged part of the demo.
readonly AUDIT_PR_PREFIX="platform-agent/fix-"
readonly STATE_DIR="${KCNA26_STATE_DIR:-$HOME/.kcna26-demo}"

die() {
  echo "error: $*" >&2
  exit 1
}

# Clone the fleet repo into a fresh temp dir and print its path.
clone_fleet() {
  local dir
  dir="$(mktemp -d -t kcna26-fleet.XXXXXX)"
  gh repo clone "$FLEET_REPO" "$dir" -- --quiet --branch "$FLEET_BRANCH" >&2 || die "cannot clone $FLEET_REPO"
  echo "$dir"
}

# Commit everything staged in $1 with message $2 and push it to the branch
# Config Sync reads. Prints the commit's short SHA.
commit_and_push() {
  local dir="$1" message="$2"
  git -C "$dir" diff --cached --quiet && die "nothing to commit: is the repo already in that state?"
  git -C "$dir" commit --quiet -m "$message"
  git -C "$dir" push --quiet origin "HEAD:$FLEET_BRANCH" || die "push to $FLEET_REPO failed"
  git -C "$dir" rev-parse --short HEAD
}

# Print a run-unique suffix so repeated booth runs read as distinct incidents.
run_id() {
  date +%H%M%S
}
