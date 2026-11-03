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

// The controls tour (?demo=controls, the ? button or the ? key): a scripted
// walkthrough that performs every way of moving around the scene, one step
// at a time, on the live scene. This file is the script and its clock, with
// no three.js or DOM, so it runs under `node --test`; tour-ui.js performs
// the beats on the scene and draws the caption, ghost cursor and key caps.
//
// A step is a caption (what the movement is called and how to do it on each
// input), a setup (the state it starts from, so previous and next work from
// anywhere) and beats on a timeline (seconds from the step's start):
//
//   move   {to}                    the ghost cursor glides to an anchor
//   orbit  {dx, dy}                drag on empty space (fractions of the view's height)
//   pan    {dx, dy, via}           via 'shift' (Shift+drag), 'right' (right-drag), 'scroll' (two-finger scroll)
//   arrow  {key, n}                n presses of an arrow key (60 px each, as main.js)
//   zoom   {factor, via}           via 'wheel' or 'pinch' (toward the cursor), 'key' or 'button' (toward the target)
//   deck   {deck, dx, dy, vertical, grip}  drag a deck (grip 'rim' or 'alt'); vertical: Shift, the gap
//   press  {keys, act, arg}        key presses that do something (act: see tour-ui.js)
//   click  {act, arg}              a click where the cursor is
//   spot   {sel}                   rings a control on the page
//
// Every beat may carry a label (shown as "now:" on the card while it runs)
// and keys (key caps held down while it runs).

/** Anchors the cursor can go to (resolved on the live scene by tour-ui.js). */
export const ANCHORS = ['sky', 'deck:agents', 'deck:workers', 'rim:agents', 'rim:workers', 'agent', 'pad'];

const MOUSE = 'Mouse / trackpad';

