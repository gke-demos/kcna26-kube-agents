#!/usr/bin/env bash
# Build, deploy and expose fleet-scope (console/) on kube-agents-hub.
#
# Usage: console.sh build            build and push the image (tag: git short SHA)
#        console.sh deploy [--dev] [TAG]
#                                    Secrets from ~/.kcna26 + the workload. --dev runs it with a
#                                    fixed identity so `open` works without IAP; testing only
#        console.sh open             port-forward to http://localhost:18080 (needs deploy --dev)
#        console.sh gateway          the public Gateway behind IAP (refused while --dev is on)
#        console.sh booth on [DELAY]  booth mode: merge the agent's incident PRs DELAY after they
#                                    open (default 60s), so incidents heal without staff
#        console.sh booth off        merging back to a person (the talk). A deploy also turns it off
#        console.sh logs             follow the pod's logs
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly CONSOLE_DIR="$SCRIPT_DIR/../console"
readonly PROJECT="${PROJECT:-kcna-2026-demos}"
# The image lives in the KubeCon project for every install, staging included.
readonly IMAGE_PROJECT="${IMAGE_PROJECT:-kcna-2026-demos}"
readonly IMAGE_REPO="us-central1-docker.pkg.dev/$IMAGE_PROJECT/fleet-scope/fleet-scope"
readonly REGISTRY_HOST="us-central1-docker.pkg.dev"
readonly CONTEXT="${HUB_CONTEXT:-kube-agents-hub}"
readonly NAMESPACE="fleet-scope"
readonly CRED_DIR="${CRED_DIR:-$HOME/.kcna26}"
# console/deploy/fleet-scope-staging.yaml for the staging hub.
readonly MANIFEST="${CONSOLE_MANIFEST:-$CONSOLE_DIR/deploy/fleet-scope.yaml}"
readonly LOCAL_PORT=18080
readonly PLATFORM="linux/amd64"
readonly ROLLOUT_TIMEOUT="300s"
readonly DEV_IDENTITY="dev@port-forward.local"
readonly DEV_FLAG="--dev-identity=$DEV_IDENTITY"
readonly BOOTH_ENV="SCOPE_AUTO_MERGE"
readonly BOOTH_DEFAULT_DELAY="60s"

k() { kubectl --context "$CONTEXT" -n "$NAMESPACE" "$@"; }
die() {
  echo "error: $*" >&2
  exit 1
}
tag_default() { git -C "$CONSOLE_DIR" rev-parse --short HEAD; }

# Create or update a generic Secret with one key from a file, whitespace
# stripped: an editor's trailing newline in an OAuth client secret makes IAP
# reject it.
secret_from_file() {
  local name="$1" key="$2" file="$3" tmp
  [[ -s "$file" ]] || die "missing $file"
  tmp="$(mktemp)"
  chmod 600 "$tmp"
  tr -d '[:space:]' <"$file" >"$tmp"
  kubectl --context "$CONTEXT" -n "$NAMESPACE" create secret generic "$name" \
    --from-file="$key=$tmp" --dry-run=client -o yaml | k apply -f -
  rm -f "$tmp"
}

case "${1:-}" in
  build)
    tag="$(tag_default)"
    [[ -z "$(git -C "$CONSOLE_DIR" status --porcelain -- .)" ]] || tag="$tag-dirty"
    gcloud auth configure-docker "$REGISTRY_HOST" --quiet >/dev/null
    docker buildx build --platform "$PLATFORM" -t "$IMAGE_REPO:$tag" --push "$CONSOLE_DIR"
    echo "$IMAGE_REPO:$tag"
    ;;
  deploy)
    shift
    dev=false
    if [[ "${1:-}" == "--dev" ]]; then
      dev=true
      shift
    fi
    tag="${1:-$(tag_default)}"
    kubectl --context "$CONTEXT" apply -f <(sed -n '1,/^---$/p' "$MANIFEST")
    secret_from_file fleet-scope-slack token "$CRED_DIR/slack-bot-token"
    if [[ -s "$CRED_DIR/github-pat" ]]; then
      secret_from_file fleet-scope-github token "$CRED_DIR/github-pat"
    else
      echo "warning: no $CRED_DIR/github-pat yet: no PR signals and no buttons" >&2
    fi
    dev_sed='s|^(\s*)- --github-token-file|&|'
    $dev && dev_sed="s|^(\\s*)- --github-token-file|\\1- $DEV_FLAG\\n&|"
    sed -E -e "s|image: IMAGE|image: $IMAGE_REPO:$tag|" -e "$dev_sed" "$MANIFEST" |
      kubectl --context "$CONTEXT" apply -f -
    k rollout restart deploy/fleet-scope >/dev/null
    k rollout status deploy/fleet-scope --timeout="$ROLLOUT_TIMEOUT"
    ;;
  open)
    echo "fleet-scope on http://localhost:$LOCAL_PORT (IAP is not in this path: the pod refuses"
    echo "requests without IAP's header unless it runs with --dev-identity)"
    k port-forward svc/fleet-scope "$LOCAL_PORT:80"
    ;;
  gateway)
    if k get deploy fleet-scope -o jsonpath='{.spec.template.spec.containers[0].args}' | grep -q -- "$DEV_FLAG"; then
      die "fleet-scope runs with $DEV_FLAG; run 'console.sh deploy' (without --dev) first"
    fi
    [[ -s "$CRED_DIR/oauth-client-id" ]] || die "missing $CRED_DIR/oauth-client-id"
    client_id="$(tr -d '[:space:]' <"$CRED_DIR/oauth-client-id")"
    secret_from_file fleet-scope-oauth client_secret "$CRED_DIR/oauth-client-secret"
    sed "s|OAUTH_CLIENT_ID|$client_id|" "$CONSOLE_DIR/deploy/gateway.yaml" |
      kubectl --context "$CONTEXT" apply -f -
    echo "Gateway applied. The load balancer takes a few minutes; then grant viewers:"
    echo "  gcloud projects add-iam-policy-binding $PROJECT --member=user:EMAIL --role=roles/iap.httpsResourceAccessor"
    ;;
  booth)
    case "${2:-}" in
      on)
        delay="${3:-$BOOTH_DEFAULT_DELAY}"
        k set env deploy/fleet-scope "$BOOTH_ENV=$delay" >/dev/null
        k rollout status deploy/fleet-scope --timeout="$ROLLOUT_TIMEOUT"
        echo "booth mode on: incident PRs merge $delay after they open"
        ;;
      off)
        k set env deploy/fleet-scope "$BOOTH_ENV-" >/dev/null
        k rollout status deploy/fleet-scope --timeout="$ROLLOUT_TIMEOUT"
        echo "booth mode off: a person merges"
        ;;
      *) die "usage: console.sh booth on [DELAY] | off" ;;
    esac
    ;;
  logs)
    k logs -f deploy/fleet-scope
    ;;
  *)
    sed -n '2,14p' "$0"
    exit 2
    ;;
esac
