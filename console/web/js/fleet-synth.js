// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// ?synthetic=1: the demo fleet without a backend. Three GKE clusters as
// districts, their workloads as "agents", kube-agents' own agents as the
// worker deck, and a scripted incident every minute (OOMKilled -> alert ->
// triage -> report -> fix chosen -> PR opened -> merged -> healthy). It
// speaks the Stream interface (snapshot, then event batches) and fakes the
// action buttons' API, so any static file server can serve web/.

/** The fleet: cluster -> namespace, workloads (StatefulSets marked). */
export const FLEET = {
  'kube-agents-hub': {
    namespace: 'kubeagents-system',
    workloads: ['platform-agent-gateway', 'a2a-gateway', 'a2a-nats', 'litellm', 'github-token-minter', 'credential-proxy', 'controller-manager', 'a2a-console'],
    stateful: ['a2a-nats'],
    image: (n) => `us-docker.pkg.dev/kube-agents/images/${n}:v0.9.2`,
  },
  'boutique-prod': {
    namespace: 'boutique',
    workloads: ['adservice', 'cartservice', 'checkoutservice', 'currencyservice', 'emailservice', 'frontend', 'loadgenerator', 'paymentservice', 'productcatalogservice', 'recommendationservice', 'redis-cart', 'shippingservice'],
    stateful: [],
    image: (n) => (n === 'redis-cart' ? 'redis:7.4-alpine' : `us-central1-docker.pkg.dev/google-samples/microservices-demo/${n}:v0.10.3`),
  },
  'bank-prod': {
    namespace: 'bank-of-anthos',
    workloads: ['accounts-db', 'balancereader', 'contacts', 'frontend', 'ledger-db', 'ledgerwriter', 'loadgenerator', 'transactionhistory', 'userservice'],
    stateful: ['accounts-db', 'ledger-db'],
    image: (n) => `us-central1-docker.pkg.dev/bank-of-anthos-ci/bank-of-anthos/${n}:v0.6.7`,
  },
};

/** kube-agents' own agents (the worker deck). */
export const AGENT_POOL = 'kube-agents';
export const clusterAgent = (cluster) => `cluster-agent-${cluster}`;

const SLACK = 'https://example.slack.com/archives/C0CEZ07K39N';
const REPO = 'https://github.com/gke-demos/kcna26-fleet-gitops';
export const LINKS = [
  { name: 'Slack #platform-ops', url: SLACK },
  { name: 'Fleet repo', url: REPO },
  { name: 'Online Boutique', url: 'https://boutique.example.com' },
  { name: 'Bank of Anthos', url: 'https://bank.example.com' },
];

/** The cluster kube-agents runs on (no Config Sync). */
const HUB = 'kube-agents-hub';
/** The fleet repo commit the clusters start on. */
const BASELINE_COMMIT = '5d0b1f2c9e8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c';

/** Seconds between scripted incidents. */
export const INCIDENT_EVERY = 60;
/** The scripted incident's target. */
export const INCIDENT_KEY = 'boutique-prod/recommendationservice';

const MEMORY = { recommendationservice: '220Mi', cartservice: '128Mi', frontend: '128Mi', 'redis-cart': '256Mi', 'ledger-db': '1Gi', 'accounts-db': '512Mi', litellm: '2Gi' };

/** A Slack permalink for a message ts ("1762160000.000100"), in a thread when given. */
export function slackLink(ts, thread) {
  const p = `${SLACK}/p${ts.replace('.', '')}`;
  return thread && thread !== ts ? `${p}?thread_ts=${thread}&cid=C0CEZ07K39N` : p;
}

/** Who posts the Slack messages (the backend's actor for the bot), and who presses the buttons. */
const BOT = 'kube-agents';
const ONCALL = 'sre-oncall';
const CONSOLE_GKE = 'https://console.cloud.google.com/kubernetes/workload/overview?project=kcna-2026-demos';
// Slack escapes & in message text as &amp;.
const CONSOLE_LOGS = 'https://console.cloud.google.com/logs/query;query=resource.type%3D%22k8s_container%22&amp;project=kcna-2026-demos';
const FENCE = '```';

