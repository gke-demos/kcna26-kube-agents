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

// Scale: level-of-detail selection, aggregate counts, partial-update
// bookkeeping, the point and tile layers, picking through the agent grid,
// the hierarchical worker plan, the synthetic scale presets and the
// benchmark's camera path.

import { register } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';

register('../../hack/three-hooks.mjs', import.meta.url);
const THREE = await import('three');
const L = await import('./lod.js');
const { DirtyRanges, uploadRanges } = await import('./dirty.js');
const { PointLayer, CLASS_INDEX } = await import('./points.js');
const { AggregateTiles, tileFractions } = await import('./tiles.js');
const { AgentLayers } = await import('./agents.js');
const { shapeById } = await import('./shapes.js');
const { planIsland, slotPosition, slotAt, SlotTable, CELL } = await import('./layout.js');
const W = await import('./workers.js');
const S = await import('./synth.js');
const B = await import('./bench.js');

// ------------------------------------------------------------------ LOD

test('lod: cell pixels, the far crossfade and the reported level', () => {
  // 1.5-unit cells, 900 px tall view, 42 degrees: about 10 px at 165 units.
  const px = L.cellPixels(165, 900, 42);
  assert.ok(px > 9 && px < 12, `${px}`);
  assert.ok(Math.abs(L.depthForPixels(px, 900, 42) - 165) < 1e-6);
  assert.equal(L.farMix(0.5), 1, 'tiny cells: all tile');
  assert.equal(L.farMix(L.FAR_HI + 1), 0, 'big cells: all agents');
  const mid = L.farMix((L.FAR_LO + L.FAR_HI) / 2);
  assert.ok(mid > 0 && mid < 1, 'crossfade between');
  assert.equal(L.lodLevel(1, 0), 'far');
  assert.equal(L.lodLevel(20, 0), 'mid');
  assert.equal(L.lodLevel(20, 300), 'close');
  // A 100k island seen whole is far; a 5k island seen whole is not.
  assert.equal(L.lodLevel(L.cellPixels(800, 900, 42), 0), 'far');
  assert.notEqual(L.lodLevel(L.cellPixels(165, 900, 42), 0), 'far');
});

test('lod: nearest agents within the budget and radius, inside the frustum, without sorting', () => {
  const n = 20000;
  const pos = new Float32Array(n * 3);
  const live = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = (i % 200) * 1.5;
    pos[i * 3 + 2] = Math.floor(i / 200) * 1.5;
    live[i] = i % 10 === 7 ? 0 : 1;
  }
  const cam = { x: 150, y: 10, z: 75 };
  const all = L.selectNearest(pos, live, n, cam, 1e9, 30);
  const within = (i) => Math.hypot(pos[i * 3] - cam.x, pos[i * 3 + 1] - cam.y, pos[i * 3 + 2] - cam.z) <= 30;
  assert.ok(all.idx.length > 100);
  for (const i of all.idx) assert.ok(within(i) && live[i], `${i}`);
  assert.equal(all.radius, 30);
  // With a budget: exactly budget agents, and none outside the radius it reports is nearer than one inside.
  const sel = L.selectNearest(pos, live, n, cam, 500, 30);
  assert.equal(sel.idx.length, 500);
  assert.ok(sel.radius < 30);
  const d = (i) => Math.hypot(pos[i * 3] - cam.x, pos[i * 3 + 1] - cam.y, pos[i * 3 + 2] - cam.z);
  const chosen = new Set(sel.idx);
  for (const i of chosen) assert.ok(d(i) <= sel.radius + 1e-4);
  for (const i of all.idx) if (!chosen.has(i)) assert.ok(d(i) >= sel.radius - 1e-4);
  // Restricted to a subset (the districts within reach), the same agents
  // inside it come back.
  const subset = Int32Array.from(all.idx.filter((i) => i % 3 === 0));
  const sub = L.selectNearest(pos, live, n, cam, 1e9, 30, null, 2, subset);
  assert.deepEqual([...sub.idx].sort((a, b) => a - b), [...subset].sort((a, b) => a - b));
  // A frustum plane (keep x >= 150) halves the candidates.
  const half = L.selectNearest(pos, live, n, cam, 1e9, 30, [{ x: 1, y: 0, z: 0, c: -150 }], 0);
  for (const i of half.idx) assert.ok(pos[i * 3] >= 150);
  assert.ok(half.idx.length < all.idx.length * 0.6);
});

