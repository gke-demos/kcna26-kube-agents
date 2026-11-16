# Upgrading kube-agents on the demo installs

How to move the demo's two kube-agents installs to a new release and prove they still work. Written
so an agent can follow it without other context: every step has the command, what to expect, and
when to stop. Always staging first, then prod.

**Stop and ask the person you work for** before step 4 (prod), and whenever a step says STOP. Do
not work around a refusal from a script here: each one guards against something that went wrong
before (see "What has gone wrong before").

## The two installs

|                               | Staging                                                          | Prod (the KubeCon demo)                                                                  |
| ----------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| GCP project                   | `gke-demos-345619` (shared with other demos)                     | `kcna-2026-demos`                                                                        |
| Hub cluster / kubectl context | `kube-agents-stg` (us-central1)                                  | `kube-agents-hub` (us-central1)                                                          |
| Workload clusters / contexts  | `boutique-stg` (us-central1-b)                                   | `boutique-prod`, `bank-prod` (us-central1-b); `autoscale-arcade` belongs to another demo |
| Fleet (GitOps) repo           | `gke-demos/kcna26-fleet-gitops-staging`                          | `gke-demos/kcna26-fleet-gitops`                                                          |
| Slack channel                 | `#platform-ops-staging` (C0CFAPAV3HD), app `kube-agents-staging` | `#platform-ops` (C0CEZ07K39N), app `kube-agents`                                         |
| Credentials and `install.env` | `~/.kcna26/staging/`                                             | `~/.kcna26/`                                                                             |
| Installer checkout            | `~/kcna26-staging/kube-agents`                                   | `~/kube-agents`                                                                          |
| Console (fleet-scope)         | port-forward only (`--dev`)                                      | https://kcna26.demo.gke.ninja behind IAP                                                 |

Both run `spec.mode: next`, Gemini 3.8 Flash on Vertex AI, and one NATS bus server. The current
release is in `scripts/upgrade.sh` (`DEFAULT_RELEASE`) and the RUNBOOK's "Installed:" line.

## 0. Prerequisites

Run from the root of this repository. Check each line before going on:

```bash
gcloud auth list --filter=status:ACTIVE --format='value(account)'   # garisingh@gke.ninja
gcloud config configurations list --format='value(name)' | grep -x kcna26   # prod's config
gh auth status                       # write access to the two fleet repos (PRs are merged)
for f in install.env slack-bot-token github-pat; do test -s ~/.kcna26/$f && echo "prod $f ok"; done
for f in install.env slack-bot-token github-pat; do test -s ~/.kcna26/staging/$f && echo "staging $f ok"; done
kubectl config get-contexts -o name | grep -E '^(kube-agents-hub|boutique-prod|bank-prod|kube-agents-stg|boutique-stg)$'
command -v terraform jq node docker >/dev/null && echo tools ok
```

Missing contexts: `scripts/contexts.sh kcna-2026-demos` creates prod's. Staging's:

```bash
for c in "kube-agents-stg --region us-central1" "boutique-stg --zone us-central1-b"; do
  set -- $c
  gcloud container clusters get-credentials "$1" "$2" "$3" --project gke-demos-345619
  kubectl config rename-context "gke_gke-demos-345619_$3_$1" "$1"
done
```

Then confirm both installs are healthy on the release they run now, before changing anything:

```bash
scripts/verify-install.sh staging <CURRENT>
scripts/verify-install.sh prod <CURRENT>
```

STOP if either fails: fix that first; an upgrade on top of a broken install hides the cause.

## 1. Review the release

```bash
gh release list -R gke-labs/kube-agents --limit 8
python3 -I tools/release_notes.py <each release after CURRENT, up to TARGET>
```

The script prints the entries an install can see, the entries marked breaking, and the upgrade
page's breaking-change rows for those releases. Read all of it, then:

- **Every upgrade-page row**: does it apply to a `next` install on GKE Autopilot with Slack? A row
  that names a setting this demo sets (agent env, scope, bus, model, Slack) needs action before
  the upgrade. Example: 0.26 replaced hand-added PlatformAgent env, so the agent's settings moved
  to chart values first.
- **Entries touching** the Slack messages (`gateway`, `slack`, `chat`, `a2a`), incidents
  (`incident-triage`, `event-watcher`, `kanban`), audits (`fleet-audit`), fix PRs (`platform`,
  `submit-suggestion`, `gitops`), the installer or the chart: open the PR (`gh pr view <n> -R
gke-labs/kube-agents`) when the title leaves the effect on this demo unclear.

Write down what you expect to change for this demo. STOP and ask if a change needs a decision
(a new default worth overriding, a setting to add) rather than a check.

