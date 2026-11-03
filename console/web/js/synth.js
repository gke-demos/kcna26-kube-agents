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

// A synthetic stream for looking at the scene at scale without a cluster:
// open the UI with ?synthetic=5000. It speaks the same interface as Stream
// (snapshot, then event batches), so nothing downstream can tell. This is a
// browser-only stand-in until the collector's simulator (milestone 2).

/** Small deterministic PRNG so a given N always lays out the same way. */
export function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/** Workers when the URL doesn't ask for a number (the old default). */
export const DEFAULT_WORKERS = 12;

/** States that hold a worker (running, and on their way in or out). */
const HOLDS_WORKER = new Set(['RUNNING', 'RESUMING', 'SUSPENDING']);

/** What one agent requests: 250m to 1 CPU and 0.5 to 2 GiB, fixed per agent. */
export function agentRequest(key) {
  let h = 7;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  const cpu = [0.25, 0.5, 0.5, 1][h % 4];
  return { cpu, memory: cpu * 2 * 2 ** 30 };
}

const POOL_KINDS = ['general', 'highmem', 'burst', 'spot', 'batch', 'gpu-l4', 'compute', 'arm'];

/** True for the workers that are draining: the last one, and about one in 200 of a big fleet. */
export function isDraining(i, count) {
  return i === count - 1 || (count > 50 && i % 197 === 101);
}

/**
 * Workers sized for n agents, in node pools of 20 to 100 workers with 2 to
 * 8 workers per node (a fleet of 12 is one pool). About a tenth of agents
 * hold a worker at a time; each worker gets 1.4x to 2.2x its share of actor
 * slots (or workerCap slots, like real Substrate's 1000), and CPU and memory
 * to match (4 GiB per core), so fills differ from worker to worker.
 */
export function syntheticWorkers(n, r, { workerCap = 0, workers: count = DEFAULT_WORKERS } = {}) {
  count = Math.max(1, Math.floor(count));
  const share = Math.max(4, (n * 0.1) / count);
  const out = [];
  let pool = 0;
  while (out.length < count) {
    const size = count <= 100 ? count : Math.min(count - out.length, 20 + Math.floor(r() * 81));
    const perNode = 2 + Math.floor(r() * 7);
    const poolName = count <= 100 ? 'default' : `${POOL_KINDS[pool % POOL_KINDS.length]}-${String.fromCharCode(97 + Math.floor(pool / POOL_KINDS.length) % 26)}${pool >= POOL_KINDS.length * 26 ? pool : ''}`;
    for (let k = 0; k < size; k++) {
      const i = out.length;
      const sized = Math.max(8, Math.round(share * (1.4 + r() * 0.8)));
      // workerCap: every worker reports this many actor slots (real Substrate
      // workers say 1000), whatever they host; CPU and memory stay sized.
      const capacityActors = workerCap > 0 ? workerCap : sized;
      const cores = Math.max(4, Math.ceil((sized * 0.5) / 4) * 4);
      const nodeIx = count <= 100 ? i % 4 : Math.floor(k / perNode);
      const node = count <= 100 ? `gke-pool-${nodeIx}-${(0x3a1f + i * 977).toString(16)}` : `gke-${poolName}-${(0x3a1f + pool * 7919 + nodeIx * 977).toString(16)}`;
      out.push({
        name: `w-${i}`,
        pod: count <= 100 ? `wk-${String(i).padStart(2, '0')}` : `wk-${poolName}-${String(k).padStart(3, '0')}`,
        node,
        pool: poolName,
        state: isDraining(i, count) ? 'DRAINING' : 'ACTIVE',
        capacityActors,
        capacityCpu: String(cores),
        capacityMemory: `${cores * 4}Gi`,
      });
    }
    pool++;
  }
  return out;
}

/**
 * Picks a worker for an agent, weighted by free slots and never a draining
 * one, in O(1): a few random tries accepted in proportion to free room.
 * load: Map name -> agents held.
 */
