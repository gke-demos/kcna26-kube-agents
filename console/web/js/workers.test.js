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

// Worker view: grouping layout, highlight rules, usage, synthetic workers,
// and that links, pads and the island ground reuse or dispose everything
// they make when the grouping switches back and forth.

import { register } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';

register('../../hack/three-hooks.mjs', import.meta.url);
const THREE = await import('three');
const W = await import('./workers.js');
const { slotPosition, planIsland, SlotTable } = await import('./layout.js');
const { LinkSet } = await import('./links.js');
const { WorkerPads, padLabelHTML } = await import('./pads.js');
const { buildGround } = await import('./island.js');
const { syntheticSnapshot, SyntheticStream, syntheticOptions } = await import('./synth.js');
const { THEMES } = await import('./themes.js');
const { Model } = await import('./model.js');

const { PARKED, HI } = W;

function overlaps(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.z < b.z + b.d && b.z < a.z + a.d;
}

test('worker view: one platform per worker, room for its agents, a parked area behind', () => {
  const workers = Array.from({ length: 12 }, (_, i) => ({ name: `w-${i}`, count: 10 + i, capacity: i === 3 ? 0 : 30 }));
  const plan = W.planWorkerView(workers, 4500);
  const ds = [...plan.districts.values()];
  assert.equal(ds.length, 13);
  const parked = plan.districts.get(PARKED);
  assert.equal(parked.kind, 'parked');
  assert.ok(parked.capacity >= 4500);
  for (const w of workers) {
    const d = plan.districts.get(w.name);
    assert.equal(d.kind, 'worker');
    assert.ok(d.capacity >= w.count, `${w.name} holds its agents`);
    // Room dots show the actor capacity when known.
    if (w.capacity) assert.equal(d.shown, w.capacity);
    // Platforms are in front of the parked area (nearer the camera).
    assert.ok(d.z > parked.z + parked.d, `${w.name} in front`);
    // Every slot lands inside the platform, below its label strip.
    for (const s of [0, d.capacity - 1]) {
      const p = slotPosition(d, s);
      assert.ok(p.x > d.x && p.x < d.x + d.w && p.z > d.z + d.strip && p.z < d.z + d.d, `${w.name} slot ${s}`);
    }
  }
  // All the same width (and base depth), so fills compare at a glance; only
  // a worker busier than the 90th percentile gets extra rows.
  const widths = new Set(workers.map((w) => plan.districts.get(w.name).w));
  assert.equal(widths.size, 1);
  const depths = workers.map((w) => plan.districts.get(w.name).d).sort((a, b) => a - b);
  assert.equal(depths.filter((d) => d === depths[0]).length >= workers.length - 2, true);
  for (let i = 0; i < ds.length; i++) for (let j = i + 1; j < ds.length; j++) assert.ok(!overlaps(ds[i], ds[j]), `${ds[i].name} / ${ds[j].name}`);
  for (const d of ds) {
    assert.ok(d.x >= -plan.width / 2 - 1e-9 && d.x + d.w <= plan.width / 2 + 1e-9, `${d.name} within width`);
    assert.ok(d.z >= -plan.depth / 2 - 1e-9 && d.z + d.d <= plan.depth / 2 + 1e-9, `${d.name} within depth`);
  }
  // Deterministic, and roughly landscape like the atespace island.
  assert.deepEqual(W.planWorkerView(workers, 4500), plan);
  assert.ok(plan.width > plan.depth * 0.8 && plan.width < plan.depth * 4, `${plan.width} x ${plan.depth}`);
});

test('worker view: no workers, or nothing parked, still plans', () => {
  const only = W.planWorkerView([], 40);
  assert.equal(only.districts.size, 1);
  assert.ok(only.districts.get(PARKED).capacity >= 40);
  const none = W.planWorkerView([{ name: 'w-0', count: 3, capacity: 8 }], 0);
  assert.equal(none.districts.get('w-0').shown, 8);
  // Natural order: w-2 before w-10.
  const order = [...W.planWorkerView([{ name: 'w-10', count: 1 }, { name: 'w-2', count: 1 }], 0).districts.keys()];
  assert.deepEqual(order, [PARKED, 'w-2', 'w-10']);
});

