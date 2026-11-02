# kube-agents at KubeCon NA 2026

The kube-agents demo for the KubeCon NA 2026 talk and booth. A Platform Agent on
`kube-agents-hub` watches a small fleet. It audits the fleet overnight, diagnoses incidents live in
Slack, and fixes things only by opening pull requests on
[`gke-demos/kcna26-fleet-gitops`](https://github.com/gke-demos/kcna26-fleet-gitops), which Config
Sync applies once a human merges them.

| Cluster              | Runs                                        | Planted for the audits                                                       |
| -------------------- | ------------------------------------------- | ---------------------------------------------------------------------------- |
| `kube-agents-hub`    | kube-agents (`spec.mode: next`), Autopilot  | —                                                                            |
| `boutique-prod`      | Online Boutique v0.10.7                     | `frontend` at 3 replicas with no PodDisruptionBudget                         |
| `bank-prod`          | Bank of Anthos v0.6.11                      | app ServiceAccount bound to `cluster-admin`; `ledger-db` PDB that blocks drain; one minor behind REGULAR |
| compute demo cluster | another demo's workload, read by the agents | nothing; never a trigger target                                              |

Live incidents are commits to the fleet repo, the way a real bad change arrives: `trigger-oom.sh`
squeezes a service's memory, `trigger-badimage.sh` rolls out a tag that does not exist.

- [`RUNBOOK.md`](RUNBOOK.md): build, pre-talk checklist, talk script, booth guide.
- [`prompts.md`](prompts.md): the vetted chat prompts and their measured times.
- [`slides/`](slides/): the architecture and roadmap diagrams.
- `terraform/`: the two workload clusters and Config Sync.
- `scripts/`: triggers, `break-something.sh`, `reset.sh`, `preflight.sh`, `contexts.sh`.
- `tools/`: rebuilds the fleet repo's baseline from the pinned upstream apps.

## Rebuilding the fleet repo baseline

```bash
tools/fetch_upstream.sh /tmp/upstream
python3 -I tools/vendor_apps.py /tmp/upstream <fleet-repo-checkout>
python3 -I tools/plant_defects.py <fleet-repo-checkout>
# commit, push, then move the tag:
git -C <fleet-repo-checkout> tag -f baseline && git -C <fleet-repo-checkout> push -f origin baseline
```
