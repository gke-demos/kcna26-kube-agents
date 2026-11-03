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

// The controls tour's script and clock: it covers every control in the
// design doc's Interaction table, pause / next / previous keep their
// bookkeeping, beats in progress end when the step changes, and the user's
// state is back after the tour.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { STEPS, ANCHORS, TourController, MAX_DT, ease, stepKeys, howRows, snapshotState, restoreState } from './tour.js';

/** The "Do" column of docs/design.md's Interaction table. */
function interactionRows() {
  const md = fs.readFileSync(new URL('../../docs/design.md', import.meta.url), 'utf8');
  const sec = md.split('### Interaction')[1].split('\n\n')[1];
  return sec
    .split('\n')
    .filter((l) => l.startsWith('|') && !l.startsWith('|---') && !l.startsWith('| Do '))
    .map((l) => l.split('|')[1].trim());
}

test('the tour shows every control in the Interaction table', () => {
  const rows = interactionRows();
  assert.ok(rows.length >= 12, `found ${rows.length} rows`);
  const covered = new Set(STEPS.flatMap((s) => s.covers));
  for (const r of rows) {
    if (r === 'Controls tour') continue;
    assert.ok(covered.has(r), `no tour step covers "${r}"`);
  }
  for (const c of covered) assert.ok(rows.includes(c), `step covers "${c}", which is not a row of the table`);
});

test('every step has a caption, a way to do it and well-formed beats', () => {
  const ids = new Set();
  for (const s of STEPS) {
    assert.ok(!ids.has(s.id), `duplicate step ${s.id}`);
    ids.add(s.id);
    assert.ok(s.title && howRows(s).length > 0, s.id);
    assert.ok(s.dur >= 4 && s.dur <= 8, `${s.id} lasts ${s.dur} s`);
    assert.ok(s.beats.some((b) => b.label), `${s.id} never says which movement is running`);
    for (const b of s.beats) {
      assert.ok(b.at >= 0 && b.at + b.dur <= s.dur, `${s.id}: beat ${b.kind} at ${b.at} runs past the step`);
      assert.ok(['move', 'orbit', 'pan', 'arrow', 'zoom', 'deck', 'press', 'click', 'spot'].includes(b.kind), b.kind);
      if (b.kind === 'move') assert.ok(ANCHORS.includes(b.to) || b.to.startsWith('dom:'), b.to);
      if (b.kind === 'press') assert.ok(b.keys?.length && b.act, `${s.id}: press without keys or act`);
    }
  }
});

test('the steps show the keys of the Interaction table', () => {
  const keys = new Set(STEPS.flatMap(stepKeys));
  for (const k of ['Shift', 'Alt', 'Control', 'L', 'R', 'B', 'F', 'H', 'G', '1', '2', '3', '+', '−', 'Esc', '←', '→']) assert.ok(keys.has(k), `no step shows ${k}`);
});

test('ease runs 0 to 1 and is monotonic', () => {
  assert.equal(ease(0), 0);
  assert.equal(ease(1), 1);
  let last = 0;
  for (let p = 0.05; p <= 1; p += 0.05) {
    assert.ok(ease(p) >= last);
    last = ease(p);
  }
});

/** A host that records what the tour asks of it. */
function fakeHost() {
  const h = {
    log: [],
    state: { n: 1 },
    snapshot: () => ({ ...h.state }),
    restore: (s) => {
      h.state = { ...s };
      h.log.push(['restore']);
    },
    prepare: (step) => {
      h.state.n = 99;
      h.log.push(['prepare', step.id]);
    },
    begin: (b) => h.log.push(['begin', b.kind]),
    update: (b, p, prev) => {
      assert.ok(p > prev, 'progress only grows');
      h.log.push(['update', b.kind, p]);
    },
    end: (b) => h.log.push(['end', b.kind]),
  };
  return h;
}

const steps = [
  { id: 'a', dur: 2, beats: [{ at: 0.5, dur: 1, kind: 'deck', label: 'A' }] },
  { id: 'b', dur: 2, beats: [{ at: 0, dur: 0.5, kind: 'press', label: 'B' }] },
  { id: 'c', dur: 2, beats: [] },
];

function run(ctl, seconds) {
  for (let t = 0; t < seconds; t += 0.05) ctl.tick(0.05);
}

test('a single pass plays every step, then stops and puts the state back', () => {
  const h = fakeHost();
  let ended = 0;
  const ctl = new TourController(h, steps, { onEnd: () => ended++ });
  ctl.start();
  assert.equal(ctl.index, 0);
  run(ctl, 6.5);
  assert.equal(ctl.running, false);
  assert.equal(ended, 1);
  assert.deepEqual(h.state, { n: 1 });
  assert.deepEqual(
    h.log.filter((l) => l[0] === 'prepare').map((l) => l[1]),
    ['a', 'b', 'c'],
  );
  assert.equal(h.log.at(-1)[0], 'restore');
});

test('looping starts over instead of stopping', () => {
  const h = fakeHost();
  const ctl = new TourController(h, steps, { loop: true });
  ctl.start();
  run(ctl, 6.5);
  assert.equal(ctl.running, true);
  assert.equal(ctl.index, 0);
  assert.equal(ctl.passes, 1);
  ctl.stop();
  assert.deepEqual(h.state, { n: 1 });
});