test('worker view: real capacities (1000 slots) never inflate platforms; agents stay readable', () => {
  // Real Substrate workers report capacityActors=1000 and host a handful of
  // agents each; platforms size from what they host, not from 1000.
  for (let n = 1; n <= 25; n++) {
    const workers = Array.from({ length: 12 }, (_, i) => ({ name: `w-${i}`, count: i === 0 ? n : i % 3, capacity: 1000 }));
    const parked = 24;
    const plan = W.planWorkerView(workers, parked);
    const d = plan.districts.get('w-0');
    // Room for the busiest worker's agents plus headroom, nothing like 1000.
    assert.ok(d.capacity >= n + 1, `n=${n}: holds its agents with room`);
    assert.ok(d.capacity <= Math.max(W.MIN_WORKER_CELLS * 2, n * 2 + 6), `n=${n}: capacity ${d.capacity} is not sized from 1000`);
    // Readable: an agent cell is a sizable share of the platform.
    const cellShare = (1.5 * 1.5) / (d.w * d.d);
    assert.ok(cellShare > 1 / (n * 3 + 30), `n=${n}: agent cell is ${(cellShare * 100).toFixed(1)}% of the platform`);
    assert.ok(d.w < 20 && d.d < 20, `n=${n}: platform ${d.w.toFixed(1)}x${d.d.toFixed(1)}`);
    assert.ok(d.shown <= d.capacity);
    // The parked area holds its agents with room, and is not a thin strip.
    const p = plan.districts.get(PARKED);
    assert.ok(p.capacity >= parked * 1.05, `n=${n}: parked room ${p.capacity}`);
    assert.ok(p.capacity <= parked * 2.5, `n=${n}: parked area not oversized (${p.capacity})`);
    assert.ok(p.rows >= 3, `n=${n}: parked area ${p.cols}x${p.rows} is not a strip`);
    assert.ok(p.w / p.d < 3, `n=${n}: parked area ${p.w.toFixed(1)}x${p.d.toFixed(1)}`);
    // The island stays a sensible size.
    assert.ok(plan.width < 90 && plan.depth < 90, `n=${n}: island ${plan.width.toFixed(0)}x${plan.depth.toFixed(0)}`);
  }
  // Capacity doesn't change the plan at all.
  const a = W.planWorkerView([{ name: 'w-0', count: 3, capacity: 1000 }], 10);
  const b = W.planWorkerView([{ name: 'w-0', count: 3, capacity: 0 }], 10);
  assert.equal(a.districts.get('w-0').w, b.districts.get('w-0').w);
  assert.equal(a.districts.get('w-0').capacity, b.districts.get('w-0').capacity);
});

test('synthetic: workercap=1000 and alloc=0 reproduce real Substrate workers', () => {
  const opts = syntheticOptions(new URLSearchParams('synthetic=25&workercap=1000&alloc=0'));
  assert.deepEqual(opts, { workerCap: 1000, resources: false });
  assert.deepEqual(syntheticOptions(new URLSearchParams('')), { workerCap: 0, resources: true });
  const snap = syntheticSnapshot(25, 7, opts);
  for (const w of snap.workers) {
    assert.equal(w.capacityActors, 1000);
    assert.equal(w.allocatedCpu, undefined);
    assert.ok(w.capacityCpu);
  }
  const m = new Model();
  m.applySnapshot(snap);
  const counts = W.groupCounts(m, 'worker');
  const workers = [...counts].filter(([k]) => k !== PARKED).map(([name, count]) => ({ name, count, capacity: 1000 }));
  const d = W.planWorkerView(workers, counts.get(PARKED)).districts.get('w-0');
  assert.ok(d.capacity < 40, `platform cells ${d.capacity}`);
});

