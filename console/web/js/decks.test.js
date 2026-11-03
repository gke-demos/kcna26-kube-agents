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

// The two-decks layout: the worker deck's geometry, beam and ribbon
// counts, the highlight rules, the beam budget, the beam and ribbon
// layers, and switching layouts disposing what the other layout built.

import { register } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';

register('../../hack/three-hooks.mjs', import.meta.url);
const THREE = await import('three');
const D = await import('./decks.js');
const W = await import('./workers.js');
const S = await import('./synth.js');
const { Model } = await import('./model.js');
const { BeamSet, RibbonSet, BEAM_SEGMENTS } = await import('./beams.js');
const { buildWorkerDeck } = await import('./island.js');
const { THEMES } = await import('./themes.js');
const { compact } = await import('./format.js');
const { Scene } = await import('./scene.js');

const PAD_W = 3.2;
const PAD_D = 1.8;

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

function fakeLabel(cls) {
  const o = new THREE.Object3D();
  const classes = new Set([cls]);
  o.element = {
    innerHTML: '',
    removed: false,
    classList: { add: (...c) => c.forEach((x) => classes.add(x)), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), contains: (c) => classes.has(c) },
    remove() {
      this.removed = true;
    },
  };
  o.center = new THREE.Vector2();
  o.isCSS2DObject = true;
  return o;
}

function fakeText() {
  return new THREE.Mesh(new THREE.PlaneGeometry(4, 1), new THREE.MeshBasicMaterial({ transparent: true }));
}

const agentDeck = { cx: -1.2, cz: 0.4, width: 300, depth: 190 };

// ----------------------------------------------------------- geometry

test('worker deck: every pad on the slab, none overlapping, pools framed, a gap below the agent deck', () => {
  for (const [n, count] of [
    [12, 12],
    [5000, 2000],
  ]) {
    const workers = S.syntheticWorkers(n * 10, S.rng(3), { workers: count });
    const deck = D.planWorkerDeck(workers, agentDeck);
    assert.equal(deck.items.length, count);
    // Below the agent deck by the gap, centered left to right, front edges lined up.
    assert.ok(deck.y < 0 && Math.abs(deck.y + deck.gap) < 1e-9);
    assert.ok(deck.gap >= 16);
    assert.ok(Math.abs(deck.cx - agentDeck.cx) < 1e-9);
    assert.ok(Math.abs(deck.cz + deck.depth / 2 - (agentDeck.cz + agentDeck.depth / 2)) < 1e-9, 'front edges line up');
    const x0 = deck.cx - deck.width / 2;
    const z0 = deck.cz - deck.depth / 2;
    for (const it of deck.items) {
      assert.ok(it.x - PAD_W / 2 >= x0 && it.x + PAD_W / 2 <= x0 + deck.width, `${it.name} inside in x`);
      assert.ok(it.z - PAD_D / 2 >= z0 && it.z + PAD_D / 2 <= z0 + deck.depth, `${it.name} inside in z`);
    }
    // Pads never overlap (grid hash on pad cells).
    const seen = new Map();
    for (const it of deck.items) {
      const k = `${Math.round(it.x * 10)},${Math.round(it.z * 10)}`;
      assert.ok(!seen.has(k), `${it.name} and ${seen.get(k)} share a spot`);
      seen.set(k, it.name);
    }
    const sorted = [...deck.items].sort((a, b) => a.z - b.z || a.x - b.x);
    for (let i = 1; i < sorted.length; i++) {
      const a = sorted[i - 1];
      const b = sorted[i];
      if (Math.abs(a.z - b.z) < PAD_D) assert.ok(Math.abs(a.x - b.x) >= PAD_W, `${a.name} / ${b.name}`);
    }
    // Roughly landscape, whatever the count.
    assert.ok(deck.width / deck.depth > 0.9 && deck.width / deck.depth < 3.5, `${deck.width}x${deck.depth}`);
    // One far tile per pool, holding exactly its workers; every worker maps to its tile.
    const pools = new Set(workers.map((w) => w.pool));
    assert.equal(deck.tiles.length, pools.size);
    assert.equal(deck.frames.length, pools.size > 1 ? pools.size : 0);
    const inTiles = deck.tiles.flatMap((t) => t.groups);
    assert.equal(new Set(inTiles).size, count);
    for (const w of workers) assert.ok(deck.tiles.find((t) => t.name === deck.poolOf.get(w.name))?.groups.includes(w.name));
    // Each pad sits inside its pool's tile.
    const at = new Map(deck.items.map((it) => [it.name, it]));
    for (const t of deck.tiles) {
      for (const name of t.groups) {
        const it = at.get(name);
        assert.ok(it.x >= t.x && it.x <= t.x + t.w && it.z >= t.z && it.z <= t.z + t.d, `${name} in ${t.name}`);
      }
    }
  }
});