/** UTC "18:03" for a report's "State at". */
function utcClock(ms = Date.now()) {
  return new Date(ms).toISOString().slice(11, 16);
}

function evidenceTime() {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
}

/** The Cluster Agent's report for an OOMKilled workload, in Slack mrkdwn (as the real one is written). */
export function oomReport({ name, ns, pod, limit, raised }) {
  const now = evidenceTime();
  return [
    "*What's wrong*",
    `State at ${utcClock()} UTC: The ${name} pod ${ns}/${pod} is in CrashLoopBackOff: its server container is OOM-killed (exit code 137) on every start.`,
    '*Why*',
    `• Memory peaks at ${limit} against a ${limit} limit before each restart; the image has not changed since Tuesday.`,
    '• Traffic from `loadgenerator` is up 3x, so the working set grew past the limit.',
    '*What to do*',
    `• *Option A (Scale to 2 replicas):* Spread the load over two pods at the current ${limit} limit.`,
    `• *Option B (Increase to ${raised} with headroom):* Raise the ${name} memory requests and limits to ${raised}.`,
    `• :white_check_mark: *Recommended: Option B* — doubling the limit gives headroom for the traffic spike; a second replica at ${limit} would still OOM at peak.`,
    "• *To authorize:* reply *'apply'* to open a GitOps Pull Request with the recommended fix, or name one directly with *'apply Option A'* / *'apply Option B'*.",
    `:link: <${CONSOLE_GKE}|GKE Workloads> | <${CONSOLE_LOGS}|Cloud Logs>`,
    '*Evidence for verified claims*',
    `The pod ${pod} is in CrashLoopBackOff state. (exit 0, ${now})`,
    `${FENCE}$ kubectl get pod ${pod} -n ${ns}\nNAME${' '.repeat(pod.length - 1)}READY   STATUS             RESTARTS\n${pod}   0/1     CrashLoopBackOff   4${FENCE}`,
    `The container server was terminated because it was OOMKilled with exit code 137. (exit 0, ${now})`,
    `${FENCE}$ kubectl get pod ${pod} -n ${ns} -o jsonpath='{.status.containerStatuses[0].lastState.terminated.reason}'\nOOMKilled${FENCE}`,
    `The last healthy pod used memory right up to the limit. (exit 0, ${now})`,
    `${FENCE}$ kubectl top pod -n ${ns} -l app=${name}\n${name}-556b7d9948-l72m2   12m   ${limit}${FENCE}`,
  ].join('\n');
}

/** The report for a bad image tag. */
export function imageReport({ name, ns, pod, badImage, good }) {
  const now = evidenceTime();
  return [
    "*What's wrong*",
    `State at ${utcClock()} UTC: The ${name} pod ${ns}/${pod} is in ImagePullBackOff: the image \`${badImage}\` does not exist.`,
    '*Why*',
    '• The image tag changed 4 minutes ago in the fleet repo (commit `9f2c1ab`); the registry answers `manifest unknown` for it.',
    '*What to do*',
    '• *Option A (Revert to the last good tag):* Revert the image to the tag that was running before commit `9f2c1ab`.',
    '• *Option B (Pin the image digest):* Pin the last good image by its digest so a moved tag cannot break it again.',
    '• :white_check_mark: *Recommended: Option A* — the revert is the smallest change that restores the last known-good state.',
    "• *To authorize:* reply *'apply'* to open a GitOps Pull Request with the recommended fix, or name one directly with *'apply Option A'* / *'apply Option B'*.",
    `:link: <${CONSOLE_GKE}|GKE Workloads> | <${CONSOLE_LOGS}|Cloud Logs>`,
    '*Evidence for verified claims*',
    `The pod cannot pull its image. (exit 0, ${now})`,
    `${FENCE}$ kubectl get pod ${pod} -n ${ns} -o jsonpath='{.status.containerStatuses[0].state.waiting.message}'\nBack-off pulling image "${badImage}"${FENCE}`,
    `The last good image: \`${good}\``,
  ].join('\n');
}