/** The tour, in order. `covers` names the rows of docs/design.md's Interaction table each step shows. */
export const STEPS = [
  {
    id: 'orbit',
    title: 'Orbit',
    covers: ['Orbit'],
    how: { mouse: 'Drag on empty space', keys: '', touch: 'One finger' },
    beats: [
      { at: 0.5, dur: 0.7, kind: 'move', to: 'sky' },
      { at: 1.3, dur: 1.8, kind: 'orbit', dx: 0.32, dy: 0, label: 'Drag left and right: turn around the target' },
      { at: 3.3, dur: 1.4, kind: 'orbit', dx: -0.2, dy: 0.06, label: 'Drag up and down: tilt' },
      { at: 4.9, dur: 1.2, kind: 'orbit', dx: -0.12, dy: -0.06, label: 'Drag on empty space' },
    ],
    dur: 6.5,
  },
  {
    id: 'pan',
    title: 'Pan',
    covers: ['Pan (up, down, left, right, in the screen plane)'],
    how: { mouse: 'Shift+drag · right-drag · two-finger scroll on a trackpad', keys: 'Arrow keys (Shift: further)', touch: 'Two fingers' },
    beats: [
      { at: 0.4, dur: 0.6, kind: 'move', to: 'sky' },
      { at: 1.1, dur: 1.3, kind: 'pan', dx: -0.22, dy: 0.05, via: 'shift', keys: ['Shift'], label: 'Shift + drag' },
      { at: 2.6, dur: 1.3, kind: 'pan', dx: 0.22, dy: -0.05, via: 'right', label: 'Right-drag' },
      { at: 4.1, dur: 1.1, kind: 'pan', dx: 0, dy: -0.12, via: 'scroll', label: 'Two-finger scroll (trackpad)' },
      { at: 5.4, dur: 0.5, kind: 'arrow', key: '←', n: 2, label: 'Arrow keys' },
      { at: 6.0, dur: 0.5, kind: 'arrow', key: '→', n: 2, label: 'Arrow keys' },
      { at: 6.6, dur: 0.4, kind: 'arrow', key: '↓', n: 2, label: 'Arrow keys' },
    ],
    dur: 7.4,
  },
  {
    id: 'zoom',
    title: 'Zoom',
    covers: ['Zoom (toward the cursor)'],
    how: { mouse: 'Mouse wheel · pinch · Control+scroll (toward the cursor) · the + and − buttons', keys: '+ and −', touch: 'Pinch' },
    beats: [
      { at: 0.4, dur: 0.6, kind: 'move', to: 'deck:agents' },
      { at: 1.1, dur: 1.3, kind: 'zoom', factor: 0.5, via: 'wheel', label: 'Mouse wheel: toward the cursor' },
      { at: 2.6, dur: 1.1, kind: 'zoom', factor: 1.6, via: 'pinch', keys: ['Control'], label: 'Pinch, or Control + scroll' },
      { at: 3.9, dur: 0.45, kind: 'zoom', factor: 0.8, via: 'key', keys: ['+'], label: '+ key' },
      { at: 4.5, dur: 0.45, kind: 'zoom', factor: 1.25, via: 'key', keys: ['−'], label: '− key' },
      { at: 5.1, dur: 0.6, kind: 'move', to: 'dom:#zoom-in' },
      { at: 5.8, dur: 0.5, kind: 'click', act: 'zoom', arg: 0.8, sel: '#zoom-in', label: 'The + button' },
      { at: 6.4, dur: 0.5, kind: 'click', act: 'zoom', arg: 1.25, sel: '#zoom-out', label: 'The − button' },
    ],
    dur: 7.2,
  },
  {
    id: 'scroll',
    title: 'Scroll: auto · zoom · pan',
    covers: ['What scrolling does'],
    how: { mouse: 'The Scroll switch, bottom right. Auto: a wheel zooms, a trackpad scroll pans. Zoom: every scroll zooms (use with a Magic Mouse), Shift+scroll pans. Pan: every scroll pans', keys: 'Control+scroll always zooms', touch: '' },
    beats: [
      { at: 0.3, dur: 5.6, kind: 'spot', sel: '#zoomctl .scrollmode' },
      { at: 0.4, dur: 0.7, kind: 'move', to: 'dom:#zoomctl [data-scroll="zoom"]' },
      { at: 1.2, dur: 0.4, kind: 'click', act: 'scroll', arg: 'zoom', sel: '#zoomctl [data-scroll="zoom"]', label: 'Scroll: zoom (Magic Mouse)' },
      { at: 1.8, dur: 0.6, kind: 'move', to: 'deck:agents' },
      { at: 2.5, dur: 1.2, kind: 'zoom', factor: 0.6, via: 'scroll', label: 'Every scroll zooms' },
      { at: 3.8, dur: 1.0, kind: 'pan', dx: 0.1, dy: 0, via: 'scroll', keys: ['Shift'], label: 'Shift + scroll pans' },
      { at: 5.0, dur: 0.6, kind: 'move', to: 'dom:#zoomctl [data-scroll="auto"]' },
      { at: 5.7, dur: 0.4, kind: 'click', act: 'scroll', arg: 'auto', sel: '#zoomctl [data-scroll="auto"]', label: 'Scroll: auto' },
    ],
    dur: 6.6,
  },
  {
    id: 'move-agents',
    title: 'Move the agent deck',
    covers: ['Move a deck in its plane'],
    how: { mouse: 'Drag its rim (it lights up under the pointer) · Option/Alt+drag anywhere on it', keys: '', touch: 'Long-press its rim, then drag' },
    note: 'Shown with the decks unlinked; linked, both decks move (step 8).',
    setup: { linked: false },
    beats: [
      { at: 0.5, dur: 0.8, kind: 'move', to: 'rim:agents' },
      { at: 1.4, dur: 1.6, kind: 'deck', deck: 'agents', dx: 0.2, dy: 0.04, grip: 'rim', label: 'Drag the rim' },
      { at: 3.2, dur: 0.6, kind: 'move', to: 'deck:agents' },
      { at: 3.9, dur: 1.6, kind: 'deck', deck: 'agents', dx: -0.2, dy: -0.04, grip: 'alt', keys: ['Alt'], label: 'Option/Alt + drag anywhere on it' },
    ],
    dur: 6.2,
  },
  {
    id: 'move-workers',
    title: 'Move the worker deck',
    covers: ['Move a deck in its plane'],
    how: { mouse: 'Drag its rim · Option/Alt+drag anywhere on it', keys: '', touch: 'Long-press its rim, then drag' },
    note: 'Shown with the decks unlinked.',
    setup: { linked: false },
    beats: [
      { at: 0.5, dur: 0.8, kind: 'move', to: 'rim:workers' },
      { at: 1.4, dur: 1.6, kind: 'deck', deck: 'workers', dx: -0.24, dy: 0.03, grip: 'rim', label: 'Drag the rim' },
      { at: 3.2, dur: 0.6, kind: 'move', to: 'deck:workers' },
      { at: 3.9, dur: 1.6, kind: 'deck', deck: 'workers', dx: 0.24, dy: -0.03, grip: 'alt', keys: ['Alt'], label: 'Option/Alt + drag anywhere on it' },
    ],
    dur: 6.2,
  },
  {
    id: 'height',
    title: 'Raise / lower a deck',
    covers: ['Raise or lower a deck (the gap)'],
    how: { mouse: 'Hold Shift while moving a deck: drag down lowers it, up raises it (the gap between the decks)', keys: '', touch: '' },
    setup: { linked: false },
    beats: [
      { at: 0.5, dur: 0.8, kind: 'move', to: 'rim:workers' },
      { at: 1.4, dur: 1.4, kind: 'deck', deck: 'workers', dx: 0, dy: 0.14, vertical: true, grip: 'rim', keys: ['Shift'], label: 'Shift + drag down: lower (wider gap)' },
      { at: 3.0, dur: 1.6, kind: 'deck', deck: 'workers', dx: 0, dy: -0.24, vertical: true, grip: 'rim', keys: ['Shift'], label: 'Shift + drag up: raise (narrower gap)' },
      { at: 4.8, dur: 1.0, kind: 'deck', deck: 'workers', dx: 0, dy: 0.1, vertical: true, grip: 'rim', keys: ['Shift'], label: 'Shift + drag' },
    ],
    dur: 6.4,
  },
  {
    id: 'link',
    title: 'Linked vs independent decks',
    covers: ['Linked or independent moves'],
    how: { mouse: 'The chain button in the header', keys: 'Shift+L', touch: '' },
    setup: { linked: true },
    beats: [
      { at: 0.3, dur: 6.1, kind: 'spot', sel: '#deck-link' },
      { at: 0.5, dur: 0.7, kind: 'move', to: 'rim:agents' },
      { at: 1.3, dur: 1.4, kind: 'deck', deck: 'agents', dx: 0.16, dy: 0, grip: 'rim', label: 'Linked: dragging one deck moves both' },
      { at: 2.9, dur: 0.5, kind: 'press', keys: ['Shift', 'L'], act: 'link', arg: false, label: 'Shift+L (or the chain button): unlink' },
      { at: 3.6, dur: 1.4, kind: 'deck', deck: 'agents', dx: -0.16, dy: 0, grip: 'rim', label: 'Unlinked: only the deck you drag moves' },
      { at: 5.3, dur: 0.5, kind: 'press', keys: ['Shift', 'L'], act: 'link', arg: true, label: 'Shift+L: link again' },
    ],
    dur: 6.6,
  },
  {
    id: 'fade',
    title: 'Fade decks',
    covers: ['Show one deck or both'],
    how: { mouse: '', keys: '1 agents only · 2 workers only · 3 both', touch: '' },
    beats: [
      { at: 0.8, dur: 0.5, kind: 'press', keys: ['1'], act: 'view', arg: 'agents', label: '1: the agent deck only' },
      { at: 2.6, dur: 0.5, kind: 'press', keys: ['2'], act: 'view', arg: 'workers', label: '2: the worker deck only' },
      { at: 4.4, dur: 0.5, kind: 'press', keys: ['3'], act: 'view', arg: 'both', label: '3: both decks' },
    ],
    dur: 6.0,
  },
  {
    id: 'select',
    title: 'Select an agent and fly to it',
    covers: ['Select an agent, pin a worker', 'Fly to the selected agent', 'Whole cluster'],
    how: { mouse: 'Click an agent (Shift+click works too) · the ⌂ button shows the whole cluster', keys: 'f flies to the selected agent · h shows the whole cluster · Esc clears', touch: 'Tap' },
    beats: [
      { at: 0.5, dur: 0.9, kind: 'move', to: 'agent' },
      { at: 1.5, dur: 0.4, kind: 'click', act: 'select', label: 'Click an agent: its details open' },
      { at: 2.4, dur: 0.5, kind: 'press', keys: ['F'], act: 'fly', label: 'f: fly to it' },
      { at: 4.3, dur: 2.0, kind: 'spot', sel: '#home' },
      { at: 4.4, dur: 0.5, kind: 'press', keys: ['H'], act: 'fit', label: 'h (or ⌂): the whole cluster' },
    ],
    dur: 6.6,
  },
  {
    id: 'pin',
    title: 'Pin a worker',
    covers: ['Select an agent, pin a worker'],
    how: { mouse: 'Click a worker pad: it and its agents light up · click it again to unpin', keys: 'Esc clears', touch: 'Tap a pad' },
    beats: [
      { at: 0.5, dur: 0.9, kind: 'move', to: 'pad' },
      { at: 1.5, dur: 0.4, kind: 'click', act: 'pin', label: 'Click a worker pad: its agents light up' },
      { at: 4.2, dur: 0.5, kind: 'press', keys: ['Esc'], act: 'clear', label: 'Esc clears' },
    ],
    dur: 5.6,
  },
  {
    id: 'beams',
    title: 'Beams: focus / all',
    covers: ['Beams: focus or all'],
    how: { mouse: 'The Beams toggle in the header (on wide screens)', keys: 'b', touch: '' },
    beats: [
      { at: 0.3, dur: 5.0, kind: 'spot', sel: '#beams' },
      { at: 1.0, dur: 0.5, kind: 'press', keys: ['B'], act: 'beams', arg: 'all', label: 'b: every beam (up to 4,000)' },
      { at: 3.4, dur: 0.5, kind: 'press', keys: ['B'], act: 'beams', arg: 'focus', label: 'b: focus (beams for what is in focus; ribbons carry the rest)' },
    ],
    dur: 5.8,
  },
  {
    id: 'layout',
    title: 'Switch layout',
    covers: ['Layout: decks or combined', 'Group by atespace or worker'],
    how: { mouse: 'The Layout toggle in the header (decks · combined) · in combined, the Group toggle', keys: 'g groups by worker or atespace (combined)', touch: '' },
    beats: [
      { at: 0.4, dur: 0.7, kind: 'move', to: 'dom:#layout [data-layout="combined"]' },
      { at: 1.2, dur: 0.4, kind: 'click', act: 'layout', arg: 'combined', sel: '#layout [data-layout="combined"]', label: 'Layout: combined (one island)' },
      { at: 2.8, dur: 0.5, kind: 'press', keys: ['G'], act: 'group', arg: 'worker', label: 'g: group by worker' },
      { at: 4.5, dur: 0.5, kind: 'press', keys: ['G'], act: 'group', arg: 'atespace', label: 'g: group by atespace' },
      { at: 5.6, dur: 0.6, kind: 'move', to: 'dom:#layout [data-layout="decks"]' },
      { at: 6.3, dur: 0.4, kind: 'click', act: 'layout', arg: 'decks', sel: '#layout [data-layout="decks"]', label: 'Layout: decks' },
    ],
    dur: 7.4,
  },
  {
    id: 'reset',
    title: 'Reset the decks and the view',
    covers: ['Reset the decks and the view'],
    how: { mouse: 'The reset button in the header', keys: 'r', touch: '' },
    setup: { offsets: 'apart', linked: false },
    beats: [
      { at: 0.8, dur: 0.8, kind: 'move', to: 'sky' },
      { at: 1.0, dur: 1.0, kind: 'orbit', dx: 0.12, dy: 0.04, label: 'Decks moved apart, view turned' },
      { at: 2.2, dur: 0.5, kind: 'press', keys: ['R'], act: 'reset', label: 'r: back to the planned arrangement' },
      { at: 3.6, dur: 0.6, kind: 'move', to: 'rim:workers' },
      { at: 4.3, dur: 1.0, kind: 'deck', deck: 'workers', dx: 0.2, dy: 0.06, grip: 'rim', label: 'Move a deck again…' },
      { at: 5.3, dur: 0.7, kind: 'move', to: 'dom:#deck-reset' },
      { at: 6.1, dur: 0.4, kind: 'click', act: 'reset', sel: '#deck-reset', label: '…and the reset button puts it back' },
    ],
    dur: 7.4,
  },
];