test('worker deck: no workers still plans a small deck; the gap grows with the decks', () => {
  const deck = D.planWorkerDeck([], agentDeck);
  assert.equal(deck.items.length, 0);
  assert.ok(deck.width > 0 && deck.depth > 0);
  const small = D.deckGap({ depth: 20 }, { depth: 10 });
  const big = D.deckGap({ depth: 500 }, { depth: 200 });
  assert.ok(small >= 16 && big > small && big <= 420);
});

test('layouts and deck views: ids, keys and fades', () => {
  assert.equal(D.layoutId('combined'), 'combined');
  assert.equal(D.layoutId('nope'), 'decks');
  assert.equal(D.layoutId(undefined), D.DEFAULT_LAYOUT);
  assert.deepEqual(D.deckAlphas('both'), { agents: 1, workers: 1 });
  assert.deepEqual(D.deckAlphas(D.DECK_KEYS[1]), { agents: 1, workers: 0 });
  assert.deepEqual(D.deckAlphas(D.DECK_KEYS[2]), { agents: 0, workers: 1 });
  assert.deepEqual(D.deckAlphas(D.DECK_KEYS[3]), { agents: 1, workers: 1 });
  assert.equal(D.deckViewId('sideways'), 'both');
});

// ----------------------------------------------------------- flows

test('flows: agents holding a worker per atespace -> pool pair, kept incrementally', () => {
  const m = new Model();
  m.applySnapshot(S.syntheticSnapshot(20000, 7, { workers: 300 }));
  const deck = D.planWorkerDeck([...m.workers.values()], agentDeck);
  const flows = new D.FlowCounts();
  let holders = 0;
  for (const a of m.agents.values()) {
    if (!a.worker) continue;
    holders++;
    flows.add(a.atespace, deck.poolOf.get(a.worker), 1);
  }
  assert.equal(flows.total, holders);
  assert.equal(flows.live().reduce((s, p) => s + p.count, 0), holders, 'every holder in exactly one ribbon');
  // Brute force: the same counts.
  const brute = new Map();
  for (const a of m.agents.values()) {
    if (!a.worker) continue;
    const k = D.pairKey(a.atespace, deck.poolOf.get(a.worker));
    brute.set(k, (brute.get(k) || 0) + 1);
  }
  for (const [k, n] of brute) assert.equal(flows.pairs.get(k).count, n);
  assert.ok(flows.pairs.size <= m.atespaces.size * deck.tiles.length);
  // A suspend takes one away, a wake on another pool adds one; both pairs are dirty.
  flows.take();
  const a = [...m.agents.values()].find((x) => x.worker);
  const pool = deck.poolOf.get(a.worker);
  const other = deck.tiles.find((t) => t.name !== pool).name;
  const before = flows.get(a.atespace, pool);
  flows.add(a.atespace, pool, -1);
  flows.add(a.atespace, other, 1);
  assert.equal(flows.get(a.atespace, pool), before - 1);
  assert.deepEqual(flows.take().sort(), [D.pairKey(a.atespace, pool), D.pairKey(a.atespace, other)].sort());
  assert.deepEqual(flows.take(), []);
  // An unknown worker (no pool) never counts; zero pairs stay, drawn as nothing.
  flows.add('x', undefined, 1);
  assert.equal(flows.get('x', undefined), 0);
  flows.add('lone', other, 1);
  flows.add('lone', other, -1);
  assert.ok(flows.pairs.has(D.pairKey('lone', other)));
  assert.ok(!flows.live().some((p) => p.atespace === 'lone'));
  flows.clear();
  assert.equal(flows.pairs.size, 0);
  assert.equal(flows.total, 0);
});

test('ribbon sizes: area-true, never thinner than a hairline, nothing for empty pairs', () => {
  assert.deepEqual(D.ribbonSize(0, 10, 8), { width: 0, strength: 0 });
  const full = D.ribbonSize(100, 100, 8);
  const quarter = D.ribbonSize(25, 100, 8);
  const tiny = D.ribbonSize(1, 1e6, 8);
  assert.equal(full.width, 8);
  assert.ok(Math.abs(quarter.width - 4) < 1e-9, 'a quarter of the agents: half the width');
  assert.ok(tiny.width >= 8 * 0.08 && tiny.width < 1);
  assert.ok(full.strength === 1 && quarter.strength < 1 && tiny.strength >= 0.25);
});

// ----------------------------------------------------------- highlight

