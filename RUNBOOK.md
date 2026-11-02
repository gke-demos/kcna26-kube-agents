# Runbook

All commands run from this repository's root with `PROJECT` set to the demo project. Scripts
assume the kubeconfig contexts `scripts/contexts.sh` creates.

## 1. Build (once)

Prerequisites, none of which needs the project:

- **GitHub App on `gke-demos`** with Contents, Pull requests and Issues read/write, installed on
  `kcna26-fleet-gitops` only. Keep its App ID and private key; see the kube-agents
  [token minter guide](https://gke-labs.github.io/kube-agents/deploy/token-minter/).
- **Slack workspace and app**: a demo workspace with a `#platform-ops` channel and no real names
  in it; set up the app per [Slack app setup](https://gke-labs.github.io/kube-agents/install/slack-app/).
  Keep the bot token, app token and channel ID.
- **Fleet repo** `gke-demos/kcna26-fleet-gitops` (public) at its `baseline` tag.

Then, in the project:

```bash
# Workload clusters + Config Sync. bank-prod starts one minor behind.
cd terraform
terraform init
terraform apply -var project_id=$PROJECT \
  -var bank_prod_master_version=$(../scripts/lagging-version.sh $PROJECT)
cd ..
```

Install kube-agents on the hub with its own installer, pinned to the release or commit you
freeze on. Put the alert ceilings in `install.env` first, so the booth never runs out of alerts
in a day:

```bash
cat >> install.env <<'EOF'
ALERT_DAILY_LIMIT_CRITICAL=500
ALERT_DAILY_LIMIT_WARNING=500
EOF
curl -fsSL https://raw.githubusercontent.com/gke-labs/kube-agents/<RELEASE>/install.sh | bash -s -- \
  --non-interactive \
  --mode=next \
  --gcp-project-id=$PROJECT \
  --gke-cluster-name=kube-agents-hub \
  --gcp-region=us-central1 \
  --model-provider=gemini \
  --permission-set=read-only \
  --gitops-org=gke-demos --gitops-repo=kcna26-fleet-gitops \
  --github-app-id=<APP_ID> --github-pem-path=<KEY.pem> \
  --slack-bot-token=<xoxb-…> --slack-app-token=<xapp-…> \
  --slack-home-channel=<CHANNEL_ID> --slack-allowed-users=<U…,U…>
scripts/contexts.sh $PROJECT
```

Scope defaults to the install's own project, which holds all four clusters. Confirm the Platform
Agent has scaffolded a Cluster Agent for each (`boutique-prod`, `bank-prod`, the compute cluster),
then smoke-test once: `scripts/trigger-oom.sh`, wait for the alert, `scripts/reset.sh`.

Leave `INCIDENT_TRIAGE_OPEN_PULL_REQUEST` unset: the presenter clicking the fix option is the
human-in-the-loop moment.

**Freeze** after the first clean run-through: record the image tag here and do not upgrade.
Never restart the gateway during a session; it runs as a single replica.

Frozen at: `<image tag>` on `<date>`.

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
