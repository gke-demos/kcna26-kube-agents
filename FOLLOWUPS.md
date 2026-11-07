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
- [ ] Say go on the compliance and obtainability audits.
- [ ] Get the compute demo cluster created in kcna-2026-demos and tell Claude (the agent pod needs
      one restart to watch it).
- [ ] First full run-through in Slack per RUNBOOK §3–4; fill the timings in `prompts.md`.
- [ ] Record a backup clip per live segment (audit card and issue, alert → PR → merge, one prompt).
- [ ] Build the deck from `slides/`, with the backup clips in the demo slot.
- [ ] Booth: who staffs it and their Slack member IDs and Google accounts (allowlist and IAP),
      laptop, phone hotspot.
- [ ] Who is Slack member `U0CE89JDMQC` in `#platform-ops`? Allowlist or remove.
- [ ] Decide whether `kcna26-kube-agents` goes public.
- [ ] Say when Claude may clear `#platform-ops`. (Deploying the console raises drift alerts: clear after
      the last deploy.)

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
      after that it idles at a few dollars a day. To retire it: `terraform/staging` destroy, then
      the installer's uninstall for `kube-agents-stg` (its key rings stay; they cannot be deleted).
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