test('usage: no CPU/memory allocation reported says "not reported", never an empty bar', () => {
  // Real Substrate today: capacity reported, allocation absent while hosting.
  const real = W.workerUsage({ name: 'w', capacityActors: 1000, capacityCpu: '8', capacityMemory: '32Gi' }, 1);
  assert.deepEqual(real.cpu, { reported: false, cap: 8 });
  assert.equal(real.memory.reported, false);
  // Zero allocated while hosting agents: also not reported (no limits declared).
  const zero = W.workerUsage({ name: 'w', capacityCpu: '8', allocatedCpu: '0' }, 2);
  assert.equal(zero.cpu.reported, false);
  // Zero allocated and nothing hosted is a real 0%.
  const idle = W.workerUsage({ name: 'w', capacityCpu: '8', allocatedCpu: '0' }, 0);
  assert.equal(idle.cpu.reported, true);
  assert.equal(idle.cpu.frac, 0);
  const card = padLabelHTML({ name: 'w-1', pod: 'wk-01' }, real, true);
  assert.match(card, /CPU<\/span><span class="na">not reported/);
  assert.match(card, /Memory<\/span><span class="na">not reported/);
  assert.match(card, /capacity 8/);
  assert.match(card, /capacity 32 GiB/);
  assert.match(card, /1 \/ 1000/);
  // Only the slots bar is drawn on the pad (the others are scaled away).
  const g = new THREE.Group();
  const pads = new WorkerPads(g, fakeLabel);
  pads.sync([{ worker: { name: 'w-1', state: 'ACTIVE' }, x: 0, z: 0, usage: real }], THEMES[0], THREE.AdditiveBlending);
  const m4 = new THREE.Matrix4();
  const shown = [0, 1, 2].filter((k) => {
    pads.mesh.track.getMatrixAt(k, m4);
    return new THREE.Vector3().setFromMatrixScale(m4).x > 0;
  });
  assert.deepEqual(shown, [0]);
  pads.dispose();
});

test('grouping: agents without a worker are parked; counts include idle workers', () => {
  const m = new Model();
  m.applySnapshot({
    atespaces: [{ name: 'a' }, { name: 'b' }, { name: 'empty' }],
    workers: [{ name: 'w-0' }, { name: 'w-1' }],
    agents: [
      { atespace: 'a', name: 'x', state: 'RUNNING', worker: 'w-0' },
      { atespace: 'b', name: 'y', state: 'RESUMING', worker: 'w-0' },
      { atespace: 'a', name: 'z', state: 'SUSPENDED' },
      { atespace: 'b', name: 'q', state: 'RUNNING', worker: 'w-9' },
    ],
  });
  assert.equal(W.groupOf(m.agents.get('a/z'), 'worker'), PARKED);
  assert.equal(W.groupOf(m.agents.get('a/x'), 'worker'), 'w-0');
  assert.equal(W.groupOf(m.agents.get('a/x'), 'atespace'), 'a');
  assert.deepEqual(Object.fromEntries(W.groupCounts(m, 'worker')), { 'w-0': 2, 'w-1': 0, [PARKED]: 1, 'w-9': 1 });
  assert.deepEqual(Object.fromEntries(W.groupCounts(m, 'atespace')), { a: 2, b: 2, empty: 0 });
  assert.equal(W.groupId('worker'), 'worker');
  assert.equal(W.groupId('nonsense'), 'atespace');
});

test('switching groups keeps every agent placed in a slot of its own district', () => {
  const snap = syntheticSnapshot(1500);
  const m = new Model();
  m.applySnapshot(snap);
  for (const mode of ['atespace', 'worker', 'atespace', 'worker']) {
    const counts = W.groupCounts(m, mode);
    const plan =
      mode === 'worker'
        ? W.planWorkerView(
            [...counts].filter(([n]) => n !== PARKED).map(([name, count]) => ({ name, count, capacity: m.workers.get(name)?.capacityActors || 0 })),
            counts.get(PARKED),
          )
        : planIsland([...counts].map(([name, count]) => ({ name, count })));
    const tables = new Map([...plan.districts.keys()].map((k) => [k, new SlotTable(plan.districts.get(k).capacity)]));
    for (const [key, a] of m.agents) assert.ok(tables.get(W.groupOf(a, mode)).assign(key) >= 0, `${mode}: ${key}`);
  }
});