test('highlight: beams light for the agent, its worker and that worker\'s agents; ribbons for the hovered tile', () => {
  const { HI } = W;
  const none = { worker: null, strong: false };
  const pinned = { worker: 'w-1', strong: true };
  const soft = { worker: 'w-1', strong: false };
  // Beams.
  assert.equal(D.beamLevel(none, 'w-1', false), HI.NONE);
  assert.equal(D.beamLevel(none, 'w-1', true), 3, 'the selected or hovered agent: brightest');
  assert.equal(D.beamLevel(pinned, 'w-1', false), HI.LIT, 'a pinned worker lights its agents');
  assert.equal(D.beamLevel(pinned, 'w-2', false), HI.DIM, '...and dims the rest');
  assert.equal(D.beamLevel(soft, 'w-1', false), HI.SIBLING, 'an agent in focus lifts its siblings');
  assert.equal(D.beamLevel(soft, 'w-2', false), HI.NONE, '...and dims nothing');
  // Ribbons.
  const p = { atespace: 'payments', pool: 'general-a', count: 5 };
  assert.equal(D.ribbonLevel(p, null), HI.NONE);
  assert.equal(D.ribbonLevel(p, { kind: 'atespace', name: 'payments' }), HI.LIT);
  assert.equal(D.ribbonLevel(p, { kind: 'atespace', name: 'search' }), HI.DIM);
  assert.equal(D.ribbonLevel(p, { kind: 'pool', name: 'general-a' }), HI.LIT);
  assert.equal(D.ribbonLevel(p, { kind: 'pool', name: 'spot-b' }), HI.DIM);
  assert.equal(D.ribbonLevel(p, null, 'general-a', true), HI.SIBLING, 'a pinned worker lifts its pool\'s ribbons');
  assert.equal(D.ribbonLevel(p, null, 'general-a', false), HI.NONE);
  // Lit tiles: the hovered one and the other ends of its ribbons that carry agents.
  const flows = new D.FlowCounts();
  flows.add('payments', 'general-a', 3);
  flows.add('payments', 'spot-b', 1);
  flows.add('search', 'general-a', 2);
  flows.add('docs', 'spot-b', 1);
  flows.add('docs', 'spot-b', -1);
  const a = D.litTiles(flows, { kind: 'atespace', name: 'payments' });
  assert.deepEqual([...a.atespaces], ['payments']);
  assert.deepEqual([...a.pools].sort(), ['general-a', 'spot-b']);
  const b = D.litTiles(flows, { kind: 'pool', name: 'spot-b' });
  assert.deepEqual([...b.atespaces], ['payments'], 'docs carries no agents to spot-b any more');
  assert.deepEqual([...b.pools], ['spot-b']);
  assert.equal(D.litTiles(flows, null).atespaces.size, 0);
  assert.ok(D.sameTile(null, null) && D.sameTile({ kind: 'pool', name: 'x' }, { kind: 'pool', name: 'x' }));
  assert.ok(!D.sameTile({ kind: 'pool', name: 'x' }, { kind: 'atespace', name: 'x' }) && !D.sameTile(null, { kind: 'pool', name: 'x' }));
});

test('beam budget: every holder while they fit, else the nearest plus the ones that must show', () => {
  const holders = new Set(Array.from({ length: 50 }, (_, i) => `a${i}`));
  const all = D.beamSet(holders, 100, () => assert.fail('no nearest pass under the budget'));
  assert.equal(all.keys.size, 50);
  assert.equal(all.trimmed, false);
  const near = () => Array.from({ length: 50 }, (_, i) => `a${i}`);
  const cut = D.beamSet(holders, 10, near, ['a49', 'not-a-holder']);
  assert.equal(cut.trimmed, true);
  assert.equal(cut.keys.size, 10);
  assert.ok(cut.keys.has('a49'), 'the selected agent keeps its beam');
  assert.ok(!cut.keys.has('not-a-holder'));
  assert.ok(cut.keys.has('a0') && !cut.keys.has('a20'), 'nearest first');
});

// ----------------------------------------------------------- layers