function pickWorker(r, workers, load) {
  for (let t = 0; t < 16; t++) {
    const w = workers[Math.floor(r() * workers.length)];
    if (w.state === 'DRAINING') continue;
    const free = Math.max(0.5, w.capacityActors - (load.get(w.name) || 0));
    if (r() * w.capacityActors <= free) return w.name;
  }
  return (workers.find((w) => w.state !== 'DRAINING') || workers[0]).name;
}

/** Writes a worker's allocation from its use ({n, cpu, mem}). */
function writeAllocation(w, u, resources) {
  w.allocatedActors = u.n;
  if (!resources) {
    delete w.allocatedCpu;
    delete w.allocatedMemory;
    return;
  }
  w.allocatedCpu = `${Math.round(u.cpu * 1000)}m`;
  w.allocatedMemory = `${Math.round(u.mem / 2 ** 20)}Mi`;
}

/** Each worker's use ({n, cpu, mem}) from the agents it holds. */
export function workerUse(workers, agents) {
  const use = new Map(workers.map((w) => [w.name, { n: 0, cpu: 0, mem: 0 }]));
  for (const a of agents) {
    const u = a.worker && use.get(a.worker);
    if (!u) continue;
    const req = agentRequest(`${a.atespace}/${a.name}`);
    u.n++;
    u.cpu += req.cpu;
    u.mem += req.memory;
  }
  return use;
}

/**
 * Fills in each worker's allocated slots, CPU and memory from the agents it
 * holds. With resources false, CPU and memory allocation are left out, as
 * real Substrate reports them while ax tasks declare no limits.
 */
export function allocate(workers, agents, resources = true) {
  const use = workerUse(workers, agents);
  for (const w of workers) writeAllocation(w, use.get(w.name), resources);
  return workers;
}

/**
 * Options from the page URL: workers=N (a fleet of N workers in node pools),
 * churn=N (state changes per second), workercap=N (every worker reports N
 * actor slots, e.g. 1000 like real Substrate) and alloc=0 (workers report
 * no CPU or memory allocation, like real Substrate today).
 */
export function syntheticOptions(params) {
  const out = {
    workerCap: Math.max(0, Number(params.get('workercap')) || 0),
    resources: params.get('alloc') !== '0',
  };
  const workers = Number(params.get('workers'));
  if (workers > 0) out.workers = Math.min(20000, Math.floor(workers));
  if (params.has('churn') && Number.isFinite(Number(params.get('churn')))) out.churn = Math.max(0, Number(params.get('churn')));
  return out;
}

/** Odds a picked agent that isn't running wakes: running share f = odds / (1 + odds), about 10%. */
const WAKE_ODDS = 0.11;

/** State changes per second by default: a couple for small scenes, 1% of agents per second at scale (1,000/s at 100k). */
export function defaultChurn(n) {
  return n >= 10000 ? n / 100 : 2;
}

const WORDS = ['payments', 'checkout', 'search', 'ingest', 'billing', 'triage', 'research', 'support', 'fraud', 'catalog', 'ml-eval', 'ops', 'docs', 'growth', 'risk', 'infra'];


/** Atespace name i: the words, then the words again with a suffix (big clusters have many). */
function spaceName(i) {
  const w = WORDS[i % WORDS.length];
  return i < WORDS.length ? w : `${w}-${Math.floor(i / WORDS.length) + 1}`;
}

/**
 * Builds a snapshot with n agents spread over atespaces of very different
 * sizes (roughly Zipf), mostly suspended, as a large Substrate cluster is.
 * opts: workers (fleet size), workerCap, resources (see syntheticOptions).
 */