/** Every key cap a step presses or holds, in first-use order. */
export function stepKeys(step) {
  const out = [];
  for (const b of step.beats) {
    const ks = [...(b.keys || []), ...(b.kind === 'arrow' ? [b.key] : [])];
    for (const k of ks) if (!out.includes(k)) out.push(k);
  }
  return out;
}

/** The step's caption rows: [label, text] for each input that has a way to do it. */
export function howRows(step) {
  return [
    [MOUSE, step.how.mouse],
    ['Keyboard', step.how.keys],
    ['Touch', step.how.touch],
  ].filter(([, t]) => t);
}

/** Ease in and out (cubic), 0..1 to 0..1. */
export function ease(p) {
  return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
}

/** The longest a frame may advance the tour (a long frame, say a re-plan at 100,000 agents, doesn't skip beats). */
export const MAX_DT = 0.1;

/**
 * Plays the steps on a host:
 *   snapshot() -> state; restore(state); prepare(step);
 *   begin(beat, step); update(beat, p, prevP) with eased progress; end(beat);
 *   render?(tour) after every change (caption, progress).
 * reduced (prefers-reduced-motion): every beat jumps to its end as it starts.
 */
export class TourController {
  constructor(host, steps = STEPS, opts = {}) {
    this.host = host;
    this.steps = steps;
    this.loop = !!opts.loop;
    this.reduced = !!opts.reduced;
    this.onEnd = opts.onEnd || null;
    this.maxDt = opts.maxDt || MAX_DT;
    this.running = false;
    this.paused = false;
    this.index = 0;
    this.t = 0;
    this.saved = null;
    this.active = new Map();
    this.passes = 0;
  }