test('beams: drop, retract and expire; swap-remove; growth; dispose', () => {
  const parent = new THREE.Group();
  const time = { value: 0 };
  const beams = new BeamSet(parent, time, {}, { value: 1 });
  const at = (i) => ({ x: i, y: 0.1, z: 0 });
  const pad = { x: 0, y: -20, z: 5 };
  for (let i = 0; i < 300; i++) beams.set(`a${i}`, at(i), pad, 0, 1, 0.5, i);
  assert.equal(beams.count, 300);
  assert.equal(beams.lines.geometry.instanceCount, 300);
  // A wake: the beam's animation starts dropping now.
  time.value = 5;
  beams.set('a7', at(7), pad, 0, 1, 0.5, 7, 5);
  const anim = (k) => {
    const i = beams.set_.slots.get(k);
    return [...beams.set_.attrs.aAnim.array.slice(i * 3, i * 3 + 3)];
  };
  assert.deepEqual(anim('a7'), [5, 1, 0]);
  // A suspend: retracts, then goes away when the animation ends.
  assert.ok(beams.retract('a3', 6, 0.7));
  assert.deepEqual(anim('a3'), [6, -1, 0]);
  beams.expire(6.5);
  assert.ok(beams.has('a3'));
  beams.expire(6.8);
  assert.ok(!beams.has('a3'));
  assert.equal(beams.count, 299);
  // Woken again while retracting: the beam stays (no expiry).
  beams.retract('a4', 7, 0.7);
  beams.set('a4', at(4), pad, 0, 1, 0.5, 4, 7.2);
  beams.expire(9);
  assert.ok(beams.has('a4'));
  // The last beam moved into the hole kept its endpoints.
  const i = beams.set_.slots.get('a299');
  assert.equal(beams.set_.attrs.aFrom.array[i * 3], 299);
  // Class changes rewrite one float.
  beams.setClass('a5', 2);
  assert.equal(beams.set_.attrs.aMeta.array[beams.set_.slots.get('a5') * 4], 2);
  const all = resources(parent);
  const disposed = watch(all);
  beams.dispose();
  assert.equal(disposed.size, all.size);
  assert.equal(parent.children.length, 0);
});

test('ribbons: one instance per pair, zero width hides, levels rewrite, dispose', () => {
  const parent = new THREE.Group();
  const ribbons = new RibbonSet(parent, { value: 0 }, {}, { value: 1 });
  for (let i = 0; i < 40; i++) ribbons.set(`p${i}`, { x: i, y: -2, z: 0 }, { x: 0, y: -30, z: 4 }, i % 5 === 0 ? 0 : 1 + i * 0.1, 0.5, 0, 0.3);
  assert.equal(ribbons.count, 40);
  assert.equal(ribbons.visibleCount, 32);
  ribbons.setLevel('p3', 2);
  assert.equal(ribbons.set_.attrs.aInfo.array[ribbons.set_.slots.get('p3') * 4 + 2], 2);
  ribbons.remove('p3');
  assert.equal(ribbons.count, 39);
  const all = resources(parent);
  const disposed = watch(all);
  ribbons.dispose();
  assert.equal(disposed.size, all.size);
  assert.equal(parent.children.length, 0);
});

test('switching layouts disposes the decks\' layers and the worker deck, every time', () => {
  // The scene's own create/dispose methods, on a stand-in for the scene
  // (the real one needs a WebGL canvas).
  const world = new THREE.Group();
  const workerDeck = new THREE.Group();
  const fake = {
    world,
    workerDeck,
    time: { value: 0 },
    look: {},
    fade: { agents: { value: 1 }, workers: { value: 1 }, beams: { value: 1 } },
    beams: null,
    applyFlow() {},
    styleDecks() {},
  };
  const ensure = Scene.prototype.ensureDeckLayers;
  const dispose = Scene.prototype.disposeDeckLayers;
  const ground = new THREE.Group();
  const workers = S.syntheticWorkers(50000, S.rng(1), { workers: 500 });
  const deck = D.planWorkerDeck(workers, agentDeck);
  let counts = null;
  for (let i = 0; i < 4; i++) {
    ensure.call(fake);
    ensure.call(fake);
    assert.ok(fake.beams && fake.ribbons && fake.workerTiles);
    assert.ok(fake.needCompile, 'new layers ask for a shader warm-up');
    const theme = THEMES[i % THEMES.length];
    buildWorkerDeck(ground, deck, theme, { blending: THREE.NormalBlending, makeLabel: fakeLabel, makeText: fakeText });
    const now = { world: world.children.length, deck: workerDeck.children.length, ground: ground.children.length };
    if (counts) assert.deepEqual(now, counts, 'no growth from switch to switch');
    counts = now;
    assert.equal(ground.children.filter((c) => c.isCSS2DObject).length, deck.frames.length, 'one label per pool frame');
    // Back to 'combined': everything the decks built goes.
    const all = new Set([...resources(world), ...resources(workerDeck), ...resources(ground)]);
    const labels = ground.children.filter((c) => c.isCSS2DObject).map((c) => c.element);
    const disposed = watch(all);
    dispose.call(fake);
    dispose.call(fake);
    buildWorkerDeck(ground, deck, theme, { blending: THREE.NormalBlending, makeLabel: fakeLabel, makeText: fakeText });
    const kept = resources(ground);
    for (const r of kept) all.delete(r);
    ground.clear();
    assert.equal(fake.beams, null);
    assert.equal(world.children.length, 0, 'beams and ribbons removed');
    assert.equal(workerDeck.children.length, 0, 'pool tiles removed');
    assert.ok([...all].every((r) => disposed.has(r)), 'every geometry and material disposed');
    assert.ok(labels.every((l) => l.removed), 'pool labels removed');
  }
});