export function syntheticSnapshot(n, seed = 7, opts = {}) {
  const r = rng(seed);
  const spaces = Math.max(3, Math.min(48, Math.round(Math.sqrt(n) / 5)));
  const weights = Array.from({ length: spaces }, (_, i) => 1 / (i + 1));
  const total = weights.reduce((a, b) => a + b, 0);
  const now = Date.now();
  const agents = [];
  const atespaces = [];
  const workers = syntheticWorkers(n, rng(seed + 1), opts);
  const draining = workers.filter((w) => w.state === 'DRAINING');
  const load = new Map();
  let made = 0;
  for (let i = 0; i < spaces; i++) {
    const name = spaceName(i);
    atespaces.push({ name });
    const count = i === spaces - 1 ? n - made : Math.round((weights[i] / total) * n);
    const short = name.slice(0, 4) + (i >= WORDS.length ? Math.floor(i / WORDS.length) + 1 : '');
    for (let j = 0; j < count; j++) {
      const x = r();
      const state = x < 0.08 ? 'RUNNING' : x < 0.09 ? 'CRASHED' : x < 0.1 ? 'RESUMING' : 'SUSPENDED';
      let worker;
      if (HOLDS_WORKER.has(state)) {
        // Draining workers still hold some agents from before they drained
        // (about as many as any other worker).
        worker = r() < Math.max(0.04, draining.length / workers.length) ? draining[Math.floor(r() * draining.length)].name : pickWorker(r, workers, load);
        load.set(worker, (load.get(worker) || 0) + 1);
      }
      agents.push({
        atespace: name,
        name: `${short}-agent-${String(j).padStart(4, '0')}`,
        state,
        stateSince: new Date(now - r() * 3600e3).toISOString(),
        createTime: new Date(now - 86400e3 - r() * 30 * 86400e3).toISOString(),
        template: `${name}-runner`,
        worker,
        task: syntheticTask(state, now - r() * 3600e3),
      });
    }
    made += count;
  }
  allocate(workers, agents, opts.resources !== false);
  return { cluster: `synthetic-${n}`, source: 'synthetic', seq: 1, features: { attach: true, mastWeb: true, raw: true }, sources: [], atespaces, agents, workers };
}

function syntheticTask(state, at) {
  const time = new Date(at).toISOString();
  const ready = {
    RUNNING: { status: 'True', reason: 'ResumedByRequest' },
    CRASHED: { status: 'False', reason: 'Crashed', message: 'runner exited with code 137' },
    RESUMING: { status: 'False', reason: 'Resuming' },
  }[state] || { status: 'False', reason: 'IdleSuspended', message: 'idle for 10m0s' };
  return {
    phase: state === 'RUNNING' ? 'Running' : state === 'CRASHED' ? 'Failed' : 'Suspended',
    idleSuspendAfter: '10m',
    image: 'us-docker.pkg.dev/example/agents/runner@sha256:4f9c2a7d1e0b8c6a5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c',
    httpPort: 8080,
    workspaces: ['repo'],
    conditions: [
      { type: 'Ready', ...ready, lastTransitionTime: time },
      { type: 'Scheduled', status: 'True', reason: 'Placed', lastTransitionTime: time },
    ],
  };
}

/** The panel's agent detail for a synthetic agent (what the collector's API would say). */
export function syntheticDetail(a, workers) {
  if (!a) return null;
  const r = rng([...a.name].reduce((h, c) => h * 31 + c.charCodeAt(0), 7));
  const running = a.state === 'RUNNING';
  const wk = a.worker ? workers?.get(a.worker) : null;
  const i = a.worker ? Number(a.worker.slice(2)) : -1;
  const worker = a.worker ? { name: a.worker, pod: wk?.pod || `wk-${String(i).padStart(2, '0')}` } : null;
  const agent = {
    ...a,
    workerPod: worker?.pod,
    workerNode: worker && (wk?.node || `gke-pool-${i % 4}-${(0x3a1f + i * 977).toString(16)}`),
    snapshotURI: running ? '' : `gs://snapshots/${a.atespace}/${a.name}/0042`,
    uid: `${Math.floor(r() * 1e8).toString(16)}-synthetic`,
    crash: a.state === 'CRASHED' ? { message: a.task?.conditions?.[0]?.message || 'synthetic crash', time: a.stateSince } : undefined,
  };
  return {
    agent,
    worker,
    runner: running ? { idleSeconds: Math.floor(r() * 420), inFlight: 0 } : null,
    runnerTime: new Date().toISOString(),
  };
}