test('highlight: a worker pad lights its agents and dims the rest; an agent lights its worker softly', () => {
  const workerOf = (k) => ({ a: 'w-1', b: 'w-1', c: 'w-2' })[k];
  let f = W.focusOf({}, workerOf);
  assert.deepEqual(f, { worker: null, strong: false });
  assert.equal(W.levelOf(f, 'w-1'), HI.NONE);

  // Hovered (or pinned) pad: strong.
  f = W.focusOf({ hoverWorker: 'w-1' }, workerOf);
  assert.deepEqual(f, { worker: 'w-1', strong: true });
  assert.equal(W.levelOf(f, 'w-1'), HI.LIT);
  assert.equal(W.levelOf(f, 'w-2'), HI.DIM);
  assert.equal(W.levelOf(f, undefined), HI.DIM);

  // Selected agent: its worker, softly; nothing dims.
  f = W.focusOf({ selectedAgent: 'c' }, workerOf);
  assert.deepEqual(f, { worker: 'w-2', strong: false });
  assert.equal(W.levelOf(f, 'w-2'), HI.SIBLING);
  assert.equal(W.levelOf(f, 'w-1'), HI.NONE);

  // Hovering an agent wins over the selection; a pad wins over both.
  assert.equal(W.focusOf({ selectedAgent: 'c', hoverAgent: 'a' }, workerOf).worker, 'w-1');
  assert.deepEqual(W.focusOf({ selectedAgent: 'c', hoverAgent: 'a', pinnedWorker: 'w-2' }, workerOf), { worker: 'w-2', strong: true });
  assert.deepEqual(W.focusOf({ pinnedWorker: 'w-2', hoverWorker: 'w-1' }, workerOf), { worker: 'w-1', strong: true });
  // A hovered suspended agent (no worker) falls back to the selection.
  assert.equal(W.focusOf({ selectedAgent: 'a', hoverAgent: 'zzz' }, workerOf).worker, 'w-1');
  assert.ok(W.sameFocus({ worker: 'w-1', strong: true }, { worker: 'w-1', strong: true }));
  assert.ok(!W.sameFocus({ worker: 'w-1', strong: true }, { worker: 'w-1', strong: false }));
});

test('usage: quantities parse and format; unknown capacity stays unknown', () => {
  assert.equal(W.parseQuantity('500m'), 0.5);
  assert.equal(W.parseQuantity('4'), 4);
  assert.equal(W.parseQuantity('16Gi'), 16 * 2 ** 30);
  assert.equal(W.parseQuantity('1.5e3'), 1500);
  assert.equal(W.parseQuantity('2k'), 2000);
  assert.ok(Number.isNaN(W.parseQuantity('')));
  assert.ok(Number.isNaN(W.parseQuantity('12 apples')));
  assert.equal(W.formatCPU(0.75), '750m');
  assert.equal(W.formatCPU(3.5), '3.5');
  assert.equal(W.formatCPU(16), '16');
  assert.equal(W.formatBytes(13 * 2 ** 30), '13 GiB');
  assert.equal(W.formatBytes(512 * 2 ** 20), '512 MiB');

  const u = W.workerUsage({ capacityActors: 40, capacityCpu: '16', allocatedCpu: '4', capacityMemory: '64Gi', allocatedMemory: '16Gi' }, 10);
  assert.deepEqual(u.actors, { used: 10, cap: 40, frac: 0.25 });
  assert.equal(u.cpu.frac, 0.25);
  assert.equal(u.memory.frac, 0.25);
  const bare = W.workerUsage({ name: 'w' }, 3);
  assert.deepEqual(bare.actors, { used: 3, cap: 0, frac: 0 });
  assert.equal(bare.cpu, null);
  assert.equal(bare.memory, null);
  // The card says what it knows.
  const card = padLabelHTML({ name: 'w-1', pod: 'wk-01', node: 'n1', state: 'DRAINING' }, u, true);
  assert.match(card, /wk-01/);
  assert.match(card, /on n1/);
  assert.match(card, /10 agents/);
  assert.match(card, /4 \/ 16/);
  assert.match(card, /16 GiB \/ 64 GiB/);
  assert.match(card, /draining/);
  assert.match(padLabelHTML({ name: 'w-2' }, bare, true), /capacity unknown/);
});

