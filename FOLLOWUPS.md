# Follow-ups

Open work before KubeCon NA 2026. The first full run-through is due **Wed 11/4**; Thursday and
Friday are for re-runs and recording. Strike items through as they close.

## Gari

- [x] ~~Create the console's GitHub fine-grained PAT: repository `gke-demos/kcna26-fleet-gitops`
      only; Contents read/write, Pull requests read/write, Issues read, Metadata read. Save it as
      `~/.kcna26/github-pat`.
- [x] ~~Create the console's IAP OAuth client: Google Auth Platform in kcna-2026-demos, audience
      External (so gke.ninja accounts can sign in), Clients → Web application, redirect URI
      `https://iap.googleapis.com/v1/oauth/clientIds/<CLIENT_ID>:handleRedirect` (add it once the
      ID exists). Save the ID and secret as `~/.kcna26/oauth-client-id` and
      `~/.kcna26/oauth-client-secret`.
- [x] ~~Say go on the compliance and obtainability audits~~: run before the show; their ledgers are #3 and #4.
- [x] ~~Get the compute demo cluster created~~: `autoscale-arcade` joined kcna-2026-demos by 2026-11-14;
      kube-agents 0.24+ watches it without a restart.
- [ ] First full run-through in Slack per RUNBOOK §3–4; fill the timings in `prompts.md`.
- [ ] Record a backup clip per live segment (audit card and issue, alert → PR → merge, one prompt).
- [ ] Build the deck from `slides/`, with the backup clips in the demo slot.
- [ ] Booth: who staffs it and their Slack member IDs and Google accounts (allowlist and IAP),
      laptop, phone hotspot.
- [ ] Who is Slack member `U0CE89JDMQC` in `#platform-ops`? Allowlist or remove.
- [ ] Decide whether `kcna26-kube-agents` goes public.
- [x] ~~Say when Claude may clear `#platform-ops`~~: Gari asked for it repeatedly; clearing the bot's posts
      but the audit cards (`tools/clear_channel.py --keep audit`) is now a routine step after rehearsals
      and upgrades (UPGRADING.md 4d).

- [ ] Publish the console's OAuth app (Google Auth Platform → Audience → Publish app) so google.com
      and event.goog accounts can sign in.

## Claude

- [ ] Run the compliance and obtainability audits; check they open fix PRs for the
      `cluster-admin` binding and the `frontend` PDB.
