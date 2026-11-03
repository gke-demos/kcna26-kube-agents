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

// The controls tour on the page: performs tour.js's beats on the live scene
// with the same scene calls the gestures and keys use, and draws what is
// being simulated (the caption card, a ghost cursor with its drag trail,
// key caps that light up, a scroll or pinch glyph, a ring around a control).

import * as THREE from 'three';
import { STEPS, TourController, howRows, stepKeys, snapshotState, restoreState } from './tour.js';
import { defaultOffsets, clampOffsets, rayAtY } from './decks.js';
import { esc } from './format.js';

/** Arrow key caps -> the pan main.js does for that key (pixels, as dragging that way). */
const ARROWS = { '←': [1, 0], '→': [-1, 0], '↑': [0, 1], '↓': [0, -1] };
const ARROW_PX = 60;

const SVG_CURSOR =
  '<svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true"><path d="M4 2.5l15 11.2-6.6 1 3.9 7.3-3 1.5-3.8-7.4L4 21z"/></svg>';
const GLYPH = {
  wheel:
    '<svg viewBox="0 0 40 56" width="40" height="56" aria-hidden="true"><rect x="4" y="4" width="32" height="48" rx="16"/><line x1="20" y1="4" x2="20" y2="24"/><rect class="g-move" x="17" y="10" width="6" height="10" rx="3"/></svg>',
  scroll:
    '<svg viewBox="0 0 56 56" width="56" height="56" aria-hidden="true"><rect x="4" y="8" width="48" height="40" rx="6"/><circle class="g-move" cx="22" cy="28" r="5"/><circle class="g-move" cx="34" cy="28" r="5"/></svg>',
  pinch:
    '<svg viewBox="0 0 56 56" width="56" height="56" aria-hidden="true"><rect x="4" y="8" width="48" height="40" rx="6"/><circle class="g-pinch-a" cx="20" cy="22" r="5"/><circle class="g-pinch-b" cx="36" cy="34" r="5"/></svg>',
};

export class ControlsTour {
  /**
   * @param {import('./scene.js').Scene} scene
   * @param {{selected, scrollMode, select, setLayout, setGroup, setBeams, setScroll, ready}} app main.js's state and setters
   */
  constructor(scene, app) {
    this.scene = scene;
    this.app = app;
    this.cursor = { x: window.innerWidth * 0.6, y: window.innerHeight * 0.4, down: null };
    this.trail = [];
    this.keysDown = new Set();
    this.raf = 0;
    this.build();
    this.ctl = new TourController(this, STEPS, { onEnd: () => this.ended() });
    window.addEventListener('keydown', (e) => this.onKey(e), true);
    // Grabbing the scene yourself pauses the tour (Space resumes).
    scene.renderer.domElement.parentElement.addEventListener('pointerdown', (e) => e.isTrusted && this.ctl.running && this.ctl.pause(), true);
  }

  get running() {
    return this.ctl.running;
  }

