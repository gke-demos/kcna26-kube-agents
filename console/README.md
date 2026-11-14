# fleet-scope

A live 3D view of a kube-agents fleet: every GKE cluster in a project as an island, each
workload drawn by health, kube-agents' own agents on the deck below, and a feed of what the
agents did, built from the Slack channel they post to and the GitOps repo they open pull requests
on. Built for the KubeCon NA 2026 demo (https://kcna26.demo.gke.ninja); a fork of
[substrate-scope](https://github.com/go-steer/substrate-scope).

This is a demo tool, not a supported kube-agents component. The limits below are real.

## Point it at your install

What it needs:

- a kube-agents install on GKE that posts to **Slack** (it reads the bot's messages; Google Chat
  installs get the fleet view but no alerts or triage);
- Application Default Credentials (locally) or a Workload Identity service account (in a
  cluster) with `roles/container.viewer` on the project whose clusters it draws;
- a Slack bot token that can read the channel's history (`channels:history`, `users:read`): the
  install's own bot token works;
- optionally a GitHub token for the GitOps repo, for pull request and audit events, and for the
  buttons (below).

Run it locally against your install:

```bash
printf '%s' "$SLACK_BOT_TOKEN" > /tmp/slack-token
go run ./cmd/fleet-scope \
  --project=<your-project> \
  --hub=<cluster running kube-agents> \
  --slack-channel=<home channel ID> \
  --slack-token-file=/tmp/slack-token \
  --repo=<owner/gitops-repo> --github-token-file=<file> \
  --dev-identity=you@example.com --writers=you@example.com
# open http://localhost:8080
```

The defaults for `--project`, `--hub`, `--slack-channel` and `--repo` are this demo's; override
all four, or you get a half-picture of someone else's fleet. `--dev-identity` skips sign-in, so
keep a local run on localhost. In a cluster, run it behind
Identity-Aware Proxy instead: [`deploy/`](deploy/) has the workload, the Gateway, the IAP
backend policy and the health check this demo uses (replace the project, host, certificate map and
accounts), and the server refuses any request that doesn't carry IAP's signed header. `--writers`
(emails or `domain:example.com`) decides who may press buttons; everyone IAP admits can watch.

`go run ./cmd/fleet-scope --help` lists every flag; each has a `SCOPE_*` environment variable
too.

## The Break something buttons

The buttons commit to `--repo` to cause an incident on purpose (squeeze a service's memory, roll
out a missing image tag, request more CPU than a node has) and to restore a `baseline` tag. They
are written for this demo's fleet repo: its `clusters/<cluster>/namespaces/<ns>/<service>.yaml`
layout and its Online Boutique and Bank of Anthos services. On any other repo they fail or do
nothing useful. They are on whenever a GitHub token is given; run with **`--actions=false`** to
make the console read-only, which is what you want against a real install. Every press is a commit
with a `Pressed-by: <email>` trailer.

With the buttons on, the console also resets the demo by itself once `clusters/` has been off the
baseline with no new commit for `--auto-reset` (default 30 minutes; `0` turns it off): someone
pressed a button and walked away. Any press, merge or reset restarts the clock. The reset is the
same as the button's, recorded as `Pressed-by: auto-reset` and shown in the feed.

`--auto-merge=DURATION` (env `SCOPE_AUTO_MERGE`; off by default) merges the agent's incident PRs,
branches `platform-agent/incident-*`, once they have been open that long, so an unstaffed booth
heals on its own. Audit PRs and anyone else's are left alone. Each merge carries
`Pressed-by: auto-merge` and shows in the feed and the tracker. Leave it off anywhere a person
should be the one who merges.

## Limits

- **Slack only.** Alerts, triage notes, reports and chosen fixes come from parsing the bot's Slack
  messages as kube-agents 0.23.0 to 0.31.0 format them (0.24 and later edit the alert into its report and each
  task card in place; 0.31 posts a card first as its mark and step alone); another release can change those
  formats. A console started after an alert was edited
  has no alert for that incident.
- **One project.** It draws the GKE clusters of `--project`; kube-agents scopes that span projects,
  folders or organizations are not followed.
- **kube-agents' agents are inferred.** The deck shows a Planning Agent, a Platform Agent and a
  Cluster Agent per cluster it can see, not the profiles the install actually runs.
- **GitHub only** for the GitOps repo.

## Develop

```bash
go test ./...
node --test web/js/*.test.js
go run ./cmd/fleet-scope --dev-identity=dev@localhost --web-dir=web ...   # serves web/ from disk
```

Open `http://localhost:8080/?synthetic=1` for a scripted fleet and incident with no backend at all.