/** The raw objects for a synthetic agent (what GET .../raw would say: protojson, redacted). */
export function syntheticRaw(a, workers) {
  const d = syntheticDetail(a, workers);
  if (!d) return null;
  const ag = d.agent;
  // Substrate v0.5 has no PAUSING/PAUSED states: the collector derives them
  // from SUSPENDING/SUSPENDED and the latest snapshot.
  const apiState = { PAUSING: 'SUSPENDING', PAUSED: 'SUSPENDED' }[ag.state] || ag.state;
  const status = { state: `ACTOR_STATE_${apiState}` };
  if (ag.worker) {
    status.workerAssignment = {
      worker: { name: ag.worker },
      workerNamespace: 'ax-workers',
      workerPool: 'ax-pool',
      workerPod: ag.workerPod,
      workerPodIps: ['10.59.129.70'],
      nodeName: ag.workerNode,
      workerEpoch: '3',
    };
    status.assignedNode = ag.workerNode;
  }
  if (ag.snapshotURI) {
    status.snapshots = [
      {
        generation: 42,
        owner: 'SNAPSHOT_OWNER_ACTOR',
        fidelity: 'SNAPSHOT_FIDELITY_MEMORY',
        durableSnapshot: { status: 'SNAPSHOT_STORAGE_STATUS_COMPLETED', object: { snapshotUri: ag.snapshotURI } },
      },
    ];
    status.lastAssignedGeneration = 42;
  }
  if (ag.crash) status.crash = { message: ag.crash.message, crashTime: ag.crash.time };
  const objects = [
    {
      section: 'substrate',
      kind: 'Actor',
      name: ag.name,
      object: {
        metadata: { atespace: ag.atespace, name: ag.name, uid: ag.uid, version: '12', createTime: ag.stateSince, updateTime: ag.stateSince },
        actorTemplate: { atespace: ag.atespace, name: 'ax-runner' },
        status,
      },
    },
  ];
  const t = ag.task;
  if (t) {
    objects.push({
      section: 'task',
      kind: 'Task',
      name: ag.name,
      object: {
        apiVersion: 'ax.dev/v1alpha1',
        kind: 'Task',
        metadata: { name: ag.name, atespace: ag.atespace, creationTimestamp: ag.stateSince },
        spec: {
          image: t.image,
          env: [
            { name: 'GEMINI_API_KEY', value: '<redacted>' },
            { name: 'LOG_LEVEL', value: '<redacted>' },
          ],
          resources: { requests: { cpu: '500m', memory: '1Gi' } },
          workspaces: (t.workspaces || []).map((w) => ({ name: w, path: `/workspace/${w}` })),
          http: { port: t.httpPort },
          idle: { suspendAfter: t.idleSuspendAfter },
        },
        status: { phase: t.phase, id: ag.uid, actor: ag.name, conditions: t.conditions },
      },
    });
    for (const w of t.workspaces || []) {
      objects.push({
        section: 'task',
        kind: 'Workspace',
        name: w,
        object: {
          apiVersion: 'ax.dev/v1alpha1',
          kind: 'Workspace',
          metadata: { name: w, atespace: ag.atespace },
          spec: {
            git: [{ name: 'app', repo: 'https://example.com/org/app.git', branch: 'main', dir: 'app', depth: 1 }],
            files: [{ path: '/etc/agent/AGENTS.md', content: '<redacted> (412 bytes)' }],
          },
        },
      });
    }
  }
  return { objects };
}

/**
 * Same interface as Stream, fed by syntheticSnapshot plus random churn:
 * churn state changes per second (default: defaultChurn(n)), in batches
 * every 100 ms at scale, or three every 1.5 s for small scenes. Worker
 * load and allocation are kept incrementally, so a batch costs what it
 * changes, not what the cluster holds.
 */