  get step() {
    return this.steps[this.index];
  }

  /** The beat whose label is showing (the latest begun that has a label), or null. */
  get current() {
    let cur = null;
    for (const b of this.step.beats) if (b.label && this.t >= b.at) cur = b;
    return cur;
  }

  /** Overall progress, 0..1. */
  get progress() {
    return Math.min(1, (this.index + Math.min(1, this.t / this.step.dur)) / this.steps.length);
  }

  start(index = 0) {
    if (this.running) return;
    this.saved = this.host.snapshot();
    this.running = true;
    this.paused = false;
    this.passes = 0;
    this.go(index);
  }

  /** Stops (Esc, the close button, or the end of a single pass) and puts back what the user had. */
  stop() {
    if (!this.running) return;
    this.finishActive();
    this.running = false;
    this.paused = false;
    this.host.restore(this.saved);
    this.saved = null;
    this.host.render?.(this);
    this.onEnd?.(this);
  }

  pause() {
    if (!this.running || this.paused) return;
    this.paused = true;
    this.host.render?.(this);
  }

  resume() {
    if (!this.running || !this.paused) return;
    this.paused = false;
    this.host.render?.(this);
  }

  togglePause() {
    if (this.paused) this.resume();
    else this.pause();
  }

  next() {
    if (!this.running) return;
    if (this.index + 1 < this.steps.length) this.go(this.index + 1);
    else this.wrap();
  }