/** The report for pods no node can fit. */
export function unschedReport({ name, ns, pod }) {
  const now = evidenceTime();
  return [
    "*What's wrong*",
    `State at ${utcClock()} UTC: The ${name} pod ${ns}/${pod} is Pending: it requests 32 CPUs and no node in the pool can fit it.`,
    '*Why*',
    '• The CPU request went from `100m` to `32` in the fleet repo a few minutes ago; the largest node has 8 allocatable CPUs.',
    '*What to do*',
    '• *Option A (Revert the CPU request to 100m):* Put the request back to the value that ran before the change.',
    '• *Option B (Add a 32-CPU node pool):* Add a node pool big enough for the new request.',
    '• :white_check_mark: *Recommended: Option A* — the revert restores the last known-good state; nothing in the service needs 32 CPUs.',
    "• *To authorize:* reply *'apply'* to open a GitOps Pull Request with the recommended fix, or name one directly with *'apply Option A'* / *'apply Option B'*.",
    `:link: <${CONSOLE_GKE}|GKE Workloads> | <${CONSOLE_LOGS}|Cloud Logs>`,
    '*Evidence for verified claims*',
    `The pod cannot be scheduled. (exit 0, ${now})`,
    `${FENCE}$ kubectl get events -n ${ns} --field-selector involvedObject.name=${pod}\nWarning  FailedScheduling  0/3 nodes are available: 3 Insufficient cpu.${FENCE}`,
  ].join('\n');
}

function slackTs(ms) {
  return `${Math.floor(ms / 1000)}.${String(ms % 1000).padStart(3, '0')}100`;
}

/** The fleet's snapshot at time now (ms). */
export function fleetSnapshot(now = Date.now()) {
  const iso = (ms) => new Date(ms).toISOString();
  const atespaces = [];
  const agents = [];
  for (const [cluster, c] of Object.entries(FLEET)) {
    // The workload clusters run Config Sync on the fleet repo; the hub does not.
    atespaces.push(cluster === HUB ? { name: cluster } : { name: cluster, syncCommit: BASELINE_COMMIT });
    for (const name of c.workloads) {
      const replicas = name === 'frontend' || name === 'a2a-gateway' ? 2 : 1;
      agents.push({
        atespace: cluster,
        name,
        state: 'RUNNING',
        kind: c.stateful.includes(name) ? 'StatefulSet' : 'Deployment',
        namespace: c.namespace,
        replicas,
        ready: replicas,
        image: c.image(name),
        memoryLimit: MEMORY[name] || '256Mi',
        worker: clusterAgent(cluster),
        workerPool: AGENT_POOL,
        stateSince: iso(now - 3600e3 - (name.length % 7) * 600e3),
        createTime: iso(now - 6 * 86400e3),
      });
    }
  }
  const workers = ['planning-agent', 'platform-agent', ...Object.keys(FLEET).map(clusterAgent)].map((name) => ({
    name,
    pod: name,
    pool: AGENT_POOL,
    namespace: 'kubeagents-system',
    state: 'ACTIVE',
    capacityActors: 0,
    allocatedActors: agents.filter((a) => a.worker === name).length,
    actors: agents.filter((a) => a.worker === name).map((a) => `${a.atespace}/${a.name}`),
  }));
  const audit = now - 9 * 3600e3;
  const recent = [
    {
      seq: 1,
      time: iso(audit),
      type: 'audit',
      cluster: 'bank-prod',
      title: 'Nightly fleet audit: 2 findings on bank-prod (ledger-db has no PodDisruptionBudget)',
      link: 'https://github.com/gke-demos/kcna26-fleet-gitops/issues/7',
      actor: 'platform-agent',
    },
    {
      seq: 2,
      time: iso(audit + 4 * 60e3),
      type: 'audit',
      key: 'bank-prod/ledger-db',
      cluster: 'bank-prod',
      title: 'Audit fix: add a PodDisruptionBudget for ledger-db',
      link: `${REPO}/pull/6`,
      actor: 'platform-agent',
    },
  ];
  return {
    cluster: 'kcna-2026-demos fleet',
    source: 'synthetic',
    seq: 2,
    time: iso(now),
    features: { actions: true, links: LINKS },
    sources: [],
    atespaces,
    agents,
    workers,
    recent,
  };
}