- [ ] Clear `#platform-ops` (`tools/clear_channel.py --keep audit`) and keep the agent board idle.
- [ ] Re-run the audits the night before each show day.
- [x] ~~Booth video~~: narrated 2.5-min walkthrough recorded headlessly (`video/`), in
      `gs://kcna-2026-demos-media/video/2026-11-03/` (readable by google.com, the demo accounts and
      garisingh@gke.ninja; open with https://storage.cloud.google.com/kcna-2026-demos-media/video/2026-11-03/fleet-scope-walkthrough-narrated.mp4).
      Booth laptops keep an offline copy: `gcloud storage cp gs://kcna-2026-demos-media/video/2026-11-03/*.mp4 .`
- [x] ~~The 3D console~~: live at https://kcna26.demo.gke.ninja behind IAP (google.com, every
      event.goog account, granted as its Workspace's primary domain `ett.goog`, garisingh@gke.ninja). Buttons: all of google.com, all of
      event.goog and garisingh@gke.ninja (`SCOPE_WRITERS` in `console/deploy/fleet-scope.yaml`).
- [x] ~~kube-agents 0.25.0~~: tried on a staging install (`kube-agents-stg` + `boutique-stg` in
      gke-demos-345619, `scripts/install-staging.sh`, `terraform/staging/`, its own Slack app and repo
      `kcna26-fleet-gitops-staging`), then kube-agents-hub upgraded in place on 2026-11-07. Prod
      rehearsals after the upgrade: bad image trigger → healthy in 4:21, OOM in 11:00. The console
      reads 0.25's alert-edited-into-report threads.
- [x] ~~Staging~~: kept for testing future upgrades before kube-agents-hub takes them. It shares the
      minter and LiteLLM Workload Identity principals with kube-agents-host (accepted). Its scheduled
      audits scan all of gke-demos-345619; the first runs at install cost about $20 in tokens, and
      after that it idles at a few dollars a day (0.26 on: audits slow to weekly after 7 days with
      no chat message, and stop after 14). To retire it: `terraform/staging` destroy, then the
      installer's uninstall for `kube-agents-stg` (its key rings stay; they cannot be deleted).
- [x] ~~kube-agents 0.31.0~~ on 2026-11-14, staging then prod (`scripts/upgrade.sh`). The agent's
      settings moved to chart values (`TF_VAR_extra_helm_values`): 0.26 replaces hand-added
      PlatformAgent env. Staging rehearsal: bad image → PR in 2:03, healthy in 3:12. The console
      reads 0.31's new first card post. The compute demo cluster (`autoscale-arcade`) joined
      kcna-2026-demos and has a Cluster Agent.
- [x] ~~kube-agents 0.33.0~~ on 2026-11-16, staging then prod. Rehearsals: staging PR in 2:23 and
      healthy in 3:02; prod 3:47 and 4:11 (its board was busy with drift and `autoscale-arcade`
      triages). Both installs now name their own project in `spec.scope.projects` (0.28 flags an
      implied scope).
- [ ] Prod watches the compute demo cluster `autoscale-arcade` and triages its failures into
      `#platform-ops` (it refuses the PRs: the fleet repo does not declare that cluster). Exclude it
      if the noise matters.
- [x] ~~Staging's scope~~: `install-staging.sh` passed its cluster exclusions as a flag only, so the
      first `upgrade.sh` run (2026-11-07) dropped them and staging covered all 20 clusters in
      gke-demos-345619 until 2026-11-14 (about 140 triages, mostly `ap-iap-testing`; no PRs: the
      agent refuses a workload its GitOps repo does not declare). Now in `install.env`, rewritten
      on every `install-staging.sh` run.
- [ ] Bus HA: since 0.34, changing `busReplicas` from 1 to 3 migrates an existing bus and keeps its data
      (writes freeze for a few minutes). Decide whether to migrate staging, then prod.
- [x] ~~kube-agents 0.35.0~~ on 2026-11-20, the first upgrade run strictly by UPGRADING.md (by the hourly
      watch, then Gari's go-ahead for prod). Plans: 0/1/0 on both. Rehearsals: staging PR 2:51, healthy 3:19;
      prod PR 3:20, healthy 3:34. Step 0 first stopped on a cluster staging had adopted (`substrate-live`);
      verify-install now notes that instead (2f490b5). Notes: ~/projects/scratch/kcna26-upgrade-0.35.0.notes.md.
- [x] ~~kube-agents 0.41.0~~ on 2026-11-26: staging 0.39.0 → 0.41.0, prod 0.35.0 → 0.41.0. Plans: 0/1/0 on both.
      Rehearsals: staging PR 3:10, healthy 3:45; prod PR 2:01, healthy 2:32. The 0.39.0 watch run stopped at 3d on
      `ProfileSupervisorForm=True` (the 0.37 latch, healthy), and its pin wasn't moved, which blocked the next two
      runs: pins now move at 3c/4b, verify-install prints known-healthy conditions as `info` (13fae84, e43c1d0).
      Notes: ~/projects/scratch/kcna26-upgrade-0.41.0.notes.md.
- [ ] `tools/clear_channel.py --keep audit` keeps every daily audit card and any drift alert whose text
      says "audit" (37 kept on 2026-11-20): keep only the newest card per audit stream.
- [ ] File the upstream kube-agents issues below once Gari agrees.

## Fixed on the way

- Bank of Anthos `contacts` OOM-killed itself under the load generator at upstream's 128Mi
  (31 restarts); `contacts` and `frontend` now get 256Mi in the baseline (tag moved).
- `trigger-badimage.sh` pushed `v0.10.700` on a second press; it now refuses.

## Upstream kube-agents issues found during the build

- A non-interactive install with only `--slack-bot-token`/`--slack-app-token` turns chat off;
  `--enable-slack` is needed and the Slack app guide does not mention it.
- The installer's KMS-key adoption runs `terraform import`, which fails while the state still
  holds a deleted cluster that has no endpoint; Terraform then hits `409 already exists`.
- After a restart, the event watcher alerts on the `kube-system` startup events it replays.
- Noise cards fill the background worker slots and queue a real incident's triage behind them.