  build() {
    const root = document.createElement('div');
    root.id = 'tour';
    root.className = 'tour';
    root.hidden = true;
    root.innerHTML = `
      <svg class="tour-trail" aria-hidden="true"><polyline points=""/></svg>
      <div class="tour-spot" hidden></div>
      <div class="tour-glyph" hidden></div>
      <div class="tour-cursor" aria-hidden="true">${SVG_CURSOR}<span class="tour-ring"></span><span class="tour-tag"></span></div>
      <section class="tour-card" role="region" aria-label="Controls tour">
        <div class="tour-head">
          <span class="tour-n"></span>
          <h2 class="tour-title"></h2>
        </div>
        <div class="tour-now" aria-live="polite"></div>
        <dl class="tour-how"></dl>
        <div class="tour-keys" aria-hidden="true"></div>
        <div class="tour-note"></div>
        <div class="tour-foot">
          <div class="tour-bar"><i></i></div>
          <button class="tour-prev" title="Previous step (←)" aria-label="Previous step">‹</button>
          <button class="tour-pause" title="Pause (Space)" aria-label="Pause">❚❚</button>
          <button class="tour-next" title="Next step (→)" aria-label="Next step">›</button>
          <button class="tour-exit" title="End the tour (Esc)" aria-label="End the tour">✕</button>
        </div>
        <div class="tour-hint">Space pause · ← → step · Esc exit</div>
      </section>`;
    document.body.appendChild(root);
    const q = (s) => root.querySelector(s);
    this.el = {
      root,
      card: q('.tour-card'),
      n: q('.tour-n'),
      title: q('.tour-title'),
      now: q('.tour-now'),
      how: q('.tour-how'),
      keys: q('.tour-keys'),
      note: q('.tour-note'),
      bar: q('.tour-bar i'),
      pause: q('.tour-pause'),
      cursor: q('.tour-cursor'),
      tag: q('.tour-tag'),
      trail: q('.tour-trail polyline'),
      glyph: q('.tour-glyph'),
      spot: q('.tour-spot'),
    };
    q('.tour-prev').addEventListener('click', () => this.ctl.prev());
    q('.tour-next').addEventListener('click', () => this.ctl.next());
    q('.tour-pause').addEventListener('click', () => this.ctl.togglePause());
    q('.tour-exit').addEventListener('click', () => this.stop());
  }