## 2. Prepare

```bash
TARGET=<release, e.g. 0.33.0>
gh api -H 'Accept: application/vnd.github.raw' \
  "repos/gke-labs/kube-agents/contents/upgrade.sh?ref=$TARGET" > ~/.kcna26/upgrade-$TARGET.sh
gh api -H 'Accept: application/vnd.github.raw' \
  "repos/gke-labs/kube-agents/contents/install.sh?ref=$TARGET" > ~/.kcna26/install-$TARGET.sh
cp ~/.kcna26/install-$TARGET.sh ~/.kcna26/staging/
chmod 600 ~/.kcna26/*.sh ~/.kcna26/staging/*.sh
grep -m1 '^BAKED_RELEASE_VERSION=' ~/.kcna26/upgrade-$TARGET.sh    # must print $TARGET
mkdir -p ~/.kcna26/backup-$TARGET
kubectl --context kube-agents-hub -n kubeagents-system get platformagent platform-agent -o yaml \
  > ~/.kcna26/backup-$TARGET/prod-platformagent.yaml
kubectl --context kube-agents-stg -n kubeagents-system get platformagent platform-agent -o yaml \
  > ~/.kcna26/backup-$TARGET/staging-platformagent.yaml
cp ~/.kcna26/install.env ~/.kcna26/backup-$TARGET/prod-install.env
cp ~/.kcna26/staging/install.env ~/.kcna26/backup-$TARGET/staging-install.env
chmod -R go-rwx ~/.kcna26/backup-$TARGET
```

## 3. Staging

**3a. Refresh staging's cluster exclusions.** Staging shares its project with other demos'
clusters, and excludes every cluster but its own two. If another demo added a cluster since the
last run, the upgrade would let staging adopt it:

```bash
gcloud container clusters list --project gke-demos-345619 --format='value(name)' | sort > /tmp/now
grep '^SCOPE_EXCLUDE_CLUSTERS=' ~/.kcna26/staging/install.env | cut -d= -f2 | tr ',' '\n' \
  | awk -F/ '{print $3}' | sort > /tmp/excluded
comm -23 /tmp/now /tmp/excluded      # must print exactly: boutique-stg, kube-agents-stg
```

If it prints anything else, rewrite the list: delete the `SCOPE_EXCLUDE_CLUSTERS=` line from
`~/.kcna26/staging/install.env` and add the new one in the same `project/location/cluster,…`
form (`scripts/install-staging.sh` builds it the same way), then re-run the check.

**3b. Plan.**

```bash
RELEASE=$TARGET scripts/upgrade.sh staging --plan 2>&1 | tee /tmp/stg-plan.log | tail -5
sed 's/\x1b\[[0-9;]*m//g' /tmp/stg-plan.log | grep -E 'Target Image|GKE Target|state backend|Plan:|will be|must be'
```

Exit code 2 means there are changes (normal); 1 means the plan failed. Read it as "Reading the plan"
below says. The backend must be `gs://gke-demos-345619-kube-agents-tfstate/kube-agents/kube-agents-stg`.

**3c. Apply.**

```bash
RELEASE=$TARGET scripts/upgrade.sh staging 2>&1 | tee /tmp/stg-apply.log | tail -8
```

Expect `Apply complete!` with the same counts as the plan, and `Upgrade Complete!`. The chat setup
checklist it prints afterwards is the installer's generic reminder; nothing in it is new.

**3d. Verify.**

```bash
scripts/archive-drift-cards.sh kube-agents-stg
scripts/verify-install.sh staging $TARGET
```

Every line must be `ok`. A `note` names an advisory condition: read its message
(`kubectl --context kube-agents-stg -n kubeagents-system get platformagent platform-agent -o yaml`)
and decide whether it needs an `install.env` setting, as `ScopeUndeclared` did (`SCOPE_PROJECTS`).
`Ready=False` right after an apply is the rollout; re-run a minute later.

**3e. Rehearse an incident.**

```bash
scripts/rehearse.sh staging frontend      # or checkoutservice, productcatalogservice
```

It presses the console's "Roll out a missing image tag" button, waits for the agent's fix PR,
prints its diff, merges it, waits for the rollout, prints the timings, then the events the console
recorded. Pass: a one-line image revert, healthy within about 5 minutes of the press, and console
events in this order, every one keyed `boutique-stg/<workload>`: `action`, `alert`, `triage` notes,
`triage_report`, `pr_opened`, `pr_merged`. Use a workload that has not broken in the last 15
minutes, or the alert folds into that incident and no PR opens.