test('aggregates: counts per district and class follow adds, removes, moves and filter changes', () => {
  const a = new L.Aggregates();
  a.add('payments', 'running', true, 'payments');
  a.add('payments', 'suspended', false, 'payments');
  a.add('w-1', 'running', true, 'search');
  a.add('w-1', 'running', true, 'payments');
  let c = a.get('payments');
  assert.deepEqual({ total: c.total, running: c.running, suspended: c.suspended, match: c.match }, { total: 2, running: 1, suspended: 1, match: 1 });
  // A state change: out of one class, into another.
  a.remove('payments', 'suspended', false, 'payments');
  a.add('payments', 'crashed', true, 'payments');
  c = a.get('payments');
  assert.equal(c.suspended, 0);
  assert.equal(c.crashed, 1);
  assert.equal(c.match, 2);
  // Teams per worker, and a district emptied is forgotten.
  assert.deepEqual([...a.get('w-1').teams], [['search', 1], ['payments', 1]]);
  a.remove('w-1', 'running', true, 'search');
  a.remove('w-1', 'running', true, 'payments');
  assert.equal(a.get('w-1').total, 0);
  assert.ok(!a.groups.has('w-1'));
  // Sums for a pool tile.
  a.add('w-2', 'running', true, 'x');
  a.add('w-3', 'transition', true, 'x');
  const sum = a.sum(['w-2', 'w-3', 'w-404']);
  assert.deepEqual({ total: sum.total, running: sum.running, transition: sum.transition }, { total: 2, running: 1, transition: 1 });
  assert.deepEqual(tileFractions({ total: 4, running: 2, transition: 1, crashed: 1, pending: 0 }), [0.5, 0.25, 0.25, 0]);
  assert.deepEqual(tileFractions({ total: 0, running: 0, transition: 0, crashed: 0, pending: 0 }), [0, 0, 0, 0]);
});

// ------------------------------------------------------ partial updates

test('dirty ranges: coalesced, sorted, full upload when cheaper', () => {
  const r = new DirtyRanges();
  assert.deepEqual(r.take(1000), []);
  for (const i of [500, 3, 4, 5, 7, 900, 501, 2000]) r.mark(i);
  assert.deepEqual(r.take(1000, { gap: 4 }), [
    { start: 3, count: 5 },
    { start: 500, count: 2 },
    { start: 900, count: 1 },
  ]);
  assert.ok(!r.dirty, 'take resets');
  // Too many ranges, or too much of the buffer: everything (null).
  for (let i = 0; i < 100; i++) r.mark(i * 50);
  assert.equal(r.take(5000, { gap: 4, maxRanges: 48 }), null);
  for (let i = 0; i < 400; i++) r.mark(i);
  assert.equal(r.take(1000), null);
  r.markAll();
  r.mark(5);
  assert.equal(r.take(1000), null);
  // Upload: ranges in array elements (itemSize), or the whole buffer.
  const a = new THREE.BufferAttribute(new Float32Array(400), 4);
  uploadRanges([a], [{ start: 10, count: 2 }]);
  assert.deepEqual(a.updateRanges, [{ start: 40, count: 8 }]);
  assert.equal(a.version, 1);
  uploadRanges([a], null);
  assert.deepEqual(a.updateRanges, []);
  assert.equal(a.version, 2);
  uploadRanges([a], []);
  assert.equal(a.version, 2, 'nothing written, nothing uploaded');
});

const look = () => ({
  uScale: { value: 600 },
  uFarLo: { value: L.FAR_LO },
  uFarHi: { value: L.FAR_HI },
  uCloseNear: { value: 10 },
  uCloseFar: { value: 12 },
  uAllShapes: { value: 0 },
  uHiDim: { value: 0.7 },
  uDimColor: { value: new THREE.Color() },
  uTeam: { value: 0 },
  uTeamSat: { value: 0.5 },
  uTeamLight: { value: 0.5 },
  uAdditive: { value: 1 },
});