test('header counts stay short at scale', () => {
  assert.equal(compact(0), '0');
  assert.equal(compact(9876), '9,876');
  assert.equal(compact(10234), '10.2k');
  assert.equal(compact(89512), '89.5k');
  assert.equal(compact(99960), '100k');
  assert.equal(compact(100000), '100k');
  assert.equal(compact(1250000), '1.3M');
});

// ------------------------------------------------------- movable decks

const lim = D.deckLimits(40, 300);

test('deck offsets: linked moves keep the decks together, unlinked move one', () => {
  const o = D.defaultOffsets();
  assert.ok(o.linked && D.isDefaultOffsets(o));
  const a = D.moveDeck(o, 'workers', { x: 10, z: -4 }, lim);
  assert.deepEqual(a.workers, { x: 10, y: 0, z: -4 });
  assert.deepEqual(a.agents, { x: 10, y: 0, z: -4 }, 'linked: the other deck moves the same');
  assert.deepEqual(D.relOffset(a), { x: 0, y: 0, z: 0 });
  assert.ok(D.isDefaultOffsets(o), 'the input is not modified');
  const u = D.moveDeck({ ...a, linked: false }, 'agents', { x: -25, z: 3 }, lim);
  assert.deepEqual(u.agents, { x: -15, y: 0, z: -1 });
  assert.deepEqual(u.workers, { x: 10, y: 0, z: -4 }, 'unlinked: only the grabbed deck');
  assert.deepEqual(D.relOffset(u), { x: 25, y: 0, z: -3 });
  // Linked again: both move, the relative offset stays.
  const l = D.moveDeck({ ...u, linked: true }, 'agents', { x: 5 }, lim);
  assert.deepEqual(D.relOffset(l), D.relOffset(u));
});

test('deck offsets: height changes the gap, clamped so the decks never meet; slides stay within reach', () => {
  const o = D.defaultOffsets();
  // Lowering the worker deck widens the gap; raising the agent deck too.
  const down = D.moveDeck(o, 'workers', { y: -15 }, lim);
  assert.equal(D.gapOf(down, lim.base), 55);
  assert.equal(down.agents.y, 0, 'linked or not, height moves only the grabbed deck');
  const up = D.moveDeck(o, 'agents', { y: 7 }, lim);
  assert.equal(D.gapOf(up, lim.base), 47);
  // Pushing either deck through the other stops at the minimum gap.
  for (const [deck, dy] of [['workers', 500], ['agents', -500]]) {
    const m = D.moveDeck(o, deck, { y: dy }, lim);
    assert.equal(D.gapOf(m, lim.base), lim.minGap, deck);
    assert.ok(lim.minGap >= D.DECK_MIN_GAP || lim.base < D.DECK_MIN_GAP);
  }
  assert.equal(D.gapOf(D.moveDeck(o, 'workers', { y: -1e4 }, lim), lim.base), lim.maxGap);
  // Slides stop at the reach; linked decks stop together.
  const far = D.moveDeck({ ...o, linked: false }, 'workers', { x: 50 }, lim);
  const both = D.moveDeck({ ...far, linked: true }, 'agents', { x: 1e6 }, lim);
  assert.equal(both.workers.x, lim.reach);
  assert.equal(both.agents.x, lim.reach - 50, 'the relative offset survives the clamp');
  // Clamping a stored arrangement to a smaller plan.
  const c = D.clampOffsets({ agents: { x: 1e4, y: 0, z: 0 }, workers: { x: 0, y: 50, z: 0 }, linked: false }, lim);
  assert.equal(c.agents.x, lim.reach);
  assert.equal(D.gapOf(c, lim.base), lim.minGap);
});

test('deck offsets: persistence round-trips and survives junk; easing settles', () => {
  const o = D.moveDeck({ ...D.defaultOffsets(), linked: false }, 'workers', { x: 12.3456, y: -3, z: 1 }, lim);
  const back = D.parseOffsets(D.serializeOffsets(o));
  assert.deepEqual(back, { agents: { x: 0, y: 0, z: 0 }, workers: { x: 12.35, y: -3, z: 1 }, linked: false });
  for (const junk of [null, '', 'nope', '[]', '42', '{"agents": "x"}', '{"workers": {"x": "1e9"}}', '{"agents": {"x": 1e99}}']) {
    const p = D.parseOffsets(junk);
    assert.ok(Number.isFinite(p.agents.x) && Math.abs(p.agents.x) < 1e5 && Number.isFinite(p.workers.x), String(junk));
    assert.equal(typeof p.linked, 'boolean');
  }
  assert.equal(D.parseOffsets('{"linked": false}').linked, false);
  // A reset eases back to the plan and stops.
  let cur = o;
  let steps = 0;
  for (let moving = true; moving && steps < 200; steps++) ({ offsets: cur, moving } = D.easeOffsets(cur, D.defaultOffsets(), 0.2));
  assert.ok(steps < 200 && D.isDefaultOffsets(cur));
});

