# Upgrading kube-agents on the demo installs

How to move the demo's two kube-agents installs to a new release and prove they still work. Written
so an agent can follow it without other context: every step has the command, what to expect, and
when to stop. Always staging first, then prod.

**Stop and ask the person you work for** before step 4 (prod), and wherever a step says STOP. Do not
work around a refusal from a script here: each one guards against something that went wrong before
(see "What has gone wrong before").

**How to run the commands.** Run everything from the root of this repository. Each command block
stands alone: shell variables do not carry from one block to the next, so where a block shows
`<RELEASE>`, write the release (for example `0.34.0`) into the command itself. Never pipe
`scripts/upgrade.sh` into another command: its exit code is the result, and a pipe hides it.

## The two installs

|                                  | Staging                                                          | Prod (the KubeCon demo)                                                                              |
| -------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| GCP project                      | `gke-demos-345619` (shared with other demos)                     | `kcna-2026-demos`                                                                                    |
| Hub cluster / kubectl context    | `kube-agents-stg` (us-central1)                                  | `kube-agents-hub` (us-central1)                                                                      |
| Workload clusters / contexts     | `boutique-stg` (us-central1-b)                                   | `boutique-prod`, `bank-prod` (us-central1-b)                                                         |
| Other clusters the agent watches | none: every other cluster in the project is excluded             | `autoscale-arcade`, another demo's cluster, watched on purpose (read-only; never an incident target) |
| Fleet (GitOps) repo              | `gke-demos/kcna26-fleet-gitops-staging`                          | `gke-demos/kcna26-fleet-gitops`                                                                      |
| Slack channel                    | `#platform-ops-staging` (C0CFAPAV3HD), app `kube-agents-staging` | `#platform-ops` (C0CEZ07K39N), app `kube-agents`                                                     |
| Credentials and `install.env`    | `~/.kcna26/staging/`                                             | `~/.kcna26/`                                                                                         |
| gcloud                           | account `garisingh@gke.ninja` (`scripts/upgrade.sh` pins it)     | the same account, gcloud configuration `kcna26`                                                      |
| Console (fleet-scope)            | port-forward only (`--dev`)                                      | https://kcna26.demo.gke.ninja behind IAP                                                             |

Both run `spec.mode: next`, Gemini 3.8 Flash on Vertex AI, and one NATS bus server. The release they
run is the RUNBOOK's "Installed:" line and `RELEASE=` in `scripts/install-hub.sh`.

## 0. Prerequisites

Check each line before going on:

```bash
gcloud auth list --format='value(account)' | grep -x garisingh@gke.ninja
gcloud config configurations list --format='value(name)' | grep -x kcna26
gcloud projects describe gke-demos-345619 --account=garisingh@gke.ninja --format='value(projectId)'
gh auth status
gh api repos/gke-demos/kcna26-fleet-gitops --jq .permissions.push           # true: the rehearsal merges PRs
gh api repos/gke-demos/kcna26-fleet-gitops-staging --jq .permissions.push   # true
for f in install.env slack-bot-token github-pat; do test -s ~/.kcna26/$f && echo "prod $f ok"; done
for f in install.env slack-bot-token github-pat; do test -s ~/.kcna26/staging/$f && echo "staging $f ok"; done
kubectl config get-contexts -o name | grep -E '^(kube-agents-hub|boutique-prod|bank-prod|kube-agents-stg|boutique-stg)$'
command -v terraform jq node docker >/dev/null && echo tools ok
```

Missing contexts: `scripts/contexts.sh kcna-2026-demos` creates prod's three. Staging's two:

```bash
gcloud container clusters get-credentials kube-agents-stg --region us-central1 --project gke-demos-345619
kubectl config rename-context gke_gke-demos-345619_us-central1_kube-agents-stg kube-agents-stg
gcloud container clusters get-credentials boutique-stg --zone us-central1-b --project gke-demos-345619
kubectl config rename-context gke_gke-demos-345619_us-central1-b_boutique-stg boutique-stg
```

Then confirm both installs are healthy on the release they run now (from the RUNBOOK's
"Installed:" line), before changing anything:

```bash
scripts/verify-install.sh staging <CURRENT>
scripts/verify-install.sh prod <CURRENT>
```

