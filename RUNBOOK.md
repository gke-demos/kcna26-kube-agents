# Runbook

All commands run from this repository's root with `PROJECT` set to the demo project (`kcna-2026-demos`). Scripts
assume the kubeconfig contexts `scripts/contexts.sh` creates.

## 1. Build (once)

Prerequisites, none of which needs the project:

- **GitHub App** `kube-agents-platform-agent` (fallback `kcna26-platform-agent` if the name is
  taken), owned by `gke-demos` (org Settings → Developer settings → GitHub Apps). Its name is what
  the audience sees on every PR, as `<slug>[bot]`.
  - Permissions: Contents, Pull requests and Issues read/write. Webhook off.
  - Installable on this account only. Installed on `kcna26-fleet-gitops` only.
  - Generate a private key and keep the `.pem` outside every repo (e.g. `~/.kcna26/app.pem`). The
    App ID is not a credential.
  - At install, `--github-pem-path` imports the key into Cloud KMS. Delete the `.pem` once it has
    (needs `go` 1.21+ and KMS admin on the install host). See the kube-agents
    [token minter guide](https://gke-labs.github.io/kube-agents/deploy/token-minter/).
- **Slack workspace "Cymbal" and app**:
  - Create the app from [`slack/app-manifest.yaml`](slack/app-manifest.yaml) (Create New App → From
    a manifest).
  - Generate the app token (`xapp-…`, scope `connections:write`). Install to the workspace for the
    bot token (`xoxb-…`). Keep both under `~/.kcna26/`, outside every repo.
  - Create `#platform-ops`, `/invite @kube-agents`, and copy its Channel ID.
  - Collect the member IDs of everyone who will drive the demo.
  - Full detail: [Slack app setup](https://gke-labs.github.io/kube-agents/install/slack-app/).
- **Fleet repo** `gke-demos/kcna26-fleet-gitops` (public) at its `baseline` tag.

Then, in the project (`kcna-2026-demos`). Run gcloud under a configuration whose account owns the
project; the scripts honour `CLOUDSDK_ACTIVE_CONFIG_NAME` (the build used one named `kcna26`).

```bash
export PROJECT=kcna-2026-demos CLOUDSDK_ACTIVE_CONFIG_NAME=kcna26
scripts/bootstrap-project.sh $PROJECT        # APIs + gs://$PROJECT-tfstate

# Workload clusters + Config Sync, in us-central1-b (us-central1-a was stocked out on
# 2026-11-02). bank-prod starts one minor behind.
cd terraform
terraform init -backend-config=bucket=$PROJECT-tfstate
GOOGLE_CLOUD_QUOTA_PROJECT=$PROJECT terraform apply -var project_id=$PROJECT \
  -var bank_prod_master_version=$(../scripts/lagging-version.sh $PROJECT)
cd ..

# kube-agents on the hub, pinned to one release. Reads its credentials from ~/.kcna26 and
# keeps the generated install.env (alert ceilings raised for the booth) there too.
scripts/install-hub.sh --dry-run
scripts/install-hub.sh
scripts/contexts.sh $PROJECT
```

`install-hub.sh` passes `--enable-slack` explicitly: a non-interactive install with only the
Slack tokens turns chat off.

Only allowlisted Slack members can give the agent instructions. To add booth staff, append their
member IDs to `SLACK_ALLOWED_USERS` in both `~/.kcna26/install.env` and `install-hub.sh`, and
re-run it; the installer refuses a flag that disagrees with `install.env`.

Scope defaults to the install's own project, which holds all four clusters. Confirm the Platform
Agent has scaffolded a Cluster Agent for each (`boutique-prod`, `bank-prod`, the compute cluster):

```bash
kubectl --context kube-agents-hub exec -n kubeagents-system deploy/platform-agent-gateway \
  -c platform-agent -- ls /opt/data/profiles
```

**Then restart the agent pod once.** The event watcher reads that list only at startup, and on a
fresh install it starts before the Cluster Agents exist, so it watches the hub alone. The same
applies whenever a cluster joins later (the compute demo cluster):

```bash
kubectl --context kube-agents-hub delete pod -n kubeagents-system \
  -l app=platform-agent-gateway
kubectl --context kube-agents-hub logs -n kubeagents-system deploy/platform-agent-gateway \
  -c agent-api-auth | grep 'watching .* cluster(s)'   # expect every cluster
```

Then smoke-test once: `scripts/trigger-oom.sh`, wait for the alert, `scripts/reset.sh`.

Install troubleshooting from the first build (2026-11-02, release 0.23.0):

- **GCE stockout.** `us-central1-a` and, briefly, the `us-central1` region could not place
  nodes. Delete a cluster left in `ERROR` before re-running; the installer adopts an existing
  cluster and fails against one that serves no API.
- **KMS key `409 already exists` on a re-run.** The installer imports the key it created before
  Terraform runs; that import fails while KMS is still propagating, or while the state still
  holds a deleted cluster. Re-run once the cluster exists. Until then `github-token-minter`
  crashloops with `PermissionDenied` on the key.
- **Helm `context deadline exceeded`** on the first apply: Autopilot was still adding nodes.
  Re-run.

Leave `INCIDENT_TRIAGE_OPEN_PULL_REQUEST` unset: the presenter clicking the fix option is the
human-in-the-loop moment.

**Freeze** after the first clean run-through: record the image tag here and do not upgrade.
Never restart the gateway during a session; it runs as a single replica.

Installed: release `0.23.0` (image tag `0.23.0`) on 2026-11-02. Frozen once the first run-through is clean.

## 2. Pre-stage the audits

The night before each show day (they also run on their own schedule, but the cost audit is weekly):

```bash
for job in compliance-audit obtainability-audit fleet-wide-cost-analysis; do
  kubectl --context kube-agents-hub exec -n kubeagents-system deploy/platform-agent-gateway \
    -c platform-agent -- env HERMES_HOME=/opt/data/profiles/platform hermes cron run "$job"
done
```

Each takes 10–22 minutes. Afterwards the fleet repo should have one `agent:audit` issue per audit
and at least two `platform-agent/fix-*` PRs (the `cluster-admin` binding and the `frontend` PDB).
Do not merge them; they are what the talk shows.

## 3. Before the talk (T-30 min)

- [ ] `scripts/reset.sh`, then `scripts/preflight.sh` passes.
- [ ] Slack: `#platform-ops` open, scrolled so last night's audit card is the latest message.
- [ ] Browser tabs: the compliance audit issue, the `cluster-admin` fix PR, the fleet repo's PR
      list, the Online Boutique storefront.
- [ ] Terminal: large font, in this repo, `scripts/trigger-oom.sh` typed but not run.
- [ ] Backup clips loaded and tested in the slide deck (one per live segment).
- [ ] Phone hotspot on and joined once.
- [ ] Notifications off everywhere.

## 4. Talk script (~12 min)

| t     | Do                                                                                                                                                       | Say (gist)                                                                                       |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 0:00  | Run `scripts/trigger-oom.sh`.                                                                                                                            | "Someone just merged a memory tune-up to the shop. Let's leave that and come back."             |
| 0:30  | Slide: the fleet.                                                                                                                                        | Three clusters, two apps, one GitOps repo. The agents can read everything and change nothing.   |
| 1:30  | Slack: the audit card. Open the compliance issue, then the `cluster-admin` fix PR.                                                                         | It audited the fleet overnight, filed one ledger issue per audit, and opened fixes for the criticals. |
| 3:00  | Ask prompt 1.                                                                                                                                            | Ask it about its own findings.                                                                  |
| 4:30  | The alert has landed and the triage has edited it in place. Read the diagnosis and click the recommended option. The "PR opened" card appears; open the diff. | Diagnosis came from the Cluster Agent on boutique-prod, which is read-only. The fix is a PR.   |
| 6:30  | Merge the PR. Show the pod go Ready (storefront or `kubectl get pods -w`).                                                                                | A human merged it, Config Sync applied it. That's the only way anything changes.               |
| 8:00  | Ask prompt 2.                                                                                                                                            | Ad-hoc questions across the fleet.                                                             |
| 10:00 | Slide: how it's built.                                                                                                                                   | See `slides/architecture.md`.                                                                   |
| 11:00 | Slide: where it's going.                                                                                                                                 | See `slides/roadmap.md`.                                                                        |

If the alert hasn't landed by 4:30, do prompt 2 first, then come back. If it hasn't landed by
8:00, play the incident backup clip.

After the talk: `scripts/reset.sh`.

## 5. Booth

- An attract loop plays on the big screen. The live station is a laptop with Slack and a terminal.
- **Visitor flow:**
  1. Run `scripts/break-something.sh`; it fires the next of 8 incidents across both clusters.
  2. While the triage runs (about 5–10 minutes), walk the visitor through the audit card and
     issue, or let them ask a prompt from the card (`prompts.md`).
  3. When the options appear, the visitor clicks one, and you show the PR.
  4. Don't merge; `scripts/reset.sh` closes it.
- Run `scripts/reset.sh` between visitors, and `scripts/preflight.sh` at the start of each shift.
- **If Slack or the agent is down,** keep the attract loop on and say so; don't debug at the
  booth. Ping the on-call channel.
