#!/usr/bin/env python3
"""Delete the kube-agents bot's messages from the demo Slack channel.

Usage: clear_channel.py [--keep REGEX] [--dry-run]

Deletes every top-level message the bot posted, and the bot's replies under
each, so the channel starts the talk or a booth shift clean. --keep spares
top-level messages whose text matches REGEX (and their threads), e.g.
--keep 'audit' to leave last night's audit cards on screen. Messages people
wrote stay: a bot token can delete only its own.

Reads the bot token from $SLACK_BOT_TOKEN_FILE (default ~/.kcna26/slack-bot-token).
"""

import argparse
import json
import os
import pathlib
import re
import sys
import time
import urllib.parse
import urllib.request

CHANNEL_ID = "C0CEZ07K39N"
TOKEN_FILE_ENV = "SLACK_BOT_TOKEN_FILE"
DEFAULT_TOKEN_FILE = "~/.kcna26/slack-bot-token"
API_BASE = "https://slack.com/api/"
PAGE_SIZE = 200
# chat.delete is Slack's Tier 3 (about 50 a minute).
DELETE_INTERVAL_SECONDS = 1.3
RATE_LIMIT_FALLBACK_SECONDS = 5


def call(token, method, params, post=False):
    data = urllib.parse.urlencode(params).encode()
    url = API_BASE + method + ("" if post else "?" + data.decode())
    req = urllib.request.Request(
        url, data=data if post else None, headers={"Authorization": f"Bearer {token}"}
    )
    while True:
        try:
            with urllib.request.urlopen(req) as resp:
                body = json.load(resp)
        except urllib.error.HTTPError as err:
            if err.code == 429:
                time.sleep(int(err.headers.get("Retry-After", RATE_LIMIT_FALLBACK_SECONDS)))
                continue
            raise
        if not body.get("ok"):
            raise SystemExit(f"{method}: {body.get('error')}")
        return body


def paged(token, method, params, key):
    cursor = None
    while True:
        page = dict(params, limit=PAGE_SIZE, **({"cursor": cursor} if cursor else {}))
        body = call(token, method, page)
        yield from body.get(key, [])
        cursor = body.get("response_metadata", {}).get("next_cursor")
        if not cursor:
            return


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--keep", help="regex: spare top-level messages whose text matches")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv[1:])
    keep = re.compile(args.keep, re.IGNORECASE) if args.keep else None

    token_file = os.environ.get(TOKEN_FILE_ENV, DEFAULT_TOKEN_FILE)
    token = pathlib.Path(token_file).expanduser().read_text().strip()
    bot_user = call(token, "auth.test", {})["user_id"]

    targets = []
    kept = 0
    for msg in paged(token, "conversations.history", {"channel": CHANNEL_ID}, "messages"):
        if keep and keep.search(msg.get("text") or ""):
            kept += 1
            continue
        if msg.get("reply_count"):
            for reply in paged(
                token, "conversations.replies", {"channel": CHANNEL_ID, "ts": msg["ts"]}, "messages"
            ):
                if reply["ts"] != msg["ts"] and reply.get("user") == bot_user:
                    targets.append(reply["ts"])
        if msg.get("user") == bot_user:
            targets.append(msg["ts"])

    print(f"{len(targets)} bot messages to delete, {kept} kept by --keep")
    if args.dry_run:
        return 0
    for ts in targets:
        call(token, "chat.delete", {"channel": CHANNEL_ID, "ts": ts}, post=True)
        time.sleep(DELETE_INTERVAL_SECONDS)
    print("done")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