test('deck picking: rims and bodies with offsets, rims win over the glass above', () => {
  const agents = { cx: 0, cz: 0, width: 100, depth: 60 };
  const workers = { cx: 0, cz: 10, width: 40, depth: 30 };
  const tol = () => 1;
  assert.equal(D.slabZone(0, 0, agents, 1), 'body');
  assert.equal(D.slabZone(50.5, 0, agents, 1), 'rim');
  assert.equal(D.slabZone(49.2, 0, agents, 1), 'rim');
  assert.equal(D.slabZone(52, 0, agents, 1), null);
  // A ray straight down at (x, z).
  const down = (x, z) => [{ x, y: 100, z }, { x: 0, y: -1, z: 0 }];
  const decks = (off) => [
    { id: 'agents', rect: agents, y: 0, off: { x: 0, z: 0 } },
    { id: 'workers', rect: workers, y: -40, off },
  ];
  // Over the agent deck's middle: the agent deck's body (nearest).
  assert.equal(D.deckAt(...down(0, 0), decks({ x: 0, z: 0 }), tol).id, 'agents');
  // The worker deck's rim under the glass wins over the agent deck's body.
  const r = D.deckAt(...down(20, 10), decks({ x: 0, z: 0 }), tol);
  assert.deepEqual([r.id, r.zone], ['workers', 'rim']);
  // Slid 200 to the right: found there (in its own coordinates), not under the agents.
  const off = { x: 200, z: -5 };
  const w = D.deckAt(...down(210, 2), decks(off), tol);
  assert.deepEqual([w.id, w.zone, w.x, w.z], ['workers', 'body', 10, 7]);
  assert.equal(D.deckAt(...down(20, 10), decks(off), tol).id, 'agents');
  assert.equal(D.deckAt(...down(400, 0), decks(off), tol), null);
  // Rays that don't meet a plane.
  assert.equal(D.rayAtY({ x: 0, y: 10, z: 0 }, { x: 1, y: 0, z: 0 }, 0), null);
  assert.equal(D.rayAtY({ x: 0, y: 10, z: 0 }, { x: 0, y: 1, z: 0 }, 0), null);
  // Pixels to world units: the full view height at depth d is 2 d tan(fov/2).
  assert.ok(Math.abs(D.unitsPerPixel(100, 90, 1000) - 0.2) < 1e-9);
});

test('scene picking follows the worker deck\'s offset: pads, pool tiles, and the beams\' and ribbons\' lower ends', () => {
  const workers = S.syntheticWorkers(2000, S.rng(3), { workers: 60 });
  const deck = D.planWorkerDeck(workers, agentDeck);
  const pads = new Map(deck.items.map((it) => [it.name, it]));
  const ray = { origin: new THREE.Vector3(), direction: new THREE.Vector3(0, -1, 0) };
  const fake = {
    layout: 'decks',
    deck,
    deckA: { agents: 1, workers: 1 },
    shown: D.defaultOffsets(),
    offsets: D.defaultOffsets(),
    pads: { at: (x, z) => [...pads.values()].find((p) => Math.abs(p.x - x) < 1.6 && Math.abs(p.z - z) < 0.9)?.name || null },
    rayAt: () => ray,
    farAt: () => true,
    distIndex: { at: () => null },
  };
  const workerOrigin = Scene.prototype.workerOrigin;
  fake.workerOrigin = workerOrigin;
  const it = deck.items[7];
  const aim = (x, z) => ray.origin.set(x, 200, z);
  aim(it.x, it.z);
  assert.equal(Scene.prototype.pickWorker.call(fake, 0, 0), it.name);
  // Slide the worker deck (unlinked): the pad is found where it is drawn now.
  fake.shown = { ...D.moveDeck({ ...D.defaultOffsets(), linked: false }, 'workers', { x: 300, y: -10, z: 20 }, D.deckLimits(deck.gap, 400)) };
  assert.notEqual(Scene.prototype.pickWorker.call(fake, 0, 0), it.name);
  aim(it.x + 300, it.z + 20);
  assert.equal(Scene.prototype.pickWorker.call(fake, 0, 0), it.name);
  assert.equal(Scene.prototype.pickTile.call(fake, 0, 0).name, deck.poolOf.get(it.name));
  const o = workerOrigin.call(fake);
  assert.deepEqual([o.x, o.y, o.z], [300, deck.y - 10, 20]);
  // Moving the agent deck instead (linked) changes nothing relative: same origin as planned.
  fake.shown = D.moveDeck(D.defaultOffsets(), 'agents', { x: 50, z: 5 }, D.deckLimits(deck.gap, 400));
  const p = workerOrigin.call(fake);
  assert.deepEqual([p.x, p.y, p.z], [0, deck.y, 0]);
  // Beams and ribbons take the worker deck's origin as a uniform: no rewrite.
  const beams = new BeamSet(new THREE.Group(), { value: 0 }, {}, { value: 1 });
  const ribbons = new RibbonSet(new THREE.Group(), { value: 0 }, {}, { value: 1 });
  beams.set('a', { x: 0, y: 0.1, z: 0 }, { x: it.x, y: 0.4, z: it.z }, 0, 1, 0.5, 0);
  beams.set_.ranges.take(1);
  beams.setWorkerOffset(300, -50, 20);
  ribbons.setWorkerOffset(300, -50, 20);
  assert.deepEqual(beams.uniforms.uToOff.value.toArray(), [300, -50, 20]);
  assert.deepEqual(ribbons.uniforms.uToOff.value.toArray(), [300, -50, 20]);
  assert.equal(beams.set_.ranges.take(1)?.length ?? 0, 0, 'no instance rewritten');
});

