#!/usr/bin/env python3
"""Plant the demo's standing defects into a freshly vendored fleet repo.

Usage: plant_defects.py <fleet-repo-dir>

Run after vendor_apps.py. The result is the repo's `baseline` tag: what the
overnight audits find and what reset.sh restores. Each defect is one the audits
report on their own; none is a live incident (those are scripts/trigger-*.sh).

  boutique-prod  frontend at 3 replicas with no PodDisruptionBudget
                 (obtainability audit, `no-pdb`; additive fix, so the audit
                 opens the PR itself)
  bank-prod      the app ServiceAccount bound to cluster-admin
                 (compliance audit, critical; the audit opens the PR itself)
  bank-prod      ledger-db PDB with maxUnavailable 0, which blocks node drain
                 and so the cluster's upgrade (obtainability `pdb` shape check;
                 the answer to "is bank-prod safe to upgrade?")
"""

import pathlib
import sys

BOUTIQUE_DIR = "clusters/boutique-prod/namespaces/online-boutique"
BANK_DIR = "clusters/bank-prod/namespaces/bank-of-anthos"
FRONTEND_REPLICAS = 3
FRONTEND_SPEC = "spec:\n  selector:\n    matchLabels:\n      app: frontend\n"
OVERGRANT_FILE = "debug-access.yaml"
OVERGRANT = """\
# Added during the 2026-10 ledger incident so the on-call could exec into pods
# from the app's identity. Meant to be temporary.
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: bank-of-anthos-debug-access
  labels:
    application: bank-of-anthos
subjects:
  - kind: ServiceAccount
    name: bank-of-anthos
    namespace: bank-of-anthos
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: cluster-admin
"""
LEDGER_PDB_FILE = "ledger-db-pdb.yaml"
LEDGER_PDB = """\
# The ledger must never be disrupted.
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  namespace: bank-of-anthos
  name: ledger-db
  labels:
    application: bank-of-anthos
spec:
  maxUnavailable: 0
  selector:
    matchLabels:
      app: ledger-db
"""
EXIT_USAGE = 2


def plant_frontend_replicas(repo):
    path = repo / BOUTIQUE_DIR / "frontend.yaml"
    text = path.read_text()
    if FRONTEND_SPEC not in text:
        raise SystemExit(f"{path}: frontend Deployment spec not in the expected shape")
    planted = f"spec:\n  replicas: {FRONTEND_REPLICAS}\n  selector:\n    matchLabels:\n      app: frontend\n"
    path.write_text(text.replace(FRONTEND_SPEC, planted, 1))
    return path


def plant_file(repo, directory, name, body):
    path = repo / directory / name
    path.write_text(body)
    return path


def main(argv):
    if len(argv) != 2:
        print(__doc__, file=sys.stderr)
        return EXIT_USAGE
    repo = pathlib.Path(argv[1])
    for path in (
        plant_frontend_replicas(repo),
        plant_file(repo, BANK_DIR, OVERGRANT_FILE, OVERGRANT),
        plant_file(repo, BANK_DIR, LEDGER_PDB_FILE, LEDGER_PDB),
    ):
        print(path.relative_to(repo))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
