"""Summarise kube-agents release notes for an upgrade: the entries an install can see.

Fetches each release's notes with `gh`, drops CI, eval, bench, test and
maintainer-doc entries, shortens the author/URL tail to (#PR), and prints
"<version> <entry>" lines, then the entries marked breaking. Also prints the
upgrade page's breaking-change rows for those releases, from the newest release
given, which is where kube-agents lists what an upgrade has to act on.

Usage: python3 -I tools/release_notes.py VERSION...   (e.g. 0.32.0 0.33.0)
"""

import json
import re
import subprocess
import sys

REPO = "gke-labs/kube-agents"
UPGRADE_PAGE = "docs/site/src/content/docs/install/upgrade.md"
TAIL = re.compile(r" by @[\w-]+(?: \[bot\])? in https://github\.com/gke-labs/kube-agents/pull/(\d+)$")
NOISE = re.compile(
    r"^(ci|test|style|chore\((?:ci|eval)|docs\((?:designs?|rules|skills|ci|eval|bench|ownership|success-criteria|testing-strategy|ci-pool)"
    r"|feat\((?:bench|eval|ci|ci-health|eval-dashboard|replay-proxy)|fix\((?:bench|eval|ci|ci-health|replay-proxy|ci-eval|eval-dashboard)"
    r"|refactor\((?:bench|ci)|perf\(bench)[(:!,]",
    re.I,
)
BREAKING = re.compile(r"^\w+(\([^)]*\))?!:|BREAKING")
ROW_WIDTH = 900


def gh(*args):
    return subprocess.run(["gh", *args], capture_output=True, text=True, check=True).stdout


def notes(version):
    body = json.loads(gh("release", "view", version, "-R", REPO, "--json", "body"))["body"]
    for line in body.splitlines():
        if line.startswith("* "):
            yield TAIL.sub(r" (#\1)", line[2:])


def main(versions):
    total = kept = 0
    breaking = []
    for v in versions:
        for entry in notes(v):
            total += 1
            if NOISE.match(entry):
                continue
            kept += 1
            print(f"{v} {entry}")
            if BREAKING.search(entry):
                breaking.append(f"{v} {entry}")
    print(f"\n{kept} of {total} entries kept; {len(breaking)} marked breaking")
    for b in breaking:
        print("  " + b)
    page = gh("api", "-H", "Accept: application/vnd.github.raw", f"repos/{REPO}/contents/{UPGRADE_PAGE}?ref={versions[-1]}")
    rows = [r for r in page.splitlines() if any(r.startswith(f"| {v} ") for v in versions)]
    print(f"\nupgrade-page rows for {', '.join(versions)}: {len(rows)}")
    for r in rows:
        print("  " + r[:ROW_WIDTH])


if __name__ == "__main__":
    main(sys.argv[1:])