// ------------------------------------------------- beam focus, bundles

test('focus beams: only what must show and recent changes still in their time', () => {
  const holders = new Set(['a', 'b', 'c', 'd']);
  const recent = new Map([
    ['c', 10],
    ['d', 4],
    ['zz', 10],
  ]);
  assert.deepEqual([...D.focusBeams(holders, ['a', 'x'], recent, 5)].sort(), ['a', 'c']);
  assert.deepEqual([...D.focusBeams(holders, [], recent, 11)], []);
  assert.equal(D.beamModeId('all'), 'all');
  assert.equal(D.beamModeId('bogus'), 'focus');
  // The scene's rule: focus mode allows the must-show agents and recent changes only.
  const fake = {
    beams: {},
    beamMode: 'focus',
    time: { value: 5 },
    recentBeams: recent,
    selected: 'a',
    hovered: null,
    focus: { worker: 'w2' },
    pads: { get: (w) => (w ? {} : null) },
    beamMust: Scene.prototype.beamMust,
  };
  const rec = (key, worker) => ({ key, agent: { worker } });
  const allowed = (r) => Scene.prototype.beamAllowed.call(fake, r);
  assert.ok(allowed(rec('a', 'w1')), 'selected');
  assert.ok(allowed(rec('q', 'w2')), 'on the worker in focus');
  assert.ok(allowed(rec('c', 'w1')), 'recent');
  assert.ok(!allowed(rec('d', 'w1')), 'recent, but its time is up');
  assert.ok(!allowed(rec('b', 'w1')), 'nothing to show it for');
  assert.ok(!allowed(rec('a', null)), 'no worker, no beam');
  fake.beamMode = 'all';
  fake.beamsTrimmed = false;
  assert.ok(allowed(rec('b', 'w1')), "'all' under the budget: every holder");
});