/** The actions the console's buttons offer (GET api/actions), named as the backend names them. */
export function fleetActions() {
  return [
    { name: 'trigger-oom', title: 'Cause an OOMKill', targets: ['recommendationservice', 'cartservice', 'currencyservice'] },
    { name: 'trigger-badimage', title: 'Push a bad image', targets: ['frontend', 'checkoutservice', 'balancereader'] },
    { name: 'trigger-unschedulable', title: 'Make it unschedulable', targets: ['productcatalogservice', 'cartservice', 'contacts'] },
    { name: 'reset', title: 'Reset the fleet' },
  ];
}

/** The failure each action causes. */
const ACTION_REASON = { 'trigger-oom': 'OOMKilled', 'trigger-badimage': 'ImagePullBackOff', 'trigger-unschedulable': 'Unschedulable' };

/** Seconds from a press to its commit landing on the cluster (Config Sync, ≈30–90 s for real). */
const PRESS_SYNC = 3;
/** Seconds from a press to the workload failing. */
const PRESS_FAIL = 5;
/** Seconds the watcher waits before alerting, per failure (OOM debounce ≈3–5 min, image ≈10–20 s, unschedulable ≈2–3 min for real). */
const PRESS_WATCH = { OOMKilled: 15, ImagePullBackOff: 3, Unschedulable: 10 };
/** Seconds the simulated person takes to choose the fix after the report. */
const PRESS_CHOOSE = 10;
/** Seconds from a merge to Config Sync applying it. */
const MERGE_SYNC = 3;
/** Seconds from a reset to each cluster syncing it, and to the workloads being back. */
const RESET_SYNC = [3, 4];
const RESET_HEAL = 6;
/** How long the fake POST takes (ms; the real one commits through the GitHub API). */
const POST_MS = 1500;

/** The scripted incident's timeline (seconds after it starts; no commit, no rollout). */
const SCRIPTED = { rollout: -1, fail: 0, alert: 3, notes: [6, 10, 14], report: 19, fix: 25, apply: 27, pr: 29, prNote: 31, merge: 37, resume: 41, healthy: 46 };

/** A press's timeline (seconds after the press): compressed, in proportion to the real one. */
export function pressTimeline(reason) {
  const alert = PRESS_FAIL + (PRESS_WATCH[reason] ?? PRESS_WATCH.OOMKilled);
  const report = alert + 21;
  const fix = report + PRESS_CHOOSE;
  return {
    rollout: reason === 'Unschedulable' ? -1 : PRESS_SYNC + 0.5,
    fail: PRESS_FAIL,
    alert,
    notes: [alert + 5, alert + 10, alert + 15],
    report,
    fix,
    apply: fix + 2,
    pr: fix + 4,
    prNote: fix + 6,
    merge: fix + 12,
    resume: fix + 12 + MERGE_SYNC + 1,
    healthy: fix + 12 + MERGE_SYNC + 6,
  };
}

/** A fake 40-hex fleet-repo SHA. */
export function fakeSha() {
  let s = '';
  while (s.length < 40) s += Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  return s.slice(0, 40);
}

