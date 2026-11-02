# Vetted prompts

Every prompt shown live is measured three times on the frozen build. Drop any that takes over two
minutes or gives a different answer between runs. Times are wall-clock from send to final answer.

| # | Prompt | Used in | Expected answer names | Runs (s) |
| - | ------ | ------- | --------------------- | -------- |
| 1 | What's the riskiest finding in last night's compliance audit, and is there a fix open? | talk 1:30, booth | `bank-of-anthos-debug-access` (`cluster-admin`), its fix PR | _, _, _ |
| 2 | Is bank-prod safe to upgrade? What would block it? | talk 8:00, booth | one minor behind REGULAR; `ledger-db` PDB `maxUnavailable: 0` blocks drain | _, _, _ |
| 3 | Which of our clusters are behind their release channel? | booth | `bank-prod` | _, _, _ |
| 4 | Which workloads on boutique-prod would go down during a node upgrade? | booth | `frontend` (no PDB), single-replica services | _, _, _ |
| 5 | What's running on the compute demo cluster, and is it healthy? | booth | the compute demo's workloads | _, _, _ |
| 6 | Summarize what happened in the last incident and what fixed it. | booth, after an incident | the service, the OOM, the merged PR | _, _, _ |

Do not ask it to run an audit live. This build cannot start one from chat and will say so
(operators use the `kubectl exec` command in the RUNBOOK).

## Candidates not yet vetted

- How much are we spending on idle capacity across the fleet?
- Show me every workload running as `cluster-admin`.
- Draft a PR that adds a NetworkPolicy to bank-of-anthos. (Slow: opens a PR.)