test('atespace tints are stable and spread out', () => {
  const a = W.teamHues(['b', 'a', 'c']);
  assert.deepEqual([...a.keys()], ['a', 'b', 'c']);
  assert.deepEqual(W.teamHues(['c', 'b', 'a']), a);
  const hues = [...W.teamHues(Array.from({ length: 16 }, (_, i) => `t${i}`)).values()].sort();
  for (let i = 1; i < hues.length; i++) assert.ok(hues[i] - hues[i - 1] > 0.02);
  assert.match(W.teamCSS(0.5, THEMES[0]), /^hsl\(180 \d+% \d+%\)$/);
  assert.deepEqual(W.topTeams([{ atespace: 'x' }, { atespace: 'y' }, { atespace: 'y' }], 1), [{ name: 'y', count: 2 }]);
});

test('synthetic workers: varied capacity, allocations match the agents they hold', () => {
  const snap = syntheticSnapshot(5000);
  assert.equal(snap.workers.length, 12);
  const caps = new Set(snap.workers.map((w) => w.capacityActors));
  assert.ok(caps.size > 4, 'capacities differ');
  const held = new Map();
  for (const a of snap.agents) {
    if (a.state === 'SUSPENDED' || a.state === 'CRASHED') assert.equal(a.worker, undefined, `${a.name} holds no worker`);
    if (a.state === 'RUNNING' || a.state === 'RESUMING') assert.ok(a.worker, `${a.name} has a worker`);
    if (a.worker) held.set(a.worker, (held.get(a.worker) || 0) + 1);
  }
  for (const w of snap.workers) {
    assert.equal(w.allocatedActors, held.get(w.name) || 0, w.name);
    assert.ok(w.node && w.capacityCpu && w.capacityMemory && w.allocatedCpu && w.allocatedMemory, w.name);
    assert.ok(W.workerUsage(w, w.allocatedActors).cpu.frac < 1.5, `${w.name} cpu sane`);
  }
  assert.equal(snap.workers.filter((w) => w.state === 'DRAINING').length, 1);
});

test('synthetic churn reports worker allocations and never places agents on the draining worker', async () => {
  const events = [];
  const s = new SyntheticStream(300, { onStatus() {}, onSnapshot() {}, onEvents: (evs) => events.push(...evs) }, { every: 1e9 });
  const draining = s.workers.find((w) => w.state === 'DRAINING').name;
  for (let i = 0; i < 60; i++) s.churn();
  s.close();
  assert.ok(events.some((e) => e.type === 'worker_updated'));
  for (const e of events) if (e.type === 'agent_woke') assert.notEqual(e.agent.worker, draining);
  const last = new Map();
  for (const e of events) if (e.type === 'worker_updated') last.set(e.key, e.worker.allocatedActors);
  for (const [name, n] of last) assert.equal(n, [...s.agents.values()].filter((a) => a.worker === name).length, name);
});

// ------------------------------------------------------------- resources

/** Tracks every geometry, material and texture under obj. */
function resources(obj) {
  const out = new Set();
  obj.traverse((o) => {
    if (o.geometry) out.add(o.geometry);
    for (const m of [o.material].flat()) if (m) out.add(m);
  });
  return out;
}

function watch(things) {
  const disposed = new Set();
  for (const t of things) t.addEventListener('dispose', () => disposed.add(t));
  return disposed;
}