Pass: exit 0. Every check line reads `ok`; `note` lines are information. `bus servers: 1` always
appears. A note naming **extra Cluster Agent profiles** on staging is a cluster another demo created
in gke-demos-345619 since staging's scope was last applied: staging's agent added it to the clusters
it watches (read-only; nothing is deployed on it). It is harmless, and step 3a excludes it as part
of this upgrade, so carry on. STOP if either exits non-zero: fix that first, because an upgrade on
top of a broken install hides the cause.

## 1. Review the release

```bash
gh release list -R gke-labs/kube-agents --limit 8
python3 -I tools/release_notes.py <each release after CURRENT, up to TARGET, e.g. 0.34.0 0.35.0>
```

The script prints the entries an install can see, the entries marked breaking, and the upgrade
page's breaking-change rows for those releases. Read all of it, then:

- **Every upgrade-page row**: does it apply to a `next` install on GKE Autopilot with Slack? A row
  that names something this demo sets (agent env, scope, bus, model, Slack) needs action before the
  upgrade. Example: 0.26 replaced hand-added PlatformAgent env, so the agent's settings moved to
  chart values first.
- **Entries touching** the Slack messages (`gateway`, `slack`, `chat`, `a2a`), incidents
  (`incident-triage`, `event-watcher`, `kanban`), audits (`fleet-audit`), fix PRs (`platform`,
  `submit-suggestion`, `gitops`), the installer or the chart: read the PR
  (`gh pr view <n> -R gke-labs/kube-agents`) when its title leaves the effect on this demo unclear.

Write down what you expect to change for this demo. STOP and ask if a change needs a decision (a
new default worth overriding, a setting to add) rather than a check.

## 2. Prepare

Fetch the release's scripts. `upgrade-<RELEASE>.sh` is what `scripts/upgrade.sh` runs;
`install-<RELEASE>.sh` is kept for a later re-install with `scripts/install-hub.sh` or
`scripts/install-staging.sh`, which pin the release.

```bash
gh api -H 'Accept: application/vnd.github.raw' \
  'repos/gke-labs/kube-agents/contents/upgrade.sh?ref=<RELEASE>' > ~/.kcna26/upgrade-<RELEASE>.sh
gh api -H 'Accept: application/vnd.github.raw' \
  'repos/gke-labs/kube-agents/contents/install.sh?ref=<RELEASE>' > ~/.kcna26/install-<RELEASE>.sh
cp ~/.kcna26/install-<RELEASE>.sh ~/.kcna26/staging/
chmod 600 ~/.kcna26/*.sh ~/.kcna26/staging/*.sh
grep -m1 '^BAKED_RELEASE_VERSION=' ~/.kcna26/upgrade-<RELEASE>.sh     # must print the release
```

Back up both installs' PlatformAgent and `install.env`:

```bash
b=~/.kcna26/backup-<RELEASE>; mkdir -p "$b"
kubectl --context kube-agents-hub -n kubeagents-system get platformagent platform-agent -o yaml > "$b/prod-platformagent.yaml"
kubectl --context kube-agents-stg -n kubeagents-system get platformagent platform-agent -o yaml > "$b/staging-platformagent.yaml"
cp ~/.kcna26/install.env "$b/prod-install.env"; cp ~/.kcna26/staging/install.env "$b/staging-install.env"
chmod -R go-rwx "$b"; ls "$b"
```

## 3. Staging

**3a. Refresh staging's cluster exclusions.** Staging shares its project with other demos' clusters
and excludes every one but its own two. A cluster added since the last run would be adopted by the
upgrade:

```bash
scripts/refresh-staging-scope.sh
```

It prints `ok` when the list is current, or rewrites the `SCOPE_EXCLUDE_CLUSTERS` line in
`~/.kcna26/staging/install.env` and says what changed. `scripts/upgrade.sh staging` refuses to run
while the list is out of date.

**3b. Plan.**

```bash
scripts/upgrade.sh staging <RELEASE> --plan > /tmp/stg-plan.log 2>&1; echo "exit $?"
sed 's/\x1b\[[0-9;]*m//g' /tmp/stg-plan.log | grep -E 'refusing|Target Image|GKE Target|state backend|Plan:|will be|must be'
```

`exit 2` means the plan has changes (normal); `exit 0` means nothing would change; `exit 1` means it
failed or refused: read the end of `/tmp/stg-plan.log`. Check the lines against "Reading the plan"
below. The `Target Image Tag` must be the release, and the state backend must be
`gs://gke-demos-345619-kube-agents-tfstate/kube-agents/kube-agents-stg`. STOP on a destroy, a
replacement, or anything in another project.