test('pause holds the clock; next and previous move between steps', () => {
  const h = fakeHost();
  const ctl = new TourController(h, steps);
  ctl.start();
  ctl.tick(0.05);
  ctl.pause();
  const t = ctl.t;
  run(ctl, 3);
  assert.equal(ctl.t, t);
  assert.equal(ctl.index, 0);
  ctl.togglePause();
  assert.equal(ctl.paused, false);
  ctl.next();
  assert.equal(ctl.index, 1);
  assert.equal(ctl.t, 0.0);
  ctl.next();
  assert.equal(ctl.index, 2);
  ctl.prev();
  assert.equal(ctl.index, 1);
  run(ctl, 1.6);
  ctl.prev(); // a while into the step: back to its start
  assert.equal(ctl.index, 1);
  assert.equal(ctl.t, 0);
  ctl.prev();
  ctl.prev();
  assert.equal(ctl.index, 0);
  // Next on the last step of a single pass ends the tour.
  ctl.next();
  ctl.next();
  ctl.next();
  assert.equal(ctl.running, false);
  assert.deepEqual(h.state, { n: 1 });
});

test('a beat in progress ends when the step changes or the tour stops', () => {
  const h = fakeHost();
  const ctl = new TourController(h, steps);
  ctl.start();
  run(ctl, 0.8);
  assert.ok(ctl.active.size === 1, 'the drag is under way');
  assert.equal(ctl.current.label, 'A');
  ctl.next();
  const ends = h.log.filter((l) => l[0] === 'end' && l[1] === 'deck');
  assert.equal(ends.length, 1, 'the drag let go');
  ctl.prev();
  run(ctl, 0.8);
  ctl.stop();
  assert.equal(h.log.filter((l) => l[0] === 'end' && l[1] === 'deck').length, 2);
  assert.equal(ctl.active.size, 0);
});

test('long frames advance at most MAX_DT, so no beat is skipped', () => {
  const h = fakeHost();
  const ctl = new TourController(h, steps);
  ctl.start();
  ctl.tick(5);
  assert.equal(ctl.t, MAX_DT);
  assert.equal(ctl.index, 0);
});

test('reduced motion: every beat jumps to its end as it starts', () => {
  const h = fakeHost();
  const ctl = new TourController(h, steps, { reduced: true });
  ctl.start();
  run(ctl, 0.6);
  const ups = h.log.filter((l) => l[0] === 'update');
  assert.deepEqual(ups, [['update', 'deck', 1]]);
  assert.ok(h.log.some((l) => l[0] === 'end' && l[1] === 'deck'));
});

test('progress runs from 0 to 1 over the pass', () => {
  const ctl = new TourController(fakeHost(), steps, { loop: true });
  ctl.start();
  assert.equal(ctl.progress, 0);
  run(ctl, 3);
  assert.ok(ctl.progress > 0.45 && ctl.progress < 0.55, String(ctl.progress));
});

// ----------------------------------------------------- snapshot / restore

class V {
  constructor(x = 0, y = 0, z = 0) {
    Object.assign(this, { x, y, z });
  }
  clone() {
    return new V(this.x, this.y, this.z);
  }
  copy(v) {
    Object.assign(this, { x: v.x, y: v.y, z: v.z });
    return this;
  }
}

/** A stand-in for Scene and main.js with the members the tour saves and puts back. */
function fakeApp() {
  const off = () => ({ agents: { x: 0, y: 0, z: 0 }, workers: { x: 0, y: 0, z: 0 }, linked: true });
  const scene = {
    camera: { position: new V(1, 2, 3) },
    controls: { target: new V(0, 0, 0), update() {} },
    offsets: { ...off(), workers: { x: 5, y: -2, z: 1 }, linked: false },
    deckView: 'agents',
    beamMode: 'all',
    layout: 'decks',
    groupPref: 'worker',
    pinnedWorker: 'w-1',
    deckDrag: null,
    copyDeckOffsets() {
      return JSON.parse(JSON.stringify(this.offsets));
    },
    setDeckOffsets(o) {
      this.offsets = JSON.parse(JSON.stringify(o));
    },
    setDecksLinked(on) {
      this.offsets.linked = on;
    },
    setDeckView(v) {
      this.deckView = v;
    },
    pinWorker(n) {
      this.pinnedWorker = n;
    },
    endDeckDrag() {
      this.deckDrag = null;
    },
  };
  const app = {
    sel: 'ns/a1',
    scroll: 'pan',
    selected: () => app.sel,
    scrollMode: () => app.scroll,
    select: (k) => (app.sel = k),
    setLayout: (l) => (scene.layout = l),
    setGroup: (g) => (scene.groupPref = g),
    setBeams: (b) => (scene.beamMode = b),
    setScroll: (s) => (app.scroll = s),
  };
  return { scene, app };
}

test('the tour puts back the camera, decks, view, beams, layout, grouping, selection and scroll mode', () => {
  const { scene, app } = fakeApp();
  const saved = snapshotState(scene, app);
  const want = JSON.parse(JSON.stringify({ ...saved, selected: app.sel, scroll: app.scroll }));
  // What the tour does along the way.
  scene.camera.position.copy(new V(50, 60, 70));
  scene.controls.target.copy(new V(9, 9, 9));
  scene.offsets = { agents: { x: 30, y: 0, z: 0 }, workers: { x: -4, y: -10, z: 0 }, linked: true };
  scene.deckView = 'both';
  scene.beamMode = 'focus';
  scene.layout = 'combined';
  scene.groupPref = 'atespace';
  scene.pinnedWorker = null;
  scene.deckDrag = { id: 'agents' };
  app.sel = 'other/b';
  app.scroll = 'zoom';
  restoreState(scene, app, saved);
  assert.deepEqual(JSON.parse(JSON.stringify(snapshotState(scene, app))), want);
  assert.equal(scene.deckDrag, null);
});