test('points: stable indices, reuse, growth, and uploads of only what changed', () => {
  const parent = new THREE.Group();
  const pts = new PointLayer(parent, { value: 0 }, look());
  const idx = Array.from({ length: 3000 }, () => pts.alloc());
  assert.equal(pts.count, 3000);
  assert.ok(pts.capacity >= 3000, 'grew');
  assert.equal(pts.geometry.drawRange.count, 3000);
  pts.flush();
  // One agent changes state: one range per attribute it touched.
  pts.setClass(idx[1234], CLASS_INDEX.crashed);
  pts.setFlash(idx[1234], 5);
  pts.flush();
  assert.deepEqual(pts.attrs.aA.updateRanges, [{ start: 1234 * 4, count: 4 }]);
  assert.deepEqual(pts.attrs.aB.updateRanges, [{ start: 1234 * 4, count: 4 }]);
  assert.deepEqual(pts.attrs.position.updateRanges, [], 'position untouched');
  // Freed indices stop drawing and are reused; the draw range keeps its end.
  pts.free(idx[10]);
  assert.equal(pts.live[idx[10]], 0);
  assert.equal(pts.attrs.aB.array[idx[10] * 4 + 3], 0);
  assert.equal(pts.alloc(), idx[10]);
  assert.equal(pts.count, 3000);
  pts.setDim(5, 1);
  pts.setNear(5, true);
  assert.equal(pts.attrs.aA.array[5 * 4 + 2], 1);
  assert.equal(pts.attrs.aB.array[5 * 4 + 1], 1);
  pts.setFocus(7, true);
  assert.equal(pts.uniforms.uFocusW.value, 7);
  pts.clear();
  assert.equal(pts.count, 0);
  const disposed = watch([pts.geometry, pts.material]);
  pts.dispose();
  assert.equal(disposed.size, 2);
  assert.equal(parent.children.length, 0);
});

test('agent layers upload only the slots written', () => {
  const parent = new THREE.Group();
  const agents = new AgentLayers(parent, shapeById('orb'), { value: 0 }, look());
  const run = agents.layers.running;
  for (let i = 0; i < 200; i++) run.add(`k${i}`);
  run.flush();
  run.mesh.instanceMatrix.array[57 * 16] = 3;
  run.markSlot(57);
  run.flush();
  assert.deepEqual(run.mesh.instanceMatrix.updateRanges, [{ start: 57 * 16, count: 16 }]);
  assert.deepEqual(run.attrs.aDim.updateRanges, [{ start: 57, count: 1 }]);
  // A swap-remove marks the hole it fills.
  run.remove(10);
  run.flush();
  assert.deepEqual(run.mesh.instanceColor.updateRanges, [{ start: 10 * 3, count: 3 }]);
  agents.dispose();
});

test('far tiles: one instance per district, counts written per tile, disposed cleanly', () => {
  const parent = new THREE.Group();
  const tiles = new AggregateTiles(parent, { value: 0 }, look());
  const agg = new L.Aggregates();
  for (let i = 0; i < 30; i++) agg.add(`d${i % 3}`, i % 5 ? 'suspended' : 'running', true, 'x');
  const list = Array.from({ length: 40 }, (_, i) => ({ name: `d${i}`, x: i * 10, z: 0, w: 8, d: 6, groups: [`d${i}`] }));
  list.push({ name: 'pool', x: 0, z: 20, w: 30, d: 10, groups: ['d0', 'd1'] });
  tiles.sync(list, (t) => agg.sum(t.groups));
  assert.equal(tiles.count, 41);
  assert.equal(tiles.tileOf('d2'), 2);
  assert.equal(tiles.attrs.aInfo.array[0], 10);
  assert.ok(Math.abs(tiles.attrs.aFrac.array[0] - 0.2) < 1e-6);
  assert.equal(tiles.attrs.aInfo.array[40 * 4], 20, 'a pool tile sums its workers');
  tiles.write(3, { total: 4, running: 4, transition: 0, crashed: 0, pending: 0, match: 0 });
  assert.deepEqual(tiles.ranges.take(41), [{ start: 3, count: 1 }]);
  assert.equal(tiles.attrs.aInfo.array[3 * 4 + 1], 0, 'nothing matches the filter');
  const all = [tiles.mesh.geometry, tiles.base, tiles.material];
  const disposed = watch(all);
  tiles.dispose();
  assert.equal(disposed.size, all.length);
  assert.equal(parent.children.length, 0);
});

