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

// Worker pads: one small platform per worker with a fill bar for its actor
// slots (and CPU and memory when the worker reports them), a glow while it
// hosts agents, and a label that grows into a card when the worker is in
// focus. Everything is instanced: one mesh each for the pads, their glow
// and edge, the bar tracks and the bar fills, whatever the number of
// workers (2,000 pads are five draw calls), and a change to one worker
// rewrites and uploads only its instances. Labels come from a small pool
// handed to the pads that should show one; the factory (CSS2DObject in the
// browser) lets node tests build and dispose pads without a DOM.

import * as THREE from 'three';
import { esc, workerLabel } from './format.js';
import { formatCPU, formatBytes } from './workers.js';
import { DirtyRanges, uploadRanges } from './dirty.js';

/** Pad size in world units. */
export const PAD_W = 3.2;
export const PAD_D = 1.8;
export const PAD_H = 0.3;
const BAR_W = PAD_W - 0.5;
/** Fill at or above which a bar shows as full. */
export const FULL = 0.9;

function pct(f) {
  return `${Math.round(Math.min(f, 9.99) * 100)}%`;
}

/** The label's HTML: compact (name, agents) or a card (in focus). */
export function padLabelHTML(worker, usage, card) {
  const name = esc(workerLabel(worker));
  const n = usage.actors.used;
  const state = worker.state && worker.state !== 'ACTIVE' ? `<span class="badge">${esc(worker.state.toLowerCase())}</span>` : '';
  const agents = `${n} agent${n === 1 ? '' : 's'}`;
  if (!card) return `<div class="name">${name}${state}</div><div class="meta">${agents}${usage.actors.cap ? ` / ${usage.actors.cap}` : ''}</div>`;
  const bar = (label, u, text) =>
    `<div class="use"><span class="k">${label}</span><span class="bar${u.frac >= FULL ? ' full' : ''}"><i style="width:${Math.min(100, u.frac * 100).toFixed(0)}%"></i></span><span class="v">${text}</span></div>`;
  // A resource the worker doesn't report allocation for says so instead of
  // drawing an empty bar (ax tasks declare no limits, so real workers
  // allocate nothing even while they host agents).
  const missing = (label, u, fmt) =>
    `<div class="use unreported"><span class="k">${label}</span><span class="na">not reported</span><span class="v">${Number.isFinite(u?.cap) ? `capacity ${fmt(u.cap)}` : ''}</span></div>`;
  const rows = [];
  if (usage.actors.cap) rows.push(bar('Slots', usage.actors, `${n} / ${usage.actors.cap}`));
  if (usage.cpu?.reported) rows.push(bar('CPU', usage.cpu, `${formatCPU(usage.cpu.used)} / ${formatCPU(usage.cpu.cap)} · ${pct(usage.cpu.frac)}`));
  else rows.push(missing('CPU', usage.cpu, formatCPU));
  if (usage.memory?.reported) rows.push(bar('Memory', usage.memory, `${formatBytes(usage.memory.used)} / ${formatBytes(usage.memory.cap)}`));
  else rows.push(missing('Memory', usage.memory, formatBytes));
  const node = worker.node ? `<div class="node">on ${esc(worker.node)}</div>` : '';
  return `<div class="name">${name}${state}</div>${node}<div class="meta">${agents}${usage.actors.cap ? '' : ' · capacity unknown'}</div>${rows.join('')}`;
}

const glowVertex = /* glsl */ `
attribute vec4 aGlow;
attribute vec4 aEdge;
varying vec2 vUv;
varying vec4 vGlow;
varying vec4 vEdge;
void main() {
  vUv = uv;
  vGlow = aGlow;
  vEdge = aEdge;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}`;

const glowFragment = /* glsl */ `
uniform vec2 uSize;
varying vec2 vUv;
varying vec4 vGlow;
varying vec4 vEdge;
void main() {
  vec2 p = (vUv - 0.5) * uSize;
  vec2 q = uSize * 0.5 - abs(p);
  float e = min(q.x, q.y);
  // At least ~1.5 px wide on screen, so far pads keep a solid outline.
  float edge = 1.0 - smoothstep(0.0, max(0.07, 1.5 * fwidth(e)), e);
  float inner = smoothstep(0.18, 0.4, e) * vGlow.a;
  float a = max(inner, edge * vEdge.a);
  if (a < 0.01) discard;
  gl_FragColor = vec4(mix(vGlow.rgb, vEdge.rgb, edge), a);
}`;