/**
 * Same interface as Stream; also runs the fake action API (actions(),
 * runAction()). Timers drive the incidents; reset cancels them. The
 * scripted incident loop runs on its own (no commit, no tracker); a press
 * commits, syncs and plays the whole chain on its target.
 */
export class FleetSynthStream {
  constructor(handlers, { every = INCIDENT_EVERY, first = 4 } = {}) {
    this.h = handlers;
    this.snap = fleetSnapshot();
    this.seq = this.snap.seq;
    this.agents = new Map(this.snap.agents.map((a) => [`${a.atespace}/${a.name}`, a]));
    this.atespaces = new Map(this.snap.atespaces.map((a) => [a.name, a]));
    this.timers = new Set();
    this.incident = null;
    this.pressed = false;
    this.pr = 1;
    setTimeout(() => {
      this.h.onStatus('live');
      this.h.onSnapshot(this.snap, false);
    }, 0);
    this.later(first, () => this.startIncident(INCIDENT_KEY, 'OOMKilled'));
    this.loop = setInterval(() => {
      if (!this.incident) this.startIncident(INCIDENT_KEY, 'OOMKilled');
    }, every * 1000);
  }

  later(seconds, fn) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, seconds * 1000);
    this.timers.add(t);
    return t;
  }

  cancelAll() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.incident = null;
    this.pressed = false;
  }

  emit(events) {
    const now = new Date().toISOString();
    for (const e of events) {
      e.seq = ++this.seq;
      e.time ??= now;
    }
    this.h.onEvents(events);
  }

  /** Changes a workload and emits what the collector's diff would. */
  setWorkload(key, patch) {
    const prev = this.agents.get(key);
    if (!prev) return;
    const agent = { ...prev, ...patch };
    if (agent.state !== prev.state) agent.stateSince = new Date().toISOString();
    this.agents.set(key, agent);
    const evs = [];
    if (agent.state !== prev.state) {
      evs.push({ type: 'agent_state', key, agent, from: prev.state, to: agent.state });
      if (agent.state === 'CRASHED') evs.push({ type: 'agent_crashed', key, agent, from: prev.state, message: agent.crash?.message });
    } else evs.push({ type: 'agent_updated', key, agent });
    this.emit(evs);
  }

  /** A cluster's Config Sync applied a commit. */
  syncCluster(cluster, commit) {
    const prev = this.atespaces.get(cluster);
    if (!prev || prev.syncCommit === commit) return;
    const atespace = { ...prev, syncCommit: commit };
    this.atespaces.set(cluster, atespace);
    this.emit([{ type: 'cluster_synced', key: cluster, cluster, commit, atespace }]);
  }

  /** Puts a workload back to its baseline. */
  restore(key) {
    const [cluster, name] = key.split('/');
    const base = fleetSnapshot().agents.find((a) => a.atespace === cluster && a.name === name);
    const cur = this.agents.get(key);
    if (base && cur && (cur.state !== 'RUNNING' || cur.memoryLimit !== base.memoryLimit || cur.image !== base.image)) {
      this.setWorkload(key, { ...base, stateSince: cur.stateSince, crash: undefined, reason: '' });
    }
  }

  /** A signal event about key (or the fleet when key is ''). */
  signal(type, key, title, extra = {}) {
    const [cluster] = key.split('/');
    this.emit([{ type, key, cluster, title, ...extra }]);
  }

  /**
   * An incident on one workload: failing -> alert -> triage -> report ->
   * fix chosen -> PR -> merged -> healthy, on the scripted timeline or a
   * press's (which also rolls out the change and syncs the merge).
   */
  startIncident(key, reason, { press = false } = {}) {
    const a = this.agents.get(key);
    if (!a || this.incident) return;
    const [cluster, name] = key.split('/');
    const ns = FLEET[cluster]?.namespace || 'default';
    const t = press ? pressTimeline(reason) : SCRIPTED;
    const story = incidentStory({ name, cluster, ns, a, reason, pr: this.pr++ });
    this.incident = key;
    this.pressed = press;
    // Slack messages: the alert's ts is the thread; every message has its
    // own ts and permalink, as the backend's Slack poller sends them.
    let thread = '';
    const say = (type, title, text, extra = {}) => {
      const ts = slackTs(Date.now());
      if (type === 'alert') thread = ts;
      const permalink = slackLink(ts, thread);
      this.signal(type, key, title, { actor: BOT, thread, ts, text, permalink, link: permalink, ...extra });
      return { ts, permalink };
    };
    const { options, pick, prLink, pr } = story;
    let report = null;
    const steps = [
      [t.rollout, () => this.setWorkload(key, { state: 'RESUMING', reason: 'Progressing', ready: 0, ...story.rollout })],
      [t.fail, () => this.setWorkload(key, { state: story.state, ready: 0, reason, crash: { message: story.crash, time: new Date().toISOString() }, ...story.rollout })],
      [t.alert, () => say('alert', story.alertTitle, story.alertText)],
      ...story.notes.map((n, i) => [t.notes[i], () => say('triage', n.title, n.text)]),
      [t.report, () => {
        report = { text: story.report, ...say('triage_report', story.reportTitle, story.report, { options, message: options.map((o) => `${o.letter}: ${o.label}`).join('\n') }) };
      }],
      // Pressing a report's option button edits the report: the backend
      // re-emits the report's ts as fix_chosen, actor the person who pressed.
      [t.fix, () => this.signal('fix_chosen', key, `Option ${pick.letter}: ${pick.label}`, {
        actor: ONCALL,
        thread,
        ts: report?.ts,
        text: `${report?.text || ''}\n✓ ${ONCALL}: ${pick.label}`,
        permalink: report?.permalink,
        link: report?.permalink,
      })],
      [t.apply, () => say('triage', `Apply Option ${pick.letter}: ${pick.label}`, `Apply Option ${pick.letter}: ${pick.label} ◌ Opening a GitOps pull request in \`gke-demos/kcna26-fleet-gitops\``)],
      [t.pr, () => this.signal('pr_opened', key, `PR #${pr}: ${cluster}: ${story.prTitle}`, { actor: 'kube-agents[bot]', link: prLink })],
      [t.prNote, () => say('triage', 'Fix PR opened', `I opened PR #${pr} in kcna26-fleet-gitops. It's yours to review. ${story.prCommit} <${prLink}|Pull Request #${pr}>`, { link: prLink })],
      [t.merge, () => this.signal('pr_merged', key, `PR #${pr} merged; Config Sync is applying it to ${cluster}`, { actor: ONCALL, link: prLink })],
      [press ? t.merge + MERGE_SYNC : -1, () => this.syncCluster(cluster, fakeSha())],
      [t.resume, () => this.setWorkload(key, { state: 'RESUMING', reason: 'Progressing', crash: undefined, ...story.fixed })],
      [t.healthy, () => {
        const n = this.agents.get(key).replicas;
        this.setWorkload(key, { state: 'RUNNING', ready: n, reason: '' });
        say('chat', `${name} is healthy again; closing the incident`, `:white_check_mark: *${name} is healthy again.* ${n}/${n} ready ${story.healthyWhy}, no restarts for 5 minutes. Closing the incident.`);
        this.incident = null;
        this.pressed = false;
      }],
    ];
    for (const [s, fn] of steps) if (s >= 0) this.later(s, fn);
  }

  /** GET api/actions. */
  async actions() {
    return fleetActions();
  }

  /** POST api/actions/<name>: {title, link, key, cluster, commit} as the backend answers, or throws with the error text. */
  async runAction(name, target) {
    await new Promise((r) => setTimeout(r, POST_MS));
    const spec = fleetActions().find((a) => a.name === name);
    if (!spec) throw new Error('no such action');
    const commit = fakeSha();
    const link = `${REPO}/commit/${commit}`;
    let title;
    let key = '';
    let cluster = '';
    if (name === 'reset') {
      this.cancelAll();
      title = 'Reset the demo: restored the baseline, closed 1 pull request';
      const clusters = Object.keys(FLEET).filter((c) => this.atespaces.get(c)?.syncCommit);
      clusters.forEach((c, i) => this.later(RESET_SYNC[i % RESET_SYNC.length], () => this.syncCluster(c, commit)));
      this.later(RESET_HEAL, () => {
        for (const k of this.agents.keys()) this.restore(k);
      });
    } else {
      if (!target || !spec.targets.includes(target)) throw new Error(`pick a target for ${spec.title}`);
      key = [...this.agents.keys()].find((k) => k.endsWith(`/${target}`));
      if (this.incident && this.pressed) throw new Error(`an incident is already running on ${this.incident.split('/')[1]}`);
      // A press takes over from the scripted loop's incident.
      if (this.incident) {
        const prev = this.incident;
        this.cancelAll();
        this.restore(prev);
      }
      cluster = key.split('/')[0];
      const reason = ACTION_REASON[name];
      title = reason === 'OOMKilled' ? `Squeezed ${target}'s memory limit (it will OOM under load)` : reason === 'ImagePullBackOff' ? `Rolled out a missing image tag for ${target}` : `Asked for 32 CPUs for ${target} (no node fits it)`;
      this.later(PRESS_SYNC, () => this.syncCluster(cluster, commit));
      // The incident's clock starts at the press: it fails PRESS_FAIL seconds in.
      this.startIncident(key, reason, { press: true });
    }
    this.emit([{ type: 'action', title, link, key, cluster, commit, actor: 'you@example.com', reason: name }]);
    return { title, link, key, cluster, commit };
  }

  close() {
    clearInterval(this.loop);
    for (const t of this.timers) clearTimeout(t);
  }
}