  /** Starts the tour (loop: start over at the end instead of stopping). */
  start({ loop = false } = {}) {
    if (this.running) return;
    this.ctl.loop = loop;
    this.ctl.reduced = !!this.scene.reducedMotion;
    this.el.root.hidden = false;
    document.body.classList.add('touring');
    // Frame the scene beside the caption card, not under it.
    this.inset = this.scene.leftInset || 0;
    const r = this.el.card.getBoundingClientRect();
    if (r.left < window.innerWidth * 0.2) this.scene.setLeftInset(Math.max(this.inset, r.right + 12));
    this.ctl.start(0);
    let last = performance.now();
    const frame = (now) => {
      if (!this.running) return;
      this.ctl.tick((now - last) / 1000);
      last = now;
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  stop() {
    this.ctl.stop();
  }

  toggle(opts) {
    if (this.running) this.stop();
    else this.start(opts);
  }

  /** Starts once the scene has a model and an island to tour. */
  startWhenReady(opts) {
    const go = () => (this.app.ready() ? setTimeout(() => this.start(opts), 800) : setTimeout(go, 300));
    go();
  }

  ended() {
    cancelAnimationFrame(this.raf);
    this.el.root.hidden = true;
    document.body.classList.remove('touring');
    this.clearMarks();
  }

  onKey(e) {
    const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName);
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    let used = true;
    if (e.key === '?') this.toggle({ loop: false });
    else if (!this.running) used = false;
    else if (e.key === ' ' || e.key === 'Spacebar') this.ctl.togglePause();
    else if (e.key === 'ArrowRight') this.ctl.next();
    else if (e.key === 'ArrowLeft') this.ctl.prev();
    else if (e.key === 'Escape') this.stop();
    else used = false;
    if (used) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }

  // ------------------------------------------------------------ the host

  snapshot() {
    return snapshotState(this.scene, this.app);
  }

  restore(s) {
    this.endDrag();
    this.scene.setLeftInset(this.inset || 0);
    restoreState(this.scene, this.app, s);
  }

  /** Puts the scene in the step's starting state (decks layout, planned or pulled-apart decks, nothing selected) and frames it. */
  prepare(step) {
    const sc = this.scene;
    const s = { layout: 'decks', group: 'atespace', view: 'both', beams: 'focus', offsets: 'default', linked: true, ...step.setup };
    this.endDrag();
    this.clearMarks();
    this.pickedAgent = null;
    this.pickedPad = null;
    if (sc.layout !== s.layout) this.app.setLayout(s.layout, false);
    if (sc.groupPref !== s.group) this.app.setGroup(s.group, false);
    if (this.app.selected()) this.app.select(null, false);
    sc.pinWorker(null);
    this.app.setBeams(s.beams, false);
    sc.setDeckView(s.view, false);
    if (sc.deck && sc.deckLim) {
      const want = s.offsets === 'apart' ? this.apartOffsets() : defaultOffsets();
      want.linked = s.linked;
      const tgt = clampOffsets(want, sc.deckLim);
      if (this.ctl.reduced) sc.setDeckOffsets(tgt);
      else {
        sc.offsets = tgt;
        sc.decksEasing = true;
      }
      sc.setDecksLinked(s.linked);
    }
    if (sc.island) sc.fitCamera(!this.ctl.reduced);
    const keys = stepKeys(step);
    this.el.keys.innerHTML = keys.map((k) => `<kbd data-k="${esc(k)}">${esc(k)}</kbd>`).join('');
    this.el.keys.hidden = !keys.length;
    this.el.how.innerHTML = howRows(step)
      .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`)
      .join('');
    this.el.note.textContent = step.note || '';
    this.el.note.hidden = !step.note;
    this.el.title.textContent = step.title;
  }

  /** The decks pulled apart (for the reset step): the worker deck aside, lower and forward. */
  apartOffsets() {
    const D = this.scene.deck;
    const o = defaultOffsets();
    o.workers = { x: D.width * 0.45, y: -D.gap * 0.5, z: D.depth * 0.15 };
    return o;
  }

  begin(b) {
    const c = this.cursor;
    b.run = { x0: c.x, y0: c.y, px: this.viewH() };
    if (b.label) this.showNow(b.label);
    for (const k of b.keys || []) this.keyDown(k);
    switch (b.kind) {
      case 'orbit':
      case 'deck':
        this.press(b.kind === 'deck' && b.grip === 'alt' ? 'Alt+drag' : b.vertical ? 'Shift+drag' : 'drag');
        break;
      case 'pan':
        b.run.depth = this.scene.grabDepth(c.x, c.y);
        if (b.via === 'scroll') this.glyph('scroll');
        else this.press(b.via === 'right' ? 'right-drag' : 'Shift+drag', b.via === 'right');
        break;
      case 'zoom':
        if (b.via === 'wheel' || b.via === 'scroll') this.glyph(b.via === 'wheel' ? 'wheel' : 'scroll');
        if (b.via === 'pinch') this.glyph('pinch');
        break;
      case 'arrow':
        b.run.depth = this.scene.camera.position.distanceTo(this.scene.controls.target);
        this.keyDown(b.key);
        break;
      case 'spot':
        this.spot(b.sel);
        break;
      case 'click':
        this.press('click');
        this.flashControl(b.sel);
        this.act(b.act, b.arg);
        break;
      case 'press':
        this.act(b.act, b.arg);
        break;
    }
    if (b.kind === 'deck') {
      const sc = this.scene;
      // The real drag: the point grabbed stays under the (ghost) pointer.
      sc.startDeckDrag({ id: b.deck }, c.x, c.y, !!b.vertical);
      sc.dragging = 'deck';
      b.run.dragging = true;
      this.dragBeat = b;
    }
  }

  update(b, p, prev) {
    const sc = this.scene;
    const r = b.run;
    const dp = p - prev;
    switch (b.kind) {
      case 'move': {
        const to = this.anchor(b.to);
        this.moveCursor(r.x0 + (to.x - r.x0) * p, r.y0 + (to.y - r.y0) * p);
        break;
      }
      case 'orbit': {
        const ddx = b.dx * r.px * dp;
        const ddy = b.dy * r.px * dp;
        this.orbit(ddx, ddy);
        this.moveCursor(r.x0 + b.dx * r.px * p, r.y0 + b.dy * r.px * p);
        break;
      }
      case 'pan': {
        const ddx = b.dx * r.px * dp;
        const ddy = b.dy * r.px * dp;
        sc.flyAnim = null;
        sc.panScreen(ddx, ddy, r.depth);
        if (b.via !== 'scroll') this.moveCursor(r.x0 + b.dx * r.px * p, r.y0 + b.dy * r.px * p);
        break;
      }
      case 'arrow': {
        const [ax, ay] = ARROWS[b.key];
        const px = ARROW_PX * (b.n || 1) * dp;
        sc.flyAnim = null;
        sc.panScreen(ax * px, ay * px, r.depth);
        break;
      }
      case 'zoom': {
        const f = Math.pow(b.factor, dp);
        if (b.via === 'key' || b.via === 'button') sc.zoomBy(f);
        else this.zoomAt(f, this.cursor.x, this.cursor.y);
        break;
      }
      case 'deck':
        sc.dragDeck(r.x0 + b.dx * r.px * p, r.y0 + b.dy * r.px * p);
        this.moveCursor(r.x0 + b.dx * r.px * p, r.y0 + b.dy * r.px * p);
        break;
    }
  }

  end(b) {
    for (const k of b.keys || []) this.keyUp(k);
    if (b.kind === 'arrow') this.keyUp(b.key);
    if (b.kind === 'deck' && b.run?.dragging) this.endDrag();
    if (['orbit', 'pan', 'deck', 'click'].includes(b.kind)) this.release();
    if (b.kind === 'pan' || b.kind === 'zoom') this.glyph(null);
    if (b.kind === 'spot') this.spot(null);
  }

  endDrag() {
    const b = this.dragBeat;
    if (!b) return;
    this.dragBeat = null;
    b.run.dragging = false;
    this.scene.dragging = null;
    this.scene.endDeckDrag();
  }

  render(tour) {
    const el = this.el;
    if (!tour.running) return;
    el.n.textContent = `${tour.index + 1} / ${tour.steps.length}`;
    el.bar.style.width = `${(tour.progress * 100).toFixed(1)}%`;
    el.pause.textContent = tour.paused ? '▶' : '❚❚';
    el.pause.title = tour.paused ? 'Resume (Space)' : 'Pause (Space)';
    el.root.classList.toggle('paused', tour.paused);
    if (!tour.current) this.showNow('');
  }

  // ---------------------------------------------------------- the acts

  /** Does what a click or key press does, through main.js's setters (nothing remembered) or the scene. */
  act(what, arg) {
    const sc = this.scene;
    const a = this.app;
    switch (what) {
      case 'zoom':
        sc.zoomBy(arg);
        break;
      case 'scroll':
        a.setScroll(arg, false);
        break;
      case 'link':
        sc.setDecksLinked(arg);
        break;
      case 'view':
        sc.setDeckView(arg, true);
        break;
      case 'select': {
        const key = this.agentKey();
        if (key) {
          sc.pinWorker(null);
          a.select(key, false);
        }
        break;
      }
      case 'fly':
        if (a.selected()) sc.flyTo(a.selected());
        break;
      case 'fit':
        sc.fitCamera(!this.ctl.reduced);
        break;
      case 'pin': {
        const name = this.padName();
        if (name) sc.pinWorker(name);
        break;
      }
      case 'clear':
        sc.pinWorker(null);
        a.select(null, false);
        break;
      case 'beams':
        a.setBeams(arg, false);
        break;
      case 'layout':
        a.setLayout(arg, false);
        break;
      case 'group':
        a.setGroup(arg, false);
        break;
      case 'reset':
        sc.resetDecks(this.ctl.reduced);
        break;
    }
  }

  // ------------------------------------------------------ scene helpers

  viewH() {
    return this.scene.renderer.domElement.clientHeight || window.innerHeight;
  }

  /** A world point -> client coordinates. */
  project(x, y, z) {
    const r = this.scene.renderer.domElement.getBoundingClientRect();
    const v = new THREE.Vector3(x, y, z).project(this.scene.camera);
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
  }

  /** Where an anchor is on screen right now (it follows the camera while the cursor glides there). */
  anchor(name) {
    const sc = this.scene;
    const I = sc.island;
    const W = window.innerWidth;
    const H = window.innerHeight;
    const keep = { x: this.cursor.x, y: this.cursor.y };
    if (name.startsWith('dom:')) {
      const el = document.querySelector(name.slice(4));
      const r = el?.getBoundingClientRect();
      return r && r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : keep;
    }
    if (name === 'sky') return { x: W * 0.62, y: H * 0.26 };
    if (!I) return keep;
    const o = sc.workerOrigin();
    const D = sc.deck;
    switch (name) {
      case 'deck:agents':
        return this.project(I.cx + I.width * 0.08, 0, I.cz + I.depth * 0.1);
      case 'rim:agents':
        return this.project(I.cx - I.width * 0.12, 0, I.cz + I.depth / 2);
      case 'deck:workers':
        return D ? this.project(D.cx + o.x + D.width * 0.28, o.y, D.cz + o.z + D.depth / 2 - 1.5) : keep;
      case 'rim:workers':
        return D ? this.project(D.cx + o.x - D.width * 0.18, o.y, D.cz + o.z + D.depth / 2) : keep;
      case 'agent': {
        const rec = sc.recs.get(this.agentKey());
        return rec ? this.project(rec.x, 0.8, rec.z) : keep;
      }
      case 'pad': {
        const pad = sc.pads.get(this.padName());
        return pad ? this.project(pad.pos.x + o.x, pad.pos.y + o.y, pad.pos.z + o.z) : keep;
      }
    }
    return keep;
  }

  /** An agent to select: a running one near the front middle of the agent deck. */
  agentKey() {
    const sc = this.scene;
    if (this.pickedAgent && sc.recs.has(this.pickedAgent)) return this.pickedAgent;
    const I = sc.island;
    if (!I) return null;
    const fx = I.cx;
    const fz = I.cz + I.depth * 0.15;
    let best = null;
    let bd = Infinity;
    for (const rec of sc.recs.values()) {
      const d = (rec.x - fx) ** 2 + (rec.z - fz) ** 2 + (rec.cls === 'running' ? 0 : 1e4);
      if (d < bd) {
        bd = d;
        best = rec.key;
      }
    }
    this.pickedAgent = best;
    return best;
  }

  /** A worker to pin: the busiest pad in the front rows of the worker deck. */
  padName() {
    const sc = this.scene;
    if (this.pickedPad && sc.pads.get(this.pickedPad)) return this.pickedPad;
    const D = sc.deck;
    const count = new Map();
    for (const rec of sc.recs.values()) {
      const w = rec.agent.worker;
      if (w) count.set(w, (count.get(w) || 0) + 1);
    }
    let best = null;
    let bs = -Infinity;
    for (const [name, n] of count) {
      const pad = sc.pads.get(name);
      if (!pad) continue;
      // Front rows first (they show below the agent deck), then the busiest.
      const front = D ? (pad.pos.z - (D.cz - D.depth / 2)) / D.depth : 1;
      const s = (front > 0.7 ? 1000 : 0) + n;
      if (s > bs) {
        bs = s;
        best = name;
      }
    }
    this.pickedPad = best;
    return best;
  }

  /** Orbits the camera around the target as a drag of (dx, dy) pixels does (OrbitControls' rotate speed). */
  orbit(dx, dy) {
    const sc = this.scene;
    const c = sc.controls;
    const h = this.viewH();
    const off = sc.camera.position.clone().sub(c.target);
    const s = new THREE.Spherical().setFromVector3(off);
    s.theta -= (2 * Math.PI * dx) / h;
    s.phi = Math.min(c.maxPolarAngle, Math.max(Math.max(0.05, c.minPolarAngle), s.phi - (2 * Math.PI * dy) / h));
    off.setFromSpherical(s);
    sc.flyAnim = null;
    sc.camera.position.copy(c.target).add(off);
    sc.camera.lookAt(c.target);
    sc.camera.updateMatrixWorld();
  }

  /** Zooms by factor toward the ground point under (x, y), like the wheel with zoomToCursor. */
  zoomAt(f, x, y) {
    const sc = this.scene;
    const c = sc.controls;
    const ray = sc.rayAt(x, y);
    const hit = rayAtY(ray.origin, ray.direction, c.target.y);
    const d = sc.camera.position.distanceTo(c.target) * f;
    if (!hit || d < c.minDistance || d > c.maxDistance) {
      sc.zoomBy(f);
      return;
    }
    const p = new THREE.Vector3(hit.x, c.target.y, hit.z);
    sc.flyAnim = null;
    sc.camera.position.sub(p).multiplyScalar(f).add(p);
    c.target.sub(p).multiplyScalar(f).add(p);
    sc.camera.updateMatrixWorld();
  }

  // ------------------------------------------------------- what is drawn

  moveCursor(x, y) {
    const c = this.cursor;
    c.x = x;
    c.y = y;
    this.el.cursor.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    if (c.down) {
      this.trail.push([x, y]);
      if (this.trail.length > 90) this.trail.shift();
      this.el.trail.setAttribute('points', this.trail.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join(' '));
    }
  }

  press(tag, right = false) {
    this.cursor.down = right ? 'right' : 'left';
    this.trail = [[this.cursor.x, this.cursor.y]];
    this.el.cursor.classList.add('down');
    this.el.cursor.classList.toggle('right', right);
    this.el.tag.textContent = tag;
    this.el.trail.parentElement.classList.remove('fade');
    this.moveCursor(this.cursor.x, this.cursor.y);
  }

  release() {
    this.cursor.down = null;
    this.el.cursor.classList.remove('down', 'right');
    this.el.tag.textContent = '';
    this.el.trail.parentElement.classList.add('fade');
  }

  keyDown(k) {
    this.keysDown.add(k);
    this.el.keys.querySelectorAll('kbd').forEach((el) => el.classList.toggle('on', this.keysDown.has(el.dataset.k)));
  }

  keyUp(k) {
    this.keysDown.delete(k);
    this.el.keys.querySelectorAll('kbd').forEach((el) => el.classList.toggle('on', this.keysDown.has(el.dataset.k)));
  }

  showNow(text) {
    if (this.el.now.dataset.text === text) return;
    this.el.now.dataset.text = text;
    this.el.now.innerHTML = text ? `<span class="tour-now-k">now</span> ${esc(text)}` : '';
  }

  glyph(kind) {
    const g = this.el.glyph;
    if (!kind) {
      g.hidden = true;
      return;
    }
    g.innerHTML = GLYPH[kind];
    g.className = `tour-glyph g-${kind}`;
    g.style.transform = `translate(${(this.cursor.x + 26).toFixed(0)}px, ${(this.cursor.y - 8).toFixed(0)}px)`;
    g.hidden = false;
  }

  /** Rings a control on the page (null: none). */
  spot(sel) {
    const s = this.el.spot;
    const el = sel && document.querySelector(sel);
    const r = el?.getBoundingClientRect();
    if (!r || !r.width) {
      s.hidden = true;
      return;
    }
    s.style.left = `${r.left - 5}px`;
    s.style.top = `${r.top - 5}px`;
    s.style.width = `${r.width + 10}px`;
    s.style.height = `${r.height + 10}px`;
    s.hidden = false;
  }

  /** A control looks pressed for a moment, as if clicked. */
  flashControl(sel) {
    const el = sel && document.querySelector(sel);
    if (!el) return;
    el.classList.add('tour-pressed');
    setTimeout(() => el.classList.remove('tour-pressed'), 350);
  }

  clearMarks() {
    this.release();
    this.glyph(null);
    this.spot(null);
    this.keysDown.clear();
    this.el.keys.querySelectorAll('kbd').forEach((el) => el.classList.remove('on'));
    this.trail = [];
    this.el.trail.setAttribute('points', '');
    this.showNow('');
  }
}