/** Bars per pad (slots, CPU, memory). */
const BARS = 3;

export class WorkerPads {
  /**
   * @param {THREE.Object3D} parent
   * @param {(className: string) => THREE.Object3D & {element: HTMLElement}} makeLabel
   * @param {{labels?: number}} opts labels: size of the label pool
   */
  constructor(parent, makeLabel, { labels = 32 } = {}) {
    this.parent = parent;
    this.makeLabel = makeLabel;
    /** @type {Map<string, object>} */
    this.pads = new Map();
    /** @type {string[]} pad names by instance index */
    this.order = [];
    const bar = new THREE.BoxGeometry(1, 0.05, 0.16);
    // A unit bar anchored at its left end, so scale.x is the fill.
    bar.translate(0.5, 0, 0);
    const body = new THREE.BoxGeometry(PAD_W, PAD_H, PAD_D);
    body.translate(0, PAD_H / 2, 0);
    const glow = new THREE.PlaneGeometry(PAD_W + 0.04, PAD_D + 0.04);
    glow.rotateX(-Math.PI / 2);
    this.base = { body, glow, bar };
    this.mat = {
      body: new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.5 }),
      glow: new THREE.ShaderMaterial({
        vertexShader: glowVertex,
        fragmentShader: glowFragment,
        transparent: true,
        depthWrite: false,
        // Drawn just above the pad's top: pulled forward in depth so it
        // doesn't fight the top when zoomed out.
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -4,
        uniforms: { uSize: { value: new THREE.Vector2(PAD_W + 0.04, PAD_D + 0.04) } },
      }),
      track: new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.9 }),
      fill: new THREE.MeshBasicMaterial(),
    };
    this.ranges = { pad: new DirtyRanges(), bar: new DirtyRanges() };
    this.capacity = 0;
    this.mesh = null;
    this.allocate(16);
    this.focus = { worker: null, strong: false };
    this.labelPool = [];
    for (let i = 0; i < labels; i++) {
      const l = makeLabel('worker-label');
      l.visible = false;
      parent.add(l);
      this.labelPool.push(l);
    }
    /** pad name -> label shown for it */
    this.labelOf = new Map();
    this.m4 = new THREE.Matrix4();
    this.c = new THREE.Color();
  }

  /** (Re)creates the instanced meshes for cap pads. */
  allocate(cap) {
    if (this.mesh) {
      for (const m of Object.values(this.mesh)) {
        this.parent.remove(m);
        m.geometry.dispose();
        m.dispose();
      }
    }
    const make = (geo, mat, n) => {
      const m = new THREE.InstancedMesh(geo.clone(), mat, n);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.count = 0;
      m.frustumCulled = false;
      this.parent.add(m);
      return m;
    };
    const body = make(this.base.body, this.mat.body, cap);
    body.castShadow = true;
    body.receiveShadow = true;
    body.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    const glow = make(this.base.glow, this.mat.glow, cap);
    glow.renderOrder = 2;
    this.glowAttrs = {
      aGlow: new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4),
      aEdge: new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4),
    };
    for (const [n, a] of Object.entries(this.glowAttrs)) glow.geometry.setAttribute(n, a);
    const track = make(this.base.bar, this.mat.track, cap * BARS);
    const fill = make(this.base.bar, this.mat.fill, cap * BARS);
    fill.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * BARS * 3), 3);
    this.mesh = { body, glow, track, fill };
    this.capacity = cap;
  }

  get count() {
    return this.order.length;
  }

  /**
   * Lays out every pad: items in order, each {worker, x, z, usage}. Pads of
   * workers not in items go away.
   */
  sync(items, theme, blending, { cardAbove = false } = {}) {
    this.theme = theme;
    this.blending = blending;
    this.cardAbove = cardAbove;
    const light = !theme.glow.additive;
    this.mat.body.roughness = light ? 0.85 : 0.45;
    this.mat.body.metalness = light ? 0 : 0.5;
    this.mat.track.color.set(theme.worker.track);
    this.mat.glow.blending = blending;
    this.mat.glow.needsUpdate = true;
    // Theme colors parsed once, not per pad write.
    const w = theme.worker;
    this.col = Object.fromEntries(['pad', 'idle', 'highlight', 'draining', 'active', 'padEdge', 'full', 'fill'].map((k) => [k, new THREE.Color(w[k])]));
    if (items.length > this.capacity) this.allocate(Math.max(items.length, this.capacity * 2));
    const before = this.pads;
    this.pads = new Map();
    this.order = items.map((it) => it.worker.name);
    items.forEach((it, i) => {
      const p = before.get(it.worker.name) || { name: it.worker.name, pos: new THREE.Vector3() };
      p.index = i;
      p.worker = it.worker;
      p.usage = it.usage;
      p.x = it.x;
      p.z = it.z;
      p.pos.set(it.x, PAD_H + 0.02, it.z);
      this.pads.set(p.name, p);
      this.write(p);
    });
    for (const m of Object.values(this.mesh)) m.count = items.length * (m === this.mesh.track || m === this.mesh.fill ? BARS : 1);
    for (const [name, l] of this.labelOf) if (!this.pads.has(name)) this.hideLabel(name, l);
    this.ranges.pad.markAll();
    this.ranges.bar.markAll();
    this.rects = null;
  }

  /** A worker's state or usage changed: rewrites its pad only. */
  update(name, worker, usage) {
    const p = this.pads.get(name);
    if (!p) return false;
    p.worker = worker;
    p.usage = usage;
    this.write(p);
    return true;
  }

  /** Writes a pad's instances: body, glow and edge, bars; and its label if shown. */
  write(p) {
    const C = this.col;
    const i = p.index;
    const light = !this.theme.glow.additive;
    const hosted = p.usage.actors.used;
    const focused = this.focus.worker === p.name;
    const strong = focused && this.focus.strong;
    const draining = p.worker.state === 'DRAINING';
    const s = strong ? 1.08 : 1;
    const m4 = this.m4;
    m4.makeScale(s, s, s).setPosition(p.x, 0, p.z);
    this.mesh.body.setMatrixAt(i, m4);
    this.mesh.body.setColorAt(i, hosted ? C.pad : C.idle);
    m4.makeScale(s, 1, s).setPosition(p.x, PAD_H * s + 0.012, p.z);
    this.mesh.glow.setMatrixAt(i, m4);
    let a = hosted ? (0.06 + Math.min(hosted, 8) * 0.02) * (light ? 2.5 : 1) : 0;
    if (focused) a = strong ? (light ? 0.55 : 0.6) : light ? 0.35 : 0.4;
    const g = focused ? C.highlight : draining ? C.draining : C.active;
    const ga = this.glowAttrs.aGlow.array;
    ga[i * 4] = g.r;
    ga[i * 4 + 1] = g.g;
    ga[i * 4 + 2] = g.b;
    ga[i * 4 + 3] = a;
    const e = focused ? C.highlight : C.padEdge;
    const ea = this.glowAttrs.aEdge.array;
    ea[i * 4] = e.r;
    ea[i * 4 + 1] = e.g;
    ea[i * 4 + 2] = e.b;
    ea[i * 4 + 3] = focused ? 1 : 0.55;
    this.ranges.pad.mark(i);
    // Up to three bars (slots, CPU, memory) along the pad's front edge.
    const fill = (u) => (u?.reported ? u.frac : null);
    const fills = [p.usage.actors.cap ? p.usage.actors.frac : null, fill(p.usage.cpu), fill(p.usage.memory)].filter((f) => f !== null);
    for (let j = 0; j < BARS; j++) {
      const k = i * BARS + j;
      const f = fills[j];
      if (f === undefined) {
        m4.makeScale(0, 0, 0);
        this.mesh.track.setMatrixAt(k, m4);
        this.mesh.fill.setMatrixAt(k, m4);
        continue;
      }
      const z = p.z + (PAD_D / 2 - 0.2 - j * 0.24) * s;
      m4.makeScale(BAR_W * s, 1, 1).setPosition(p.x - (BAR_W / 2) * s, PAD_H * s + 0.03, z);
      this.mesh.track.setMatrixAt(k, m4);
      m4.makeScale(Math.max(0.001, Math.min(1, f)) * BAR_W * s, 1.2, 0.8).setPosition(p.x - (BAR_W / 2) * s, PAD_H * s + 0.045, z);
      this.mesh.fill.setMatrixAt(k, m4);
      this.mesh.fill.setColorAt(k, f >= FULL ? C.full : C.fill);
    }
    this.ranges.bar.mark(i);
    const l = this.labelOf.get(p.name);
    if (l) this.styleLabel(l, p);
  }

  /** Sets the worker in focus and rewrites the pads it changes. */
  setFocus(focus) {
    const before = this.focus.worker;
    this.focus = { ...focus };
    if (!this.theme) return;
    for (const name of new Set([before, focus.worker])) {
      const p = name && this.pads.get(name);
      if (p) this.write(p);
    }
  }

  get(name) {
    return this.pads.get(name);
  }

  /** The pad under the ground point (x, z), by worker name, or null. */
  at(x, z) {
    if (!this.rects) {
      this.grid = new Map();
      for (const p of this.pads.values()) {
        const k = `${Math.floor(p.x / 8)},${Math.floor(p.z / 8)}`;
        if (!this.grid.has(k)) this.grid.set(k, []);
        this.grid.get(k).push(p);
      }
      this.rects = true;
    }
    const cx = Math.floor(x / 8);
    const cz = Math.floor(z / 8);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (const p of this.grid.get(`${cx + dx},${cz + dz}`) || []) {
          if (Math.abs(x - p.x) <= PAD_W / 2 && Math.abs(z - p.z) <= PAD_D / 2) return p.name;
        }
      }
    }
    return null;
  }

  // ----------------------------------------------------------------- labels

  /**
   * Shows labels for these pads ([{name, card}], in priority order), as many
   * as the pool holds; every other pad's label is hidden.
   */
  showLabels(list) {
    const want = new Map();
    for (const it of list) if (this.pads.has(it.name) && want.size < this.labelPool.length) want.set(it.name, it.card);
    for (const [name, l] of [...this.labelOf]) if (!want.has(name)) this.hideLabel(name, l);
    const free = this.labelPool.filter((l) => ![...this.labelOf.values()].includes(l));
    for (const [name, card] of want) {
      let l = this.labelOf.get(name);
      if (!l) {
        l = free.pop();
        if (!l) break;
        this.labelOf.set(name, l);
      }
      l.userData.card = card;
      l.visible = true;
      this.styleLabel(l, this.pads.get(name));
    }
  }

  hideLabel(name, l) {
    l.visible = false;
    this.labelOf.delete(name);
  }

  /** The label object shown for a pad, if any. */
  labelFor(name) {
    return this.labelOf.get(name);
  }

  styleLabel(l, p) {
    const focused = this.focus.worker === p.name;
    const strong = focused && this.focus.strong;
    // A compact label sits in front of the pad; a card hangs below it, or
    // rises above it where agents stand in front of the pad (worker view).
    if (!strong) {
      l.position.set(p.x, 0.2, p.z + PAD_D / 2 + 0.75);
      l.center?.set(0.5, 0.5);
    } else if (this.cardAbove) {
      l.position.set(p.x, 0.5, p.z - PAD_D / 2);
      l.center?.set(0.5, 1);
    } else {
      l.position.set(p.x, 0.2, p.z + PAD_D / 2 + 0.25);
      l.center?.set(0.5, 0);
    }
    const el = l.element;
    if (!el) return;
    const html = padLabelHTML(p.worker, p.usage, strong);
    if (el.innerHTML !== html) el.innerHTML = html;
    el.classList?.toggle('card', strong);
    el.classList?.toggle('focused', focused);
    el.classList?.toggle('draining', p.worker.state === 'DRAINING');
  }

  /** Uploads the instances written since the last flush. */
  flush() {
    const n = this.order.length;
    const pr = this.ranges.pad.take(n);
    uploadRanges([this.mesh.body.instanceMatrix, this.mesh.body.instanceColor, this.mesh.glow.instanceMatrix, this.glowAttrs.aGlow, this.glowAttrs.aEdge], pr);
    const br = this.ranges.bar.take(n);
    const bars = br && br.map((r) => ({ start: r.start * BARS, count: r.count * BARS }));
    uploadRanges([this.mesh.track.instanceMatrix, this.mesh.fill.instanceMatrix, this.mesh.fill.instanceColor], bars);
  }

  /** Instance counts, for the perf overlay. */
  stats() {
    return { pads: this.order.length, bars: this.order.length * BARS };
  }

  dispose() {
    for (const m of Object.values(this.mesh)) {
      this.parent.remove(m);
      m.geometry.dispose();
      m.dispose();
    }
    for (const g of Object.values(this.base)) g.dispose();
    for (const m of Object.values(this.mat)) m.dispose();
    for (const l of this.labelPool) {
      l.element?.remove?.();
      this.parent.remove(l);
    }
    this.labelPool = [];
    this.labelOf.clear();
    this.pads.clear();
    this.order = [];
  }
}