/** What an incident says and does, per failure. */
function incidentStory({ name, cluster, ns, a, reason, pr }) {
  const prLink = `${REPO}/pull/${pr}`;
  const pod = `${name}-659fd87c86-c7xjn`;
  const card = (mark, step) => `${name} ${reason === 'OOMKilled' ? 'crashloop' : reason === 'Unschedulable' ? 'pending pods' : 'image pull failure'} in ${cluster} ${mark} ${step}`;
  if (reason === 'Unschedulable') {
    const options = [
      { letter: 'A', label: 'Revert the CPU request to 100m', recommended: true },
      { letter: 'B', label: 'Add a 32-CPU node pool' },
    ];
    return {
      pr, prLink, options, pick: options[0],
      state: 'UNSPECIFIED',
      crash: '0/3 nodes are available: 3 Insufficient cpu.',
      rollout: {},
      fixed: {},
      alertTitle: `${cluster}/${name}: Unschedulable, 0/3 nodes can fit 32 CPUs`,
      alertText: `:rotating_light: *${name} in ${cluster} cannot be scheduled.* Looking now.\n\`${ns}/Pod/${pod}\`: 0/3 nodes are available: 3 Insufficient cpu (5 attempts in 2 minutes).`,
      notes: [
        { title: `Looking at ${name}: scheduling events and the node pool`, text: card('◌', `Triage ${ns}/Pod/${pod} (FailedScheduling) on ${cluster}`) },
        { title: 'The pods request 32 CPUs; the largest node has 8', text: card('◌', 'The pods request *32* CPUs; the largest node has `8` allocatable.') },
        { title: 'The CPU request changed in the fleet repo minutes ago', text: card('✓', 'The CPU request went from `100m` to `32` in the fleet repo a few minutes ago.') },
      ],
      reportTitle: `${name} cannot be scheduled: it asks for 32 CPUs and no node has them`,
      report: unschedReport({ name, ns, pod }),
      prTitle: `revert ${name} CPU request to 100m`,
      prCommit: `fix(${ns}): revert ${name} CPU request to 100m`,
      healthyWhy: 'on its 100m CPU request',
    };
  }
  if (reason === 'ImagePullBackOff') {
    const badImage = a.image.replace(/:[^:]+$/, ':v0.0.0-broken');
    const options = [
      { letter: 'A', label: 'Revert to the last good tag', recommended: true },
      { letter: 'B', label: 'Pin the image digest' },
    ];
    return {
      pr, prLink, options, pick: options[0],
      state: 'CRASHED',
      crash: `Back-off pulling image "${badImage}"`,
      rollout: { image: badImage },
      fixed: { image: FLEET[cluster].image(name) },
      alertTitle: `${cluster}/${name}: ImagePullBackOff, pods cannot pull their image`,
      alertText: `:rotating_light: *${name} in ${cluster} cannot pull its image.* Looking now.\n\`${ns}/Pod/${pod}\`: Back-off pulling image \`${badImage}\`.`,
      notes: [
        { title: `Looking at ${name}: pod events, container status and the last hour of logs`, text: card('◌', `Triage ${ns}/Pod/${pod} (ImagePullBackOff) on ${cluster}`) },
        { title: 'The tag v0.0.0-broken does not exist in the registry', text: card('◌', 'The tag `v0.0.0-broken` does not exist in the registry: `manifest unknown`.') },
        { title: 'The image changed minutes ago in the fleet repo', text: card('✓', 'The image changed a few minutes ago in the fleet repo.') },
      ],
      reportTitle: `${name} cannot start: the image tag v0.0.0-broken does not exist`,
      report: imageReport({ name, ns, pod, badImage, good: a.image }),
      prTitle: `revert ${name} image`,
      prCommit: `fix(${ns}): revert ${name} to its last good image`,
      healthyWhy: 'on the last good image',
    };
  }
  const limit = a.memoryLimit || '256Mi';
  const raised = `${Math.round((parseInt(limit, 10) * 2) / 50) * 50}Mi`;
  const options = [
    { letter: 'A', label: 'Scale to 2 replicas' },
    { letter: 'B', label: `Increase to ${raised} with headroom`, recommended: true },
  ];
  return {
    pr, prLink, options, pick: options[1],
    state: 'CRASHED',
    crash: `container ${name} was OOMKilled (limit ${limit}); 4 restarts in 3m`,
    rollout: {},
    fixed: { memoryLimit: raised },
    alertTitle: `${cluster}/${name}: OOMKilled, 4 restarts in 3 minutes`,
    alertText: `:rotating_light: *${name} in ${cluster} keeps crashing.* Looking now.\n\`${ns}/Pod/${pod}\` was OOMKilled 4 times in 3 minutes (limit \`${limit}\`).`,
    notes: [
      { title: `Looking at ${name}: pod events, container status and the last hour of logs`, text: card('◌', `Triage ${ns}/Pod/${pod} (BackOff) on ${cluster}`) },
      { title: `Memory peaked at ${limit} against a ${limit} limit before every restart`, text: card('◌', `Memory peaked at *${limit}* against a \`${limit}\` limit before every restart (exit code 137).`) },
      { title: 'No image change since Tuesday; traffic from loadgenerator is up 3x', text: card('✓', 'No image change since Tuesday; traffic from `loadgenerator` is up 3x.') },
    ],
    reportTitle: `${name} is OOM-killed on every start: its ${limit} limit is too low under 3x traffic`,
    report: oomReport({ name, ns, pod, limit, raised }),
    prTitle: `raise ${name} memory to ${raised}`,
    prCommit: `chore(${ns}): increase ${name} memory requests and limits to ${raised}`,
    healthyWhy: `on the new ${raised} limit`,
  };
}