// ---------------------------------------------------------------- picking

test('slot tables reuse the lowest freed slot and map slots back to agents', () => {
  const t = new SlotTable(100);
  for (let i = 0; i < 50; i++) t.assign(`k${i}`);
  for (const i of [30, 4, 17, 4]) t.release(`k${i}`);
  assert.equal(t.keyAt(4), undefined);
  assert.equal(t.assign('a'), 4);
  assert.equal(t.assign('b'), 17);
  assert.equal(t.assign('c'), 30);
  assert.equal(t.assign('d'), 50);
  assert.equal(t.keyAt(17), 'b');
  // slotAt inverts slotPosition.
  const plan = planIsland([{ name: 'x', count: 300 }]);
  const d = plan.districts.get('x');
  for (const s of [0, 7, 120, d.capacity - 1]) {
    const p = slotPosition(d, s);
    assert.equal(slotAt(d, p.x + 0.3, p.z - 0.3), s);
  }
  assert.equal(slotAt(d, d.x - 5, d.z), -1);
});

test('picking walks the agent grid along the ray: the nearest body wins, misses miss', () => {
  const plan = planIsland(
    Array.from({ length: 60 }, (_, i) => ({ name: `a${i}`, count: 50 + i * 30 })),
  );
  const ds = [...plan.districts.values()];
  const index = new L.RectIndex(ds);
  const slots = new Map(ds.map((d) => [d.name, new SlotTable(d.capacity)]));
  const recs = new Map();
  for (const d of ds) {
    for (let s = 0; s < Math.min(d.capacity, 60); s++) {
      const key = `${d.name}/${s}`;
      slots.get(d.name).assign(key);
      const p = slotPosition(d, s);
      recs.set(key, { x: p.x, z: p.z, top: 1.2 });
    }
  }
  // The rect index finds the district under a point.
  for (const d of ds) assert.equal(index.at(d.x + d.w / 2, d.z + d.d / 2), d);
  assert.equal(index.at(1e6, 1e6), null);
  const opts = {
    lookup: (x, z) => {
      const d = index.at(x, z);
      if (!d) return null;
      const s = slotAt(d, x, z);
      return s < 0 ? null : slots.get(d.name).keyAt(s) || null;
    },
    body: (key) => {
      const r = recs.get(key);
      return r ? { x: r.x, z: r.z, y0: 0.1, y1: r.top, r: 0.62 } : null;
    },
  };
  // Aim at a few agents from an oblique camera above the island: each is picked.
  for (const key of ['a0/0', 'a10/33', 'a59/59', 'a33/12']) {
    const r = recs.get(key);
    const cam = new THREE.Vector3(r.x - 15, 30, r.z + 25);
    const dir = new THREE.Vector3(r.x, 0.8, r.z).sub(cam).normalize();
    assert.equal(L.pickRay(cam, dir, opts), key, key);
  }
  const cam = new THREE.Vector3(0, 40, 60);
  // Looking at empty sky or straight up: nothing.
  assert.equal(L.pickRay(cam, new THREE.Vector3(0, 1, 0), opts), null);
  const sky = new THREE.Vector3(1e5, 0.5, -1e5).sub(cam).normalize();
  assert.equal(L.pickRay(cam, sky, opts), null);
  // Two agents on the line of sight: the nearer one wins.
  const d0 = ds[0];
  const front = slotPosition(d0, d0.cols * 3);
  const back = slotPosition(d0, 0);
  const eye = new THREE.Vector3(front.x, 3, front.z + (front.z - back.z) * 0.5);
  const dir = new THREE.Vector3(back.x, 0.3, back.z).sub(eye).normalize();
  // Rows 2 and 3 are empty (only the first 60 slots hold agents), so the
  // first body along the ray is row 1's, in front of row 0's target.
  assert.ok(d0.cols * 2 >= 60);
  assert.equal(L.pickRay(eye, dir, opts), `${d0.name}/${d0.cols}`, 'the first body along the ray');
});

// -------------------------------------------------------- worker hierarchy