STOP if no PR opens: read `#platform-ops-staging` and the board (`kubectl --context kube-agents-stg
-n kubeagents-system exec deploy/platform-agent-gateway -c platform-agent -- env
HERMES_HOME=/opt/data/profiles/platform hermes kanban list`).

**3f. If the console's events are wrong** (a missing `triage_report`, notes read as `chat`, events
without a key), the release changed the bot's Slack messages. Capture the thread
(`conversations.replies` with the staging bot token in `~/.kcna26/staging/slack-bot-token`), fix
`console/internal/signals/` with a test built from the real message, run `go test ./...` and
`node --test web/js/*.test.js` in `console/`, commit, then:

```bash
scripts/console.sh build                  # prints the image tag
HUB_CONTEXT=kube-agents-stg CRED_DIR=~/.kcna26/staging \
  CONSOLE_MANIFEST=console/deploy/fleet-scope-staging.yaml scripts/console.sh deploy --dev <TAG>
```

and repeat 3e on another workload until it passes.

**3g. Clean up staging.**

```bash
FLEET_REPO=gke-demos/kcna26-fleet-gitops-staging scripts/reset.sh
scripts/archive-drift-cards.sh kube-agents-stg
```

## 4. Prod

STOP: report the staging results (plan counts, verification, rehearsal timings, console changes)
and get a go-ahead for prod.

**4a. Plan, apply, verify** as for staging, with `prod` in place of `staging`:

```bash
RELEASE=$TARGET scripts/upgrade.sh prod --plan 2>&1 | tee /tmp/prod-plan.log | tail -5
RELEASE=$TARGET scripts/upgrade.sh prod 2>&1 | tee /tmp/prod-apply.log | tail -8
scripts/archive-drift-cards.sh kube-agents-hub
scripts/verify-install.sh prod $TARGET
```

The backend must be `gs://kcna-2026-demos-kube-agents-tfstate/kube-agents/kube-agents-hub`, and
the plan should have the same shape as staging's. STOP on anything staging's plan did not have.

**4b. Console.** If 3f changed the console, deploy the same tag to prod (IAP, not `--dev`):

```bash
scripts/console.sh deploy <TAG>
curl -s -o /dev/null -w '%{http_code}\n' https://kcna26.demo.gke.ninja/    # 302: IAP sign-in
```

A deploy turns booth mode off; that is intended.

**4c. Rehearse.** Drift triage cards from the apply hold the worker slots an incident needs, so
sweep again first:

```bash
scripts/archive-drift-cards.sh kube-agents-hub
scripts/rehearse.sh prod productcatalogservice   # or frontend, checkoutservice
```

Pass: a one-line revert merged and the workload healthy within about 6 minutes. (The prod console
is behind IAP, so the script prints no console events for prod.)

**4d. Clean up prod.**

```bash
scripts/reset.sh                              # clusters/ back to the baseline tag
scripts/archive-drift-cards.sh kube-agents-hub   # drift cards keep arriving for a few minutes
python3 -I tools/clear_channel.py --keep audit   # the bot's posts, except the audit cards
scripts/preflight.sh
```

The preflight's audit-freshness check fails while the install is idle (see "Audits on an idle
install"); every other line must be `ok`.

## 5. Record

1. Pin the release: `RELEASE="$TARGET"` in `scripts/install-hub.sh` and `scripts/install-staging.sh`,
   `DEFAULT_RELEASE="$TARGET"` in `scripts/upgrade.sh`.
2. RUNBOOK: add `$TARGET` and the date to the "Installed:" line; add anything the release changed
   about running the demo.
3. FOLLOWUPS: one checked item with the date, the plan counts and both rehearsals' timings, and
   open items for anything deferred.
4. Commit (`chore: both installs run kube-agents <TARGET>`) and push to `main`.

## Verifying the whole demo

The rehearsal covers the live incident path. Before a show, or after a release that touched audits
or chat, also check on prod:

- **Audits**: run the two the talk uses by hand, then confirm each rewrote its existing ledger
  issue (same number) and kept the open fix PRs:
  ```bash
  for job in compliance-audit obtainability-audit; do
    kubectl --context kube-agents-hub -n kubeagents-system exec deploy/platform-agent-gateway \
      -c platform-agent -- env HERMES_HOME=/opt/data/profiles/platform hermes cron run "$job"
  done
  gh issue list -R gke-demos/kcna26-fleet-gitops --label agent:audit --state open
  gh pr list -R gke-demos/kcna26-fleet-gitops --state open
  ```
  Each audit takes 10–20 minutes. Check the cards they post in `#platform-ops`.