test('bundles: beams of a pair share their inner control points and run close together; beta 0 is straight', () => {
  const d = { x: 0, z: 0 };
  const q = { x: 40, z: 30 };
  const agents = [
    { x: -6, y: 0, z: -4 },
    { x: 7, y: 0, z: 5 },
    { x: 3, y: 0, z: -7 },
  ];
  const pads = [
    { x: 35, y: -40, z: 26 },
    { x: 46, y: -40, z: 33 },
    { x: 41, y: -40, z: 24 },
  ];
  const spread = (pts) => Math.max(...pts.flatMap((a) => pts.map((b) => Math.hypot(a.x - b.x, a.z - b.z))));
  const mids = (beta) => agents.map((a, i) => D.bezier(a, ...D.bundleControls(a, pads[i], d, q, beta), pads[i], 0.5));
  assert.ok(spread(mids(D.BUNDLE)) < spread(mids(0)) * 0.4, 'bundled beams meet in the middle');
  // Ends stay where they are.
  const [c1, c2] = D.bundleControls(agents[0], pads[0], d, q, D.BUNDLE);
  assert.deepEqual(D.bezier(agents[0], c1, c2, pads[0], 0), agents[0]);
  const end = D.bezier(agents[0], c1, c2, pads[0], 1);
  assert.ok(Math.abs(end.x - pads[0].x) < 1e-9 && Math.abs(end.y - pads[0].y) < 1e-9);
  // Unbundled: on the straight line.
  const [s1, s2] = D.bundleControls(agents[1], pads[1], d, q, 0);
  for (const t of [0.25, 0.5, 0.8]) {
    const p = D.bezier(agents[1], s1, s2, pads[1], t);
    for (const k of ['x', 'y', 'z']) assert.ok(Math.abs(p[k] - (agents[1][k] + (pads[1][k] - agents[1][k]) * t)) < 1e-9);
  }
  // The layer: bundling swaps in a curved strip, keeping every beam; recent beams fade, then go.
  const beams = new BeamSet(new THREE.Group(), { value: 0 }, {}, { value: 1 });
  for (let i = 0; i < 70; i++) beams.set(`a${i}`, agents[i % 3], pads[i % 3], 0, 1, 0.5, i, undefined, { dx: d.x, dz: d.z, qx: q.x, qz: q.z });
  const attr = beams.lines.geometry.getAttribute('aFrom');
  beams.setBundle(D.BUNDLE);
  assert.equal(beams.lines.geometry.getAttribute('position').count, 2 * (BEAM_SEGMENTS + 1));
  assert.equal(beams.lines.geometry.getAttribute('aFrom'), attr, 'same instance buffers');
  assert.equal(beams.lines.geometry.instanceCount, 70);
  beams.setBundle(0);
  assert.equal(beams.lines.geometry.getAttribute('position').count, 4);
  const i = beams.set_.slots.get('a5');
  assert.deepEqual([...beams.set_.attrs.aBundle.array.slice(i * 4, i * 4 + 4)], [0, 0, 40, 30]);
  assert.ok(beams.fadeOut('a5', 3));
  assert.ok(beams.leaving('a5'));
  assert.equal(beams.expire(3.5), 0);
  assert.equal(beams.expire(3 + beams.uniforms.uFadeDur.value), 1);
  assert.ok(!beams.has('a5'));
  // Set again while fading: it stays.
  beams.fadeOut('a6', 3);
  beams.set('a6', agents[0], pads[0], 0, 1, 0.5, 6);
  assert.equal(beams.expire(100), 0);
  assert.ok(beams.has('a6'));
});

test('wheel: mouse wheels and pinches zoom, trackpad scrolls pan', () => {
  const w = new D.WheelKind();
  assert.equal(w.classify({ deltaX: 0, deltaY: 100, deltaMode: 0, ctrlKey: false }, 0), 'zoom');
  assert.equal(w.classify({ deltaX: 0, deltaY: 3, deltaMode: 1, ctrlKey: false }, 1000), 'zoom');
  assert.equal(w.classify({ deltaX: 0, deltaY: 1.5, deltaMode: 0, ctrlKey: true }, 2000), 'zoom', 'pinch');
  assert.equal(w.classify({ deltaX: 4, deltaY: 12, deltaMode: 0, ctrlKey: false }, 3000), 'pan');
  // A fast trackpad flick looks like a wheel step, but it is mid-stream.
  assert.equal(w.classify({ deltaX: 0, deltaY: 120, deltaMode: 0, ctrlKey: false }, 3100), 'pan');
  assert.equal(w.classify({ deltaX: 0, deltaY: 120, deltaMode: 0, ctrlKey: false }, 5000), 'zoom');
});

// A Magic Mouse swipe sends small pixel deltas, exactly like a trackpad, so
// 'auto' pans with it. 'zoom' mode makes every scroll zoom (Shift+scroll
// pans); 'pan' makes every scroll pan; Control always zooms.
test('wheel: scroll mode overrides the wheel/trackpad guess', () => {
  const swipe = { deltaX: 0, deltaY: 6.5, deltaMode: 0, ctrlKey: false, shiftKey: false };
  const w = new D.WheelKind();
  assert.equal(w.classify(swipe, 0), 'pan', 'auto: a Magic Mouse swipe pans');
  w.mode = 'zoom';
  assert.equal(w.classify(swipe, 1000), 'zoom');
  assert.equal(w.classify({ ...swipe, shiftKey: true }, 2000), 'pan', 'Shift+scroll pans in zoom mode');
  w.mode = 'pan';
  assert.equal(w.classify({ deltaX: 0, deltaY: 100, deltaMode: 0, ctrlKey: false, shiftKey: false }, 3000), 'pan');
  assert.equal(w.classify({ ...swipe, ctrlKey: true }, 4000), 'zoom', 'Control+scroll always zooms');
  assert.equal(D.scrollModeId('zoom'), 'zoom');
  assert.equal(D.scrollModeId('sideways'), 'auto');
});