test('worker view at 2,000 workers: pools, nodes, platforms; nothing overlaps; far tiles per pool', () => {
  const snap = S.syntheticSnapshot(100000, 7, { workers: 2000 });
  const held = new Map();
  for (const a of snap.agents) if (a.worker) held.set(a.worker, (held.get(a.worker) || 0) + 1);
  const workers = snap.workers.map((w) => ({ name: w.name, count: held.get(w.name) || 0, capacity: w.capacityActors, pool: w.pool, node: w.node }));
  const parked = snap.agents.length - [...held.values()].reduce((a, b) => a + b, 0);
  const t0 = performance.now();
  const plan = W.planWorkerView(workers, parked);
  assert.ok(performance.now() - t0 < 500, 'plans fast');
  const pools = plan.frames.filter((f) => f.kind === 'pool');
  const nodes = plan.frames.filter((f) => f.kind === 'node');
  assert.equal(pools.length, new Set(snap.workers.map((w) => w.pool)).size);
  assert.ok(nodes.length > pools.length);
  assert.equal(plan.districts.size, 2001);
  // Every platform holds its agents, sits inside its node and pool frame.
  const poolOf = new Map(pools.map((p) => [p.name, p]));
  const inside = (a, b) => a.x >= b.x - 1e-6 && a.z >= b.z - 1e-6 && a.x + a.w <= b.x + b.w + 1e-6 && a.z + a.d <= b.z + b.d + 1e-6;
  for (const w of workers) {
    const d = plan.districts.get(w.name);
    assert.ok(d.capacity >= w.count, w.name);
    assert.ok(inside(d, poolOf.get(w.pool)), `${w.name} in pool ${w.pool}`);
  }
  for (const n of nodes) assert.ok(inside(n, poolOf.get(n.pool)), `node ${n.name}`);
  // Pools don't overlap each other or the parked area.
  const boxes = [...pools, plan.districts.get(W.PARKED)];
  const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.z < b.z + b.d && b.z < a.z + a.d;
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) assert.ok(!overlaps(boxes[i], boxes[j]), `${boxes[i].name} / ${boxes[j].name}`);
  // Platforms in one node don't overlap.
  const plats = [...plan.districts.values()].filter((d) => d.kind === 'worker');
  const byNode = new Map();
  for (const d of plats) {
    const k = `${d.pool}/${d.node}`;
    if (!byNode.has(k)) byNode.set(k, []);
    byNode.get(k).push(d);
  }
  for (const list of byNode.values()) for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) assert.ok(!overlaps(list[i], list[j]));
  // Far tiles: the parked area and one per pool, covering every worker once.
  assert.equal(plan.tiles.length, pools.length + 1);
  const covered = plan.tiles.flatMap((t) => t.groups);
  assert.equal(new Set(covered).size, covered.length);
  assert.equal(covered.length, 2001);
  // Roughly landscape.
  assert.ok(plan.width > plan.depth * 0.6 && plan.width < plan.depth * 4, `${plan.width.toFixed(0)} x ${plan.depth.toFixed(0)}`);
});

test('pad area: one pool is the old centered rows; many pools are framed blocks', () => {
  const one = W.planPadArea(Array.from({ length: 12 }, (_, i) => ({ name: `w-${i}`, pod: `wk-${i}`, pool: 'default' })), 30);
  assert.equal(one.frames.length, 0);
  assert.equal(one.depth, W.PAD_ROW * Math.ceil(12 / Math.floor(34 / W.PAD_SPACING)));
  assert.ok(Math.abs(one.items[0].x + one.items[Math.floor(34 / W.PAD_SPACING) - 1].x) < 1e-9, 'centered');
  const snap = S.syntheticSnapshot(10000, 7, { workers: 2000 });
  const many = W.planPadArea(snap.workers, 300);
  assert.equal(many.items.length, 2000);
  assert.equal(many.frames.length, new Set(snap.workers.map((w) => w.pool)).size);
  const frameOf = new Map(many.frames.flatMap((f) => f.workers.map((n) => [n, f])));
  for (const it of many.items) {
    const f = frameOf.get(it.name);
    assert.ok(it.x > f.x && it.x < f.x + f.w && it.z > f.z && it.z < f.z + f.d, it.name);
  }
  // Pads never overlap.
  const seen = new Set(many.items.map((it) => `${it.x.toFixed(2)},${it.z.toFixed(2)}`));
  assert.equal(seen.size, 2000);
});