  prev() {
    if (!this.running) return;
    // Back to the start of this step if it has been running a while, else the previous one.
    this.go(this.t > 1.5 || this.index === 0 ? this.index : this.index - 1);
  }

  /** Jumps to a step: ends the beats in progress (a drag lets go), sets the step up and starts its clock. */
  go(index) {
    this.finishActive();
    this.index = Math.max(0, Math.min(this.steps.length - 1, index));
    this.t = 0;
    this.done = new Set();
    this.host.prepare(this.step);
    this.tick(0);
  }

  wrap() {
    this.passes++;
    if (this.loop) this.go(0);
    else this.stop();
  }

  finishActive() {
    for (const b of this.active.keys()) this.host.end(b);
    this.active.clear();
  }

  /** Advances the clock by dt seconds (clamped to maxDt) and plays the beats it crosses. */
  tick(dt) {
    if (!this.running) return;
    if (!this.paused) this.t += Math.min(Math.max(0, dt), this.maxDt);
    const step = this.step;
    for (const b of step.beats) {
      if (this.done.has(b) || this.t < b.at) continue;
      let prev = this.active.get(b);
      if (prev === undefined) {
        this.host.begin(b, step);
        prev = 0;
      }
      const p = this.reduced || b.dur <= 0 ? 1 : Math.min(1, (this.t - b.at) / b.dur);
      const e = ease(p);
      if (e !== prev) this.host.update(b, e, prev);
      if (p >= 1) {
        this.active.delete(b);
        this.done.add(b);
        this.host.end(b);
      } else this.active.set(b, e);
    }
    this.host.render?.(this);
    if (!this.paused && this.t >= step.dur) this.next();
  }
}

