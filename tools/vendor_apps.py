#!/usr/bin/env python3
"""Split pinned upstream app manifests into the GitOps repo layout.

Usage: vendor_apps.py <upstream-dir> <gitops-repo-dir>

<upstream-dir> holds online-boutique/kubernetes-manifests.yaml and
bank-of-anthos/*.yaml, fetched by fetch_upstream.sh. Writes one file per
component under clusters/<cluster>/namespaces/<ns>/, sets metadata.namespace on
every namespaced object (Config Sync puts an unqualified object in `default`),
and files each Bank of Anthos object once under the component that owns it: the
upstream files are pre-rendered, so each repeats the shared config and the
database it depends on, and Config Sync rejects duplicate declarations. Planted defects are applied afterwards by
plant_defects.py, so this output is the clean baseline.
"""

import pathlib
import re
import sys

BOUTIQUE_CLUSTER = "boutique-prod"
BOUTIQUE_NAMESPACE = "online-boutique"
BOUTIQUE_SOURCE = "online-boutique/kubernetes-manifests.yaml"
BANK_CLUSTER = "bank-prod"
BANK_NAMESPACE = "bank-of-anthos"
BANK_SOURCE_DIR = "bank-of-anthos"
DOC_SEPARATOR = re.compile(r"^---\s*$", re.MULTILINE)
KIND_LINE = re.compile(r"^kind:\s*(\S+)", re.MULTILINE)
NAME_LINE = re.compile(r"^metadata:\n(?:  .*\n)*?  name:\s*(\S+)", re.MULTILINE)
CLUSTER_SCOPED_KINDS = {"Namespace", "ClusterRole", "ClusterRoleBinding"}
# Online Boutique objects whose name differs from the component they belong to.
BOUTIQUE_COMPONENT_ALIASES = {"frontend-external": "frontend", "redis-cart": "redis-cart"}
# Bank of Anthos object name -> the component file that owns it.
BANK_COMPONENT_BY_NAME = {
    "environment-config": "config",
    "service-api-config": "config",
    "demo-data-config": "config",
    "jwt-key": "jwt-secret",
    "bank-of-anthos": "serviceaccount",
    "accounts-db": "accounts-db",
    "accounts-db-config": "accounts-db",
    "ledger-db": "ledger-db",
    "ledger-db-config": "ledger-db",
    "balancereader": "balance-reader",
    "contacts": "contacts",
    "frontend": "frontend",
    "ledgerwriter": "ledger-writer",
    "loadgenerator": "loadgenerator",
    "transactionhistory": "transaction-history",
    "userservice": "userservice",
}
EXIT_USAGE = 2


def split_docs(text):
    docs = []
    for raw in DOC_SEPARATOR.split(text):
        body = "\n".join(
            line for line in raw.strip("\n").splitlines() if not line.startswith("#")
        ).strip("\n")
        if KIND_LINE.search(body):
            docs.append(body + "\n")
    return docs


def identity(doc):
    kind = KIND_LINE.search(doc).group(1)
    name = NAME_LINE.search(doc).group(1)
    return kind, name


def with_namespace(doc, namespace):
    kind, _ = identity(doc)
    if kind in CLUSTER_SCOPED_KINDS or re.search(r"^  namespace:", doc, re.MULTILINE):
        return doc
    return doc.replace("metadata:\n", f"metadata:\n  namespace: {namespace}\n", 1)


def namespace_doc(namespace):
    return f"apiVersion: v1\nkind: Namespace\nmetadata:\n  name: {namespace}\n"


def write_component(out_dir, component, docs):
    path = out_dir / f"{component}.yaml"
    path.write_text("---\n".join(docs))
    return path


def vendor_boutique(upstream, repo):
    out_dir = repo / "clusters" / BOUTIQUE_CLUSTER / "namespaces" / BOUTIQUE_NAMESPACE
    out_dir.mkdir(parents=True, exist_ok=True)
    components = {}
    for doc in split_docs((upstream / BOUTIQUE_SOURCE).read_text()):
        _, name = identity(doc)
        component = BOUTIQUE_COMPONENT_ALIASES.get(name, name)
        components.setdefault(component, []).append(with_namespace(doc, BOUTIQUE_NAMESPACE))
    (out_dir / "namespace.yaml").write_text(namespace_doc(BOUTIQUE_NAMESPACE))
    return [write_component(out_dir, c, d) for c, d in sorted(components.items())]


def vendor_bank(upstream, repo):
    out_dir = repo / "clusters" / BANK_CLUSTER / "namespaces" / BANK_NAMESPACE
    out_dir.mkdir(parents=True, exist_ok=True)
    seen = set()
    components = {}
    for source in sorted((upstream / BANK_SOURCE_DIR).glob("*.yaml")):
        for doc in split_docs(source.read_text()):
            key = identity(doc)
            if key in seen:
                continue
            seen.add(key)
            component = BANK_COMPONENT_BY_NAME[key[1]]
            components.setdefault(component, []).append(with_namespace(doc, BANK_NAMESPACE))
    (out_dir / "namespace.yaml").write_text(namespace_doc(BANK_NAMESPACE))
    return [write_component(out_dir, c, d) for c, d in sorted(components.items())]


def main(argv):
    if len(argv) != 3:
        print(__doc__, file=sys.stderr)
        return EXIT_USAGE
    upstream, repo = pathlib.Path(argv[1]), pathlib.Path(argv[2])
    for path in vendor_boutique(upstream, repo) + vendor_bank(upstream, repo):
        print(path.relative_to(repo))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
