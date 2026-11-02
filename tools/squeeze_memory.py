#!/usr/bin/env python3
"""Set every memory request and limit on one workload in a manifest file.

Usage: squeeze_memory.py <manifest> <workload-name> <quantity>

Requests and limits move together: a limit below the request is rejected by
the API server, which would fail the sync instead of OOM-killing the pod.
"""

import pathlib
import re
import sys

DOC_SEPARATOR = "\n---\n"
WORKLOAD_KIND = re.compile(r"^kind: (Deployment|StatefulSet)$", re.MULTILINE)
MEMORY_SETTING = re.compile(r"(\n\s+memory: )\S+")
EXIT_USAGE = 2


def squeeze(text, name, quantity):
    name_line = re.compile(r"^  name: " + re.escape(name) + r"$", re.MULTILINE)
    docs = text.split(DOC_SEPARATOR)
    for i, doc in enumerate(docs):
        if WORKLOAD_KIND.search(doc) and name_line.search(doc):
            docs[i], count = MEMORY_SETTING.subn(lambda m: m.group(1) + quantity, doc)
            if count == 0:
                raise SystemExit(f"no memory settings on {name}")
            return DOC_SEPARATOR.join(docs)
    raise SystemExit(f"no Deployment or StatefulSet named {name}")


def main(argv):
    if len(argv) != 4:
        print(__doc__, file=sys.stderr)
        return EXIT_USAGE
    path, name, quantity = pathlib.Path(argv[1]), argv[2], argv[3]
    path.write_text(squeeze(path.read_text(), name, quantity))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