**3c. Apply.**

```bash
scripts/upgrade.sh staging <RELEASE> > /tmp/stg-apply.log 2>&1; echo "exit $?"
sed 's/\x1b\[[0-9;]*m//g' /tmp/stg-apply.log | grep -E 'refusing|Plan:|Apply complete|Upgrade Complete|Error|✗'
```

Pass: `exit 0`, `Apply complete!` with the same counts as the plan, and `Upgrade Complete!`. The chat
setup checklist printed after it is the installer's generic reminder; nothing in it is new. STOP on
any other result.

**3d. Verify.**

```bash
scripts/archive-drift-cards.sh kube-agents-stg
scripts/verify-install.sh staging <RELEASE>
```

Pass: `verify-install.sh` exits 0. A `note` naming a condition is advisory: read its message
(`kubectl --context kube-agents-stg -n kubeagents-system get platformagent platform-agent -o yaml`,
under `status.conditions`) and STOP to ask whether it needs an `install.env` setting, as 0.28's
`ScopeUndeclared` did (`SCOPE_PROJECTS`). `Ready=False` right after an apply is the rollout: re-run a
minute later. An "extra Cluster Agent profiles" note right after 3a excluded a cluster is expected:
the agent drops that profile at its hourly reconcile.

**3e. Rehearse an incident.**

```bash
scripts/rehearse.sh staging frontend > /tmp/stg-rehearse.log 2>&1; echo "exit $?"; cat /tmp/stg-rehearse.log
```

The workload can also be `checkoutservice` or `productcatalogservice`; pick one that has not broken
in the last 15 minutes, or the alert folds into that incident and no PR opens. The script presses the
console's "Roll out a missing image tag" button, waits for the agent's fix PR (only its incident
branch for that workload, touching only that workload's manifest), prints its diff, merges it, waits
for the rollout, prints the timings, then the events the console recorded.

Pass: `exit 0`; a one-line image revert; healthy within about 5 minutes of the press; console events
in this order, each keyed `boutique-stg/<workload>`: `action`, `alert`, `triage` notes,
`triage_report`, `pr_opened`, `pr_merged`.

STOP if it exits non-zero. Read `#platform-ops-staging` and the board:
`kubectl --context kube-agents-stg -n kubeagents-system exec deploy/platform-agent-gateway -c platform-agent -- env HERMES_HOME=/opt/data/profiles/platform hermes kanban list`.

**3f. If the console's events are wrong** (no `triage_report`, notes read as `chat`, events without a
key), the release changed the bot's Slack messages. STOP and say so; the fix is code:

1. Capture the thread with the staging bot token (`~/.kcna26/staging/slack-bot-token`;
   `conversations.history` and `conversations.replies` on C0CFAPAV3HD).
2. Fix `console/internal/signals/` with a test built from the real message; in `console/`, run
   `go test ./...` and `node --test web/js/*.test.js`; commit.
3. Build and deploy to staging. `console.sh build` ends with a `tag: <TAG>` line; pass that tag:
   ```bash
   scripts/console.sh build
   HUB_CONTEXT=kube-agents-stg CRED_DIR=~/.kcna26/staging CONSOLE_MANIFEST=console/deploy/fleet-scope-staging.yaml scripts/console.sh deploy --dev <TAG>
   ```
4. Repeat 3e on another workload until it passes.

**3g. Clean up staging.**

```bash
FLEET_REPO=gke-demos/kcna26-fleet-gitops-staging scripts/reset.sh
scripts/archive-drift-cards.sh kube-agents-stg
```

## 4. Prod

STOP: report the staging results (plan counts, verification, rehearsal timings, any console change)
and get a go-ahead for prod.

**4a. Plan.**

```bash
scripts/upgrade.sh prod <RELEASE> --plan > /tmp/prod-plan.log 2>&1; echo "exit $?"
sed 's/\x1b\[[0-9;]*m//g' /tmp/prod-plan.log | grep -E 'refusing|Target Image|GKE Target|state backend|Plan:|will be|must be'
```

The state backend must be `gs://kcna-2026-demos-kube-agents-tfstate/kube-agents/kube-agents-hub`,
and the plan should have staging's shape. STOP on a destroy, a replacement, or any change staging's
plan did not have.

**4b. Apply and verify.**

