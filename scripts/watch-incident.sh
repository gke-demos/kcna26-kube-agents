#!/usr/bin/env bash
# Rehearsal aid: follow an incident from alert to fix PR. Prints a line each
# time the alert's Slack thread grows, and exits when a fix PR is open on the
# fleet repo (one not opened by the overnight audits).
#
# Usage: watch-incident.sh <alert-message-ts> [timeout-seconds]
#   The ts is the alert's Slack message timestamp (Copy link → the p… number,
#   with a dot before the last six digits).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

readonly CHANNEL_ID="C0CEZ07K39N"
readonly TOKEN_FILE="${SLACK_BOT_TOKEN_FILE:-$HOME/.kcna26/slack-bot-token}"
readonly DEFAULT_TIMEOUT_SECONDS=1200
readonly POLL_SECONDS=20
readonly PREVIEW_CHARS=200

alert_ts="${1:?usage: watch-incident.sh <alert-message-ts> [timeout-seconds]}"
timeout="${2:-$DEFAULT_TIMEOUT_SECONDS}"
start=$(date +%s)
prev=""

while true; do
  t=$(($(date +%s) - start))
  prs="$(gh pr list -R "$FLEET_REPO" --state open --json number,title,headRefName,author,url \
    --jq ".[] | select(.headRefName | startswith(\"$AUDIT_PR_PREFIX\") | not) |
      \"#\(.number) \(.headRefName) by \(.author.login): \(.title) \(.url)\"" 2>/dev/null)"
  if [[ -n "$prs" ]]; then
    echo "t+${t}s PR: $prs"
    exit 0
  fi
  thread="$(curl -s -H "Authorization: Bearer $(<"$TOKEN_FILE")" \
    "https://slack.com/api/conversations.replies?channel=$CHANNEL_ID&ts=$alert_ts" |
    jq -r --argjson n "$PREVIEW_CHARS" \
      '(.messages | length - 1 | tostring) + " replies; latest: " +
       ((.messages[-1].text // "") | gsub("\n"; " ") | .[0:$n])' 2>/dev/null)"
  if [[ "$thread" != "$prev" ]]; then
    echo "t+${t}s thread: $thread"
    prev="$thread"
  fi
  if ((t > timeout)); then
    echo "t+${t}s no fix PR after ${timeout}s"
    exit 1
  fi
  sleep "$POLL_SECONDS"
done