- **The other incidents**: `scripts/trigger-oom.sh emailservice` (alerts after about 6 minutes),
  the console's "Make a service unschedulable" and "Reset the demo" buttons.
- **Chat**: the RUNBOOK's two talk prompts, sent by a person in `#platform-ops`. The bot token
  cannot post as a person.
- **Booth mode**: `scripts/console.sh booth on 60s`, rehearse once and confirm the PR merges by
  itself, then `scripts/console.sh booth off`.

## Reading the plan

| In the plan                                                                              | Meaning                                 | Action           |
| ---------------------------------------------------------------------------------------- | --------------------------------------- | ---------------- |
| `helm_release.kube_agents will be updated in-place`                                      | The upgrade itself                      | Expected         |
| `helm_release.cert_manager[0] … in-place`                                                | The chart bumped cert-manager           | Expected         |
| Minter `google_kms_crypto_key` / `google_service_account` in-place (labels, description) | Per-install ownership markers (0.28 on) | Expected         |
| `google_logging_project_sink.drift_audit` in-place (filter)                              | Drift detector filter changed           | Expected on prod |
| Any `will be destroyed` or `must be replaced`                                            | Something leaves the install            | STOP; see below  |
| Resources in the other install's project, or the other install's backend                 | Wrong state                             | STOP             |

A destroy has so far always meant a setting missing from `install.env`. Find which variable the
resource depends on, add it to `install.env`, and plan again. Never apply a plan with a destroy you
cannot explain.

## Audits on an idle install

kube-agents 0.26 and later slow every model-run scheduled job (the audits) to weekly after 7 days
with no chat message from a person, and stop them after 14. A chat message to the agent wakes the
schedule; `hermes cron run` is never held. So a quiet install's audits go stale on purpose, and the
preflight's freshness check fails. Before a show, run them by hand (above, and RUNBOOK section 2).

## Rollback

Not rehearsed. kube-agents' path back is the previous release's `upgrade.sh` against the same
`install.env` (`RELEASE=<previous> scripts/upgrade.sh …`, plan first). It stops before applying
when the move undoes a breaking change and names the commits; ask before re-running it with
`--allow-breaking-downgrade`. The backups from step 2 hold the PlatformAgent and `install.env` as
they were. The NATS bus is not rolled back by this; the site's rollback page
(https://gke-labs.github.io/kube-agents/deploy/rollback/) is canonical.

## What has gone wrong before

- **Settings passed only as installer flags are lost.** The release's `upgrade.sh` re-renders the
  install from `install.env` alone. A missing `MODEL_PROVIDER` planned the destruction of the
  Vertex AI gateway's identity (2026-11-07); missing `SCOPE_EXCLUDE_CLUSTERS` let staging adopt all
  20 clusters in gke-demos-345619 for a week (2026-11-07 to 11-14). `scripts/upgrade.sh` now
  refuses an `install.env` without `MODEL_PROVIDER`, `VERTEX_LOCATION`, `MODEL_DEFAULT_NAME`,
  `SCOPE_PROJECTS`, `TF_VAR_extra_helm_values` and, for staging, `SCOPE_EXCLUDE_CLUSTERS`.
- **One installer checkout per install.** The installer keeps its Terraform backend in its
  checkout. A staging dry run from prod's `~/kube-agents` planned prod's state for replacement.
  `scripts/upgrade.sh` runs each install from its own checkout and refuses a checkout whose backend
  names the other install. Never run kube-agents' `install.sh` or `upgrade.sh` by hand from `$HOME`
  for staging.
- **The agent's env belongs to the chart.** Since 0.26 the chart replaces entries added to the
  PlatformAgent's `spec.deployment.env`. The auto-PR and fold-in settings live in
  `TF_VAR_extra_helm_values`; `scripts/tune-agent.sh` only checks them.
- **Drift noise.** The apply runs under a person's account, so the drift detector files a triage
  card for each object it touches (13 after one apply). They fill the worker slots an incident
  needs: sweep with `scripts/archive-drift-cards.sh`, more than once.
- **Leftover failed pods.** The first upgrade left two failed `platform-agent-a2a-provision-*`
  attempts from while the bus restarted; the Job itself completed. Deleting the failed pods of a
  completed Job is safe.
- **The bus keeps its server count.** New installs get three NATS servers (0.29 on); an existing
  bus cannot change its count. Setting `busReplicas` does not convert it (the operator reports
  `A2ABusConversionRefused`).
- **The console parses the bot's Slack messages**, so a release can move them: 0.24 edited the
  alert into its report, 0.31 posted a card first as its mark and step alone. Step 3e's console
  events catch this.