/** A stand-in for CSS2DObject: an Object3D with a fake element. */
function fakeLabel(cls) {
  const o = new THREE.Object3D();
  const classes = new Set([cls]);
  o.element = {
    innerHTML: '',
    removed: false,
    children: [],
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
      contains: (c) => classes.has(c),
    },
    remove() {
      this.removed = true;
    },
  };
  o.center = new THREE.Vector2();
  o.isCSS2DObject = true;
  return o;
}

function fakeText() {
  const g = new THREE.PlaneGeometry(4, 1);
  return new THREE.Mesh(g, new THREE.MeshBasicMaterial({ transparent: true }));
}

test('links: grow, swap-remove and dispose without leaking', () => {
  const parent = new THREE.Group();
  const links = new LinkSet(parent, { value: 0 });
  const first = [links.lines.geometry, links.dots.geometry];
  const disposedFirst = watch(first);
  const p = (x) => ({ x, y: 1, z: 0 });
  for (let i = 0; i < 200; i++) links.set(`k${i}`, p(i), p(0), 0, (i % 10) / 10, 0.5);
  assert.equal(links.count, 200);
  assert.ok(links.capacity >= 200);
  assert.equal(links.lines.geometry.instanceCount, 200);
  assert.equal(disposedFirst.size, 2, 'growing replaces the old geometries');
  // Removing moves the last link into the hole.
  links.remove('k3');
  assert.equal(links.count, 199);
  assert.equal(links.slots.get('k199'), 3);
  assert.equal(links.attrs.aFrom.array[3 * 3], 199);
  links.setLevel('k199', 2);
  assert.equal(links.attrs.aMeta.array[3 * 3], 2);
  links.setFrom('k199', 7, 8, 9);
  assert.deepEqual([...links.attrs.aFrom.array.subarray(9, 12)], [7, 8, 9]);
  // Clearing keeps the buffers (a relink reuses them).
  const cap = links.capacity;
  const geo = links.lines.geometry;
  links.clear();
  for (let i = 0; i < 100; i++) links.set(`k${i}`, p(i), p(0), 0, 0, 0);
  assert.equal(links.capacity, cap);
  assert.equal(links.lines.geometry, geo);
  const all = resources(parent);
  const disposed = watch(all);
  links.dispose();
  assert.equal(disposed.size, all.size);
  assert.equal(parent.children.length, 0);
});