// -------------------------------------------------------------- synthetic

test('synthetic scale presets: node pools of 20 to 100 workers, several per node, steady churn', () => {
  const opts = S.syntheticOptions(new URLSearchParams('synthetic=100000&workers=2000&churn=500'));
  assert.deepEqual(opts, { workerCap: 0, resources: true, workers: 2000, churn: 500 });
  const ws = S.syntheticWorkers(100000, S.rng(8), { workers: 2000 });
  assert.equal(ws.length, 2000);
  const pools = new Map();
  const nodes = new Map();
  for (const w of ws) {
    pools.set(w.pool, (pools.get(w.pool) || 0) + 1);
    nodes.set(w.node, (nodes.get(w.node) || 0) + 1);
  }
  const sizes = [...pools.values()];
  for (const n of sizes.slice(0, -1)) assert.ok(n >= 20 && n <= 100, `pool of ${n}`);
  assert.ok([...nodes.values()].every((n) => n >= 1 && n <= 8));
  assert.ok(nodes.size < 2000 / 2, 'several workers per node');
  assert.equal(new Set(ws.map((w) => w.name)).size, 2000);
  // The default stays 12 workers in one pool.
  assert.equal(S.syntheticWorkers(5000, S.rng(8)).length, 12);
  // Churn: about rate/10 state changes per 100 ms batch, and the running share holds.
  assert.equal(S.defaultChurn(100000), 1000);
  assert.equal(S.defaultChurn(5000), 2);
  let changes = 0;
  const s = new S.SyntheticStream(20000, { onStatus() {}, onSnapshot() {}, onEvents: (evs) => (changes += evs.filter((e) => e.type.startsWith('agent_')).length) }, { workers: 200, every: 100 });
  assert.equal(s.perTick, 20);
  const share = () => [...s.agents.values()].filter((a) => a.state === 'RUNNING').length / s.agents.size;
  const before = share();
  for (let i = 0; i < 2000; i++) s.churn();
  s.close();
  assert.equal(changes, 40000);
  assert.ok(Math.abs(share() - before) < 0.04, `running share ${before.toFixed(3)} -> ${share().toFixed(3)}`);
  // Load kept incrementally matches a recount.
  for (const w of s.workers) assert.equal(s.load.get(w.name), [...s.agents.values()].filter((a) => a.worker === w.name).length);
});

// ------------------------------------------------------------------ bench

test('bench: a fixed camera path through far, mid and close, and its summary', () => {
  const island = { cx: 0, cz: 0, width: 800, depth: 500 };
  const dist = (t) => {
    const p = B.benchPose(t, island);
    return Math.hypot(p.position[0] - p.target[0], p.position[1] - p.target[1], p.position[2] - p.target[2]);
  };
  assert.ok(dist(3) > 600, 'far');
  assert.ok(dist(10) < 100 && dist(10) > 20, 'mid');
  assert.ok(dist(18) < 20, 'close');
  assert.deepEqual(B.benchPose(12.34, island), B.benchPose(12.34, island), 'deterministic');
  assert.equal(B.benchPhase(0), 'far');
  assert.equal(B.benchPhase(6.5), 'mid');
  assert.equal(B.benchPhase(19.99), 'close');
  const samples = [];
  for (let t = 0; t < 20; t += 0.02) samples.push({ t, dt: t < 6 ? 10 : 20, calls: 30, tris: 1e5 });
  const rows = B.summarize(samples);
  assert.deepEqual(rows.map((r) => r.phase), ['far', 'mid', 'close', 'all']);
  assert.ok(Math.abs(rows[0].fps - 100) < 1e-6);
  assert.ok(Math.abs(rows[1].fps - 50) < 1e-6);
  assert.equal(rows[1].p95Ms, 20);
  const text = B.formatSummary({ agents: 100000, gpu: 'test' }, rows);
  assert.match(text, /agents: 100000/);
  assert.match(text, /^far\s+\d+\s+100\.0\s+10\.0/m);
  void CELL;
});

function watch(things) {
  const disposed = new Set();
  for (const t of things) t.addEventListener('dispose', () => disposed.add(t));
  return disposed;
}
