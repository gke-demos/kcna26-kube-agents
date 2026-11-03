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

function slackTs(ms) {
  return `${Math.floor(ms / 1000)}.${String(ms % 1000).padStart(3, '0')}100`;
}

/** The fleet's snapshot at time now (ms). */
export function fleetSnapshot(now = Date.now()) {
  const iso = (ms) => new Date(ms).toISOString();
  const atespaces = [];
  const agents = [];
  for (const [cluster, c] of Object.entries(FLEET)) {
    atespaces.push({ name: cluster });
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

/** The actions the console's buttons offer (GET api/actions). */
export function fleetActions() {
  return [
    { name: 'oom', title: 'Cause an OOMKill', targets: ['recommendationservice', 'cartservice', 'currencyservice'] },
    { name: 'bad-image', title: 'Push a bad image', targets: ['frontend', 'checkoutservice', 'balancereader'] },
    { name: 'reset', title: 'Reset the fleet' },
  ];
}

/**
 * Same interface as Stream; also runs the fake action API (actions(),
 * runAction()). Timers drive the scripted incident; reset cancels it.
 */
export class FleetSynthStream {
  constructor(handlers, { every = INCIDENT_EVERY, first = 4 } = {}) {
    this.h = handlers;
    this.snap = fleetSnapshot();
    this.seq = this.snap.seq;
    this.agents = new Map(this.snap.agents.map((a) => [`${a.atespace}/${a.name}`, a]));
    this.timers = new Set();
    this.incident = null;
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

  /** A signal event about key (or the fleet when key is ''). */
  signal(type, key, title, extra = {}) {
    const [cluster] = key.split('/');
    this.emit([{ type, key, cluster, title, ...extra }]);
  }

  /** The scripted incident on one workload: failing -> alert -> triage -> PR -> merged -> healthy. */
  startIncident(key, reason) {
    const a = this.agents.get(key);
    if (!a || this.incident) return;
    const [cluster, name] = key.split('/');
    const ns = FLEET[cluster]?.namespace || 'default';
    const oom = reason === 'OOMKilled';
    const pr = this.pr++;
    const prLink = `${REPO}/pull/${pr}`;
    const limit = a.memoryLimit || '256Mi';
    const raised = `${Math.round((parseInt(limit, 10) * 2) / 50) * 50}Mi`;
    const badImage = a.image.replace(/:[^:]+$/, ':v0.0.0-broken');
    const pod = `${name}-659fd87c86-c7xjn`;
    this.incident = key;
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
    const card = (mark, step) => `${name} ${oom ? 'crashloop' : 'image pull failure'} in ${cluster} ${mark} ${step}`;
    const options = oom
      ? [
          { letter: 'A', label: 'Scale to 2 replicas' },
          { letter: 'B', label: `Increase to ${raised} with headroom`, recommended: true },
        ]
      : [
          { letter: 'A', label: 'Revert to the last good tag', recommended: true },
          { letter: 'B', label: 'Pin the image digest' },
        ];
    const pick = options.find((o) => o.recommended);
    let report = null;
    const steps = [
      [0, () => this.setWorkload(key, {
        state: 'CRASHED',
        ready: 0,
        reason,
        crash: { message: oom ? `container ${name} was OOMKilled (limit ${limit}); 4 restarts in 3m` : `Back-off pulling image "${badImage}"`, time: new Date().toISOString() },
        ...(oom ? {} : { image: badImage }),
      })],
      [3, () => say('alert', `${cluster}/${name}: ${reason}, ${oom ? '4 restarts in 3 minutes' : 'pods cannot pull their image'}`,
        oom
          ? `:rotating_light: *${name} in ${cluster} keeps crashing.* Looking now.\n\`${ns}/Pod/${pod}\` was OOMKilled 4 times in 3 minutes (limit \`${limit}\`).`
          : `:rotating_light: *${name} in ${cluster} cannot pull its image.* Looking now.\n\`${ns}/Pod/${pod}\`: Back-off pulling image \`${badImage}\`.`)],
      [6, () => say('triage', `Looking at ${name}: pod events, container status and the last hour of logs`, card('◌', `Triage ${ns}/Pod/${pod} (${oom ? 'BackOff' : 'ImagePullBackOff'}) on ${cluster}`))],
      [10, () => say('triage', oom ? `Memory peaked at ${limit} against a ${limit} limit before every restart` : 'The tag v0.0.0-broken does not exist in the registry',
        card('◌', oom ? `Memory peaked at *${limit}* against a \`${limit}\` limit before every restart (exit code 137).` : 'The tag `v0.0.0-broken` does not exist in the registry: `manifest unknown`.'))],
      [14, () => say('triage', oom ? 'No image change since Tuesday; traffic from loadgenerator is up 3x' : 'The image changed 4 minutes ago in the fleet repo (commit 9f2c1ab)',
        card('✓', oom ? 'No image change since Tuesday; traffic from `loadgenerator` is up 3x.' : 'The image changed 4 minutes ago in the fleet repo (commit `9f2c1ab`).'))],
      [19, () => {
        const text = oom ? oomReport({ name, ns, pod, limit, raised }) : imageReport({ name, ns, pod, badImage, good: a.image });
        const title = oom ? `${name} is OOM-killed on every start: its ${limit} limit is too low under 3x traffic` : `${name} cannot start: the image tag v0.0.0-broken does not exist`;
        report = { text, ...say('triage_report', title, text, { options, message: options.map((o) => `${o.letter}: ${o.label}`).join('\n') }) };
      }],
      // Pressing a report's option button edits the report: the backend
      // re-emits the report's ts as fix_chosen, actor the person who pressed.
      [25, () => this.signal('fix_chosen', key, `Option ${pick.letter}: ${pick.label}`, {
        actor: ONCALL,
        thread,
        ts: report?.ts,
        text: `${report?.text || ''}\n✓ ${ONCALL}: ${pick.label}`,
        permalink: report?.permalink,
        link: report?.permalink,
      })],
      [27, () => say('triage', `Apply Option ${pick.letter}: ${pick.label}`, `Apply Option ${pick.letter}: ${pick.label} ◌ Opening a GitOps pull request in \`gke-demos/kcna26-fleet-gitops\``)],
      [29, () => this.signal('pr_opened', key, `PR #${pr}: ${cluster}: ${oom ? `raise ${name} memory to ${raised}` : `revert ${name} image`}`, { actor: 'kube-agents[bot]', link: prLink })],
      [31, () => say('triage', 'Fix PR opened',
        `I opened PR #${pr} in kcna26-fleet-gitops. It's yours to review. ${oom ? `chore(${ns}): increase ${name} memory requests and limits to ${raised}` : `fix(${ns}): revert ${name} to its last good image`} <${prLink}|Pull Request #${pr}>`,
        { link: prLink })],
      [37, () => this.signal('pr_merged', key, `PR #${pr} merged; Config Sync is applying it to ${cluster}`, { actor: ONCALL, link: prLink })],
      [41, () => this.setWorkload(key, { state: 'RESUMING', reason: 'Progressing', crash: undefined, ...(oom ? { memoryLimit: raised } : { image: FLEET[cluster].image(name) }) })],
      [46, () => {
        const n = this.agents.get(key).replicas;
        this.setWorkload(key, { state: 'RUNNING', ready: n, reason: '' });
        say('chat', `${name} is healthy again; closing the incident`,
          `:white_check_mark: *${name} is healthy again.* ${n}/${n} ready ${oom ? `on the new ${raised} limit` : 'on the last good image'}, no restarts for 5 minutes. Closing the incident.`);
        this.incident = null;
      }],
    ];
    for (const [s, fn] of steps) this.later(s, fn);
  }

  /** GET api/actions. */
  async actions() {
    return fleetActions();
  }

  /** POST api/actions/<name>: {title, link}, or throws with the error text. */
  async runAction(name, target) {
    await new Promise((r) => setTimeout(r, 700));
    const spec = fleetActions().find((a) => a.name === name);
    if (!spec) throw new Error('no such action');
    let title;
    const link = `${REPO}/commit/${Math.floor(Math.random() * 0xfffffff).toString(16).padStart(7, '0')}`;
    if (name === 'reset') {
      for (const t of this.timers) clearTimeout(t);
      this.timers.clear();
      this.incident = null;
      const fresh = fleetSnapshot();
      for (const a of fresh.agents) {
        const key = `${a.atespace}/${a.name}`;
        const cur = this.agents.get(key);
        if (cur && (cur.state !== 'RUNNING' || cur.memoryLimit !== a.memoryLimit || cur.image !== a.image)) this.setWorkload(key, { ...a, stateSince: cur.stateSince, crash: undefined, reason: '' });
      }
      title = 'Reset the fleet to the demo baseline';
    } else {
      if (!target || !spec.targets.includes(target)) throw new Error(`pick a target for ${spec.title}`);
      const key = [...this.agents.keys()].find((k) => k.endsWith(`/${target}`));
      if (this.incident) throw new Error(`an incident is already running on ${this.incident.split('/')[1]}`);
      title = name === 'oom' ? `Lowered ${target}'s memory limit (it will OOM under load)` : `Pushed a bad image tag for ${target}`;
      this.later(2, () => this.startIncident(key, name === 'oom' ? 'OOMKilled' : 'ImagePullBackOff'));
    }
    this.emit([{ type: 'action', title, link, actor: 'you@example.com', reason: name }]);
    return { title, link };
  }

  close() {
    clearInterval(this.loop);
    for (const t of this.timers) clearTimeout(t);
  }
}