test('pads: instanced (no per-pad meshes or materials); resync, update, labels, picking and dispose', () => {
  const parent = new THREE.Group();
  const pads = new WorkerPads(parent, fakeLabel, { labels: 8 });
  const theme = THEMES[0];
  const usage = (n) => W.workerUsage({ capacityActors: 20, capacityCpu: '8', allocatedCpu: '2' }, n);
  const items = (n) =>
    Array.from({ length: n }, (_, i) => ({ worker: { name: `w-${i}`, pod: `wk-${i}`, state: i === 5 ? 'DRAINING' : 'ACTIVE' }, x: (i % 50) * 4.2, z: Math.floor(i / 50) * 3, usage: usage(i % 7) }));
  const meshes = () => parent.children.filter((o) => o.isInstancedMesh);
  const materials = () => {
    const m = new Set();
    parent.traverse((o) => o.material && m.add(o.material));
    return m;
  };
  const mats0 = materials();
  pads.sync(items(2000), theme, THREE.AdditiveBlending);
  assert.equal(pads.count, 2000);
  assert.equal(meshes().length, 4, 'pads, glow, tracks, fills: four instanced meshes for 2,000 pads');
  assert.equal(pads.mesh.body.count, 2000);
  assert.equal(pads.mesh.track.count, 6000);
  assert.deepEqual([...materials()], [...mats0], 'no material per pad');
  // Bars: slots and CPU shown, the third (memory: not reported) scaled away.
  const m4 = new THREE.Matrix4();
  const sx = (mesh, k) => {
    mesh.getMatrixAt(k, m4);
    return new THREE.Vector3().setFromMatrixScale(m4).x;
  };
  assert.ok(sx(pads.mesh.track, 1 * 3) > 0);
  assert.ok(sx(pads.mesh.track, 1 * 3 + 1) > 0);
  assert.equal(sx(pads.mesh.track, 1 * 3 + 2), 0);
  // Shrinking reuses the meshes.
  const body = pads.mesh.body;
  pads.sync(items(10), theme, THREE.AdditiveBlending);
  assert.equal(pads.mesh.body, body);
  assert.equal(pads.mesh.body.count, 10);
  // An update rewrites one pad; only its range uploads.
  pads.flush();
  assert.ok(pads.update('w-3', items(10)[3].worker, usage(6)));
  assert.deepEqual(pads.ranges.pad.take(10), [{ start: 3, count: 1 }]);
  assert.equal(pads.update('nope', {}, usage(0)), false);
  // Focus: the pad's label grows into a card.
  pads.setFocus({ worker: 'w-2', strong: true });
  pads.showLabels([{ name: 'w-2', card: true }]);
  const card = pads.labelFor('w-2');
  assert.match(card.element.innerHTML, /Slots/);
  assert.ok(card.element.classList.contains('card'));
  pads.setFocus({ worker: null, strong: false });
  assert.ok(!card.element.classList.contains('card'));
  // The label pool caps how many show; the rest hide.
  pads.showLabels(items(10).map((it) => ({ name: it.worker.name, card: false })));
  assert.equal(pads.labelPool.filter((l) => l.visible).length, 8);
  pads.showLabels([]);
  assert.equal(pads.labelPool.filter((l) => l.visible).length, 0);
  // Picking by ground point.
  assert.equal(pads.at(4.2 * 2 + 1.0, 0.5), 'w-2');
  assert.equal(pads.at(4.2 * 2 + 2.0, 0), null);
  // Dispose frees every geometry and material and removes the labels.
  const all = resources(parent);
  for (const g of Object.values(pads.base)) all.add(g);
  const disposed = watch(all);
  pads.dispose();
  assert.equal(disposed.size, all.size);
  assert.equal(parent.children.length, 0);
});

test('switching the grouping rebuilds the ground and disposes the old one, every time', () => {
  const group = new THREE.Group();
  const m = new Model();
  m.applySnapshot(syntheticSnapshot(800));
  const plans = {
    atespace: planIsland([...W.groupCounts(m, 'atespace')].map(([name, count]) => ({ name, count }))),
    worker: (() => {
      const c = W.groupCounts(m, 'worker');
      return W.planWorkerView(
        [...c].filter(([n]) => n !== PARKED).map(([name, count]) => ({ name, count, capacity: m.workers.get(name)?.capacityActors || 0 })),
        c.get(PARKED),
      );
    })(),
  };
  const opts = { cluster: 'test', blending: THREE.NormalBlending, makeLabel: fakeLabel, makeText: fakeText };
  const counts = {};
  let prev = null;
  let prevLabels = [];
  for (let i = 0; i < 6; i++) {
    const mode = i % 2 ? 'worker' : 'atespace';
    const disposed = prev ? watch(prev) : new Set();
    const island = buildGround(group, plans[mode], THEMES[i % THEMES.length], opts);
    assert.ok(island.width > 0 && island.depth > 0);
    if (prev) assert.equal(disposed.size, prev.size, `rebuild ${i} disposes everything from the last one`);
    for (const l of prevLabels) assert.ok(l.removed, 'old labels removed');
    prev = resources(group);
    prevLabels = group.children.filter((c) => c.element).map((c) => c.element);
    // The same grouping always builds the same amount of stuff: no growth.
    if (counts[mode] !== undefined) assert.equal(group.children.length, counts[mode], `${mode} children`);
    counts[mode] = group.children.length;
    // Worker platforms get the worker kind, the parked area its own.
    const kinds = new Set([...plans[mode].districts.values()].map((d) => d.kind));
    assert.deepEqual([...kinds].sort(), mode === 'worker' ? ['parked', 'worker'] : ['atespace']);
    for (const d of plans[mode].districts.values()) assert.ok(d.label, `${d.name} has a label`);
  }
});