export class SyntheticStream {
  constructor(n, handlers, { every, churn, ...opts } = {}) {
    this.h = handlers;
    this.opts = opts;
    this.snap = syntheticSnapshot(n, 7, opts);
    this.seq = this.snap.seq;
    this.r = rng(99);
    this.agents = new Map(this.snap.agents.map((a) => [`${a.atespace}/${a.name}`, a]));
    this.keys = [...this.agents.keys()];
    this.workers = this.snap.workers.map((w) => ({ ...w }));
    this.byName = new Map(this.workers.map((w) => [w.name, w]));
    this.use = workerUse(this.workers, this.agents.values());
    this.load = new Map([...this.use].map(([k, u]) => [k, u.n]));
    this.rate = churn ?? defaultChurn(n);
    // Small scenes: three changes every 1.5 s (as before); at scale, a
    // batch every 100 ms so the rate stays smooth.
    const slow = this.rate <= 2;
    this.every = every ?? (slow ? 1500 : 100);
    this.perTick = slow ? 3 : (this.rate * this.every) / 1000;
    this.carry = 0;
    setTimeout(() => {
      this.h.onStatus('live');
      this.h.onSnapshot(this.snap, false);
    }, 0);
    this.timer = this.rate > 0 ? setInterval(() => this.churn(), this.every) : null;
  }

  /** Moves an agent's request between workers' use. */
  account(agent, worker, sign) {
    const u = worker && this.use.get(worker);
    if (!u) return;
    const req = agentRequest(`${agent.atespace}/${agent.name}`);
    u.n += sign;
    u.cpu += sign * req.cpu;
    u.mem += sign * req.memory;
    this.load.set(worker, u.n);
  }

  churn() {
    const events = [];
    const now = new Date().toISOString();
    const touched = new Set();
    this.carry += this.perTick;
    const count = Math.floor(this.carry);
    this.carry -= count;
    for (let i = 0, tries = 0; i < count && tries < count * 40; tries++) {
      const key = this.keys[Math.floor(this.r() * this.keys.length)];
      const prev = this.agents.get(key);
      // Running agents suspend (or crash); others wake, but only WAKE_ODDS
      // of the time they are picked, so the running share stays near its
      // start (about a tenth) however long the churn runs.
      const running = prev.state === 'RUNNING';
      if (!running && this.r() > WAKE_ODDS) continue;
      i++;
      let to = running ? 'SUSPENDED' : 'RUNNING';
      if (running && this.r() < 0.03) to = 'CRASHED';
      if (prev.worker) {
        touched.add(prev.worker);
        this.account(prev, prev.worker, -1);
      }
      const worker = to === 'RUNNING' ? pickWorker(this.r, this.workers, this.load) : undefined;
      if (worker) {
        touched.add(worker);
        this.account(prev, worker, 1);
      }
      const agent = { ...prev, state: to, stateSince: now, task: syntheticTask(to, Date.now()), worker };
      this.agents.set(key, agent);
      const base = { key, agent, seq: ++this.seq };
      if (to === 'RUNNING') events.push({ ...base, type: 'agent_woke', reason: 'ResumedByRequest' });
      else if (to === 'SUSPENDED') events.push({ ...base, type: 'agent_suspended', reason: 'IdleSuspended' });
      else events.push({ ...base, type: 'agent_crashed', message: 'synthetic crash' });
    }
    // Workers report their new allocations.
    for (const name of touched) {
      const w = this.byName.get(name);
      if (!w) continue;
      writeAllocation(w, this.use.get(name), this.opts.resources !== false);
      events.push({ type: 'worker_updated', key: name, worker: { ...w }, seq: ++this.seq });
    }
    if (events.length) this.h.onEvents(events);
  }

  close() {
    clearInterval(this.timer);
  }
}