/**
 * What the tour changes and puts back when it ends: the camera, the decks'
 * offsets and link state, the deck view, beams, layout, grouping, the
 * selection, the pinned worker and the scroll mode.
 * @param {object} scene the Scene (or a stand-in with the same members)
 * @param {{selected: () => string|null, scrollMode: () => string}} app
 */
export function snapshotState(scene, app) {
  return {
    camera: scene.camera.position.clone(),
    target: scene.controls.target.clone(),
    offsets: scene.copyDeckOffsets(),
    view: scene.deckView,
    beams: scene.beamMode,
    layout: scene.layout,
    group: scene.groupPref,
    selected: app.selected(),
    pinned: scene.pinnedWorker,
    scroll: app.scrollMode(),
  };
}

/**
 * Puts a snapshot back. The layout goes first (switching re-plans and
 * frames the camera), the camera last.
 * @param {object} scene
 * @param {{setLayout, setGroup, setBeams, setScroll, select}} app main.js's setters (with remember false)
 * @param {object} s from snapshotState
 */
export function restoreState(scene, app, s) {
  if (scene.deckDrag) scene.endDeckDrag();
  if (scene.layout !== s.layout) app.setLayout(s.layout, false);
  if (scene.groupPref !== s.group) app.setGroup(s.group, false);
  scene.setDeckOffsets(s.offsets);
  scene.setDecksLinked(s.offsets.linked);
  if (scene.layout === 'decks') scene.setDeckView(s.view, false);
  app.setBeams(s.beams, false);
  app.setScroll(s.scroll, false);
  scene.pinWorker(s.pinned);
  app.select(s.selected, false);
  scene.flyAnim = null;
  scene.camera.position.copy(s.camera);
  scene.controls.target.copy(s.target);
  scene.controls.update();
}