```bash
scripts/upgrade.sh prod <RELEASE> > /tmp/prod-apply.log 2>&1; echo "exit $?"
sed 's/\x1b\[[0-9;]*m//g' /tmp/prod-apply.log | grep -E 'refusing|Plan:|Apply complete|Upgrade Complete|Error|✗'
scripts/archive-drift-cards.sh kube-agents-hub
scripts/verify-install.sh prod <RELEASE>
```

Pass as for staging (3c, 3d).

**4c. Console.** Only if 3f changed the console: deploy the same tag to prod (behind IAP, not
`--dev`), then check the public URL still answers with IAP's sign-in redirect:

```bash
scripts/console.sh deploy <TAG>
curl -s -o /dev/null -w '%{http_code}\n' https://kcna26.demo.gke.ninja/     # 302
```

**4d. Rehearse.** The apply's drift triage cards hold the worker slots an incident needs, so sweep
them again first. `rehearse.sh` refuses to run while booth mode is on.

```bash
scripts/archive-drift-cards.sh kube-agents-hub
scripts/rehearse.sh prod productcatalogservice > /tmp/prod-rehearse.log 2>&1; echo "exit $?"; cat /tmp/prod-rehearse.log
```

The workload can also be `frontend` or `checkoutservice`. Pass: `exit 0`, a one-line revert merged,
the workload healthy within about 6 minutes. The prod console is behind IAP, so no console events
are printed for prod.

**4e. Clean up prod.**

```bash
scripts/reset.sh                                  # clusters/ back to the baseline tag; incident PRs closed
scripts/archive-drift-cards.sh kube-agents-hub    # drift cards keep arriving for a few minutes
python3 -I tools/clear_channel.py --keep audit    # the bot's posts in #platform-ops, except the audit cards
scripts/preflight.sh
```

The preflight's audit-freshness check fails while the install is idle (see "Audits on an idle
install"); every other line must be `ok`.

## 5. Record

1. Pin the release: `RELEASE="<RELEASE>"` in `scripts/install-hub.sh` and `scripts/install-staging.sh`.
2. RUNBOOK: add the release and the date to the "Installed:" line, and anything the release changed
   about running the demo.
3. FOLLOWUPS: one checked item with the date, the plan counts and both rehearsals' timings, plus open
   items for anything deferred.
4. Commit (`chore: both installs run kube-agents <RELEASE>`) and push to `main`.

## Verifying the whole demo

The rehearsal covers the live incident path. Before a show, or after a release that touched audits
or chat, also check on prod. STOP and ask before running the audits: each costs model tokens and
posts a card to `#platform-ops`.

- **Audits.** Run the two the talk uses by hand, then confirm each rewrote its existing ledger issue
  (same number) and kept the open fix PRs. Each takes 10–20 minutes.
  ```bash
  for job in compliance-audit obtainability-audit; do
    kubectl --context kube-agents-hub -n kubeagents-system exec deploy/platform-agent-gateway \
      -c platform-agent -- env HERMES_HOME=/opt/data/profiles/platform hermes cron run "$job"
  done
  gh issue list -R gke-demos/kcna26-fleet-gitops --label agent:audit --state open
  gh pr list -R gke-demos/kcna26-fleet-gitops --state open
  ```
- **The other incidents.** `scripts/trigger-oom.sh emailservice` (alerts about 6 minutes after the
  push), and the console's "Make a service unschedulable" and "Reset the demo" buttons.
- **Chat.** The RUNBOOK's two talk prompts, typed by a person in `#platform-ops`; the bot token cannot
  post as a person.
- **Booth mode.** Not with `rehearse.sh` (it refuses while booth mode is on, and merges PRs itself):
  ```bash
  scripts/console.sh booth on 60s
  scripts/trigger-badimage.sh checkoutservice
  ```
  Then watch the fleet repo: the agent's PR should be merged about 60 seconds after it opens, by
  the console (its merge commit carries `Pressed-by: auto-merge`). Then turn it off and check:
  ```bash
  scripts/console.sh booth off
  kubectl --context kube-agents-hub -n fleet-scope get deploy fleet-scope -o jsonpath='{.spec.template.spec.containers[0].env[*].name}'
  ```
  The list must not contain `SCOPE_AUTO_MERGE`. Finish with `scripts/reset.sh`.

## Reading the plan

| In the plan                                                                              | Meaning                                 | Action           |
| ---------------------------------------------------------------------------------------- | --------------------------------------- | ---------------- |
| `helm_release.kube_agents will be updated in-place` (or `kube_agents[0]`, 0.35 on)       | The upgrade itself                      | Expected         |
| `helm_release.cert_manager[0] … in-place`                                                | The chart bumped cert-manager           | Expected         |
| Minter `google_kms_crypto_key` / `google_service_account` in-place (labels, description) | Per-install ownership markers (0.28 on) | Expected         |
| `google_logging_project_sink.drift_audit` in-place (filter)                              | The drift detector's filter changed     | Expected on prod |
| Any `will be destroyed` or `must be replaced`                                            | Something leaves the install            | STOP             |
| A resource in the other install's project, or the other install's state backend          | Wrong install                           | STOP             |

A destroy has so far always meant a setting missing from `install.env`. Report which resources and
which variable they depend on; do not apply a plan with a destroy you cannot explain.

## Audits on an idle install

kube-agents 0.26 and later slow every model-run scheduled job (the audits) to weekly after 7 days
with no chat message from a person, and stop them after 14. A chat message to the agent wakes the
schedule; `hermes cron run` is never held. So a quiet install's audits go stale on purpose, and the
preflight's freshness check fails. Before a show, run them by hand (above, and RUNBOOK section 2).

## Rollback

Not rehearsed. kube-agents' path back is the previous release's `upgrade.sh` against the same
`install.env`: fetch it as in step 2, then `scripts/upgrade.sh <install> <PREVIOUS> --plan`. It stops
before applying when the move undoes a breaking change and names the commits; STOP and ask before
re-running it with `--allow-breaking-downgrade`. The backups from step 2 hold the PlatformAgent and
`install.env` as they were. The site's rollback page is canonical:
https://gke-labs.github.io/kube-agents/deploy/rollback/.

## What has gone wrong before

- **Settings passed only as installer flags are lost.** The release's `upgrade.sh` re-renders the
  install from `install.env` alone. A missing `MODEL_PROVIDER` planned the destruction of the Vertex
  AI gateway's identity (2026-11-07); missing `SCOPE_EXCLUDE_CLUSTERS` let staging adopt all 20
  clusters in gke-demos-345619 for a week (2026-11-07 to 11-14). `scripts/upgrade.sh` refuses an
  `install.env` without `MODEL_PROVIDER`, `VERTEX_LOCATION`, `MODEL_DEFAULT_NAME`, `SCOPE_PROJECTS`,
  `TF_VAR_extra_helm_values` and, for staging, an up-to-date `SCOPE_EXCLUDE_CLUSTERS`.
- **The installer's checkout holds a state backend.** kube-agents' `install.sh` keeps its Terraform
  backend in its checkout (`~/kube-agents` unless run from inside one). A staging dry run from prod's
  checkout planned prod's state for replacement (2026-11-07); `scripts/install-staging.sh` runs from
  `~/kcna26-staging/kube-agents` for that reason. The release's `upgrade.sh`, which
  `scripts/upgrade.sh` runs, works in a temporary clone and derives the backend from the project and
  cluster, so for upgrades the check is the plan's "state backend" line.
- **The agent's env belongs to the chart.** Since 0.26 the chart replaces entries added to the
  PlatformAgent's `spec.deployment.env`. The auto-PR and fold-in settings live in
  `TF_VAR_extra_helm_values`; `scripts/tune-agent.sh` only checks them.
- **Drift noise.** The apply runs under a person's account, so the drift detector files a triage card
  for each object it touches (13 after one apply). They fill the worker slots an incident needs:
  sweep with `scripts/archive-drift-cards.sh`, more than once.
- **Leftover failed pods.** The first upgrade left two failed `platform-agent-a2a-provision-*` attempts
  from while the bus restarted; the Job itself completed. Deleting the failed pods of a completed Job
  is safe.
- **The bus's server count.** New installs get three NATS servers (0.29 on). Until 0.34 an existing
  bus could not change its count (the operator reported `A2ABusConversionRefused`); since 0.34,
  changing `busReplicas` migrates it and keeps its data, freezing writes for a few minutes. Both
  installs still run one server: migrating is a decision, not part of an upgrade.
- **The console parses the bot's Slack messages**, so a release can move them: 0.24 edited the alert
  into its report, 0.31 posted a card first as its mark and step alone. Step 3e's console events
  catch this.
