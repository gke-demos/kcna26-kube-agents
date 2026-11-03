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

// Agent-to-worker links: a faint arc from each agent that holds a worker to
// its worker's pad, with small dots that flow along it toward the worker
// (busier agents send more and faster dots). Everything is computed on the
// GPU from per-link endpoints: one instanced draw for the arcs and one for
// the dots, whatever the number of links. Moving an agent only rewrites its
// link's endpoints. Pure three.js (no DOM), so node tests can build it.

import * as THREE from 'three';

/** Segments per arc. */
export const SEGMENTS = 14;
/** Most dots on one link (a busy agent). */
export const DOTS = 3;

const curve = /* glsl */ `
attribute vec3 aFrom;
attribute vec3 aTo;
attribute vec3 aMeta; // level (-1 dim, 0, 1 sibling, 2 lit), rate (0..1), seed
vec3 linkPoint(float t) {
  vec3 c = 0.5 * (aFrom + aTo);
  float d = distance(aFrom.xz, aTo.xz);
  c.y = max(aFrom.y, aTo.y) + 0.16 * d + 0.5;
  float u = 1.0 - t;
  return u * u * aFrom + 2.0 * u * t * c + t * t * aTo;
}
uniform float uAlpha;
uniform float uHiAlpha;
uniform float uFocus;
float linkAlpha(float lv) {
  if (lv > 1.5) return uHiAlpha;
  if (lv > 0.5) return mix(uAlpha, uHiAlpha, 0.55);
  if (lv < -0.5) return uAlpha * 0.18;
  return uAlpha * (1.0 - 0.45 * uFocus);
}
`;

const lineVertex = /* glsl */ `
${curve}
varying float vA;
varying float vHi;
void main() {
  float t = position.x;
  vec3 p = linkPoint(t);
  vA = linkAlpha(aMeta.x) * smoothstep(0.0, 0.12, t);
  vHi = aMeta.x > 0.5 ? 1.0 : 0.0;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;

const lineFragment = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uHiColor;
varying float vA;
varying float vHi;
void main() {
  gl_FragColor = vec4(mix(uColor, uHiColor, vHi), vA);
}`;

const dotVertex = /* glsl */ `
${curve}
uniform float uTime;
uniform float uFlow;
uniform float uSize;
uniform float uScale;
uniform float uDotAlpha;
varying float vA;
varying float vHi;
void main() {
  float k = position.x;
  float rate = aMeta.y;
  float n = 1.0 + floor(rate * ${(DOTS - 1).toFixed(1)} + 0.5);
  if (uFlow < 0.5 || k >= n || aMeta.x < -0.5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vA = 0.0;
    vHi = 0.0;
    return;
  }
  float speed = 0.16 + 0.55 * rate;
  float t = fract(uTime * speed + aMeta.z + k / n);
  vec3 p = linkPoint(t);
  vec4 mv = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float lit = aMeta.x > 0.5 ? 1.0 : 0.0;
  gl_PointSize = clamp(uSize * (1.0 + 0.6 * lit) * uScale / max(-mv.z, 0.1), 2.0, 16.0);
  float base = lit > 0.5 ? 1.0 : uDotAlpha * (1.0 - 0.6 * uFocus);
  vA = base * smoothstep(0.0, 0.1, t) * (1.0 - smoothstep(0.86, 1.0, t));
  vHi = lit;
}`;

const dotFragment = /* glsl */ `
uniform vec3 uFlowColor;
uniform vec3 uHiColor;
varying float vA;
varying float vHi;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float d = dot(c, c);
  if (d > 1.0) discard;
  gl_FragColor = vec4(mix(uFlowColor, uHiColor, vHi * 0.6), vA * (1.0 - d));
}`;

/** One InstancedBufferGeometry whose base vertices are parameters along the arc. */
function baseGeometry(params) {
  const g = new THREE.InstancedBufferGeometry();
  const pos = new Float32Array(params.length * 3);
  params.forEach((t, i) => (pos[i * 3] = t));
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.instanceCount = 0;
  return g;
}

/**
 * Links keyed by agent. set() adds or moves a link; remove() drops it (the
 * last link moves into its slot, like the agent layers).
 */
export class LinkSet {
  /**
   * @param {THREE.Object3D} parent
   * @param {{value: number}} timeUniform
   */
  constructor(parent, timeUniform) {
    this.parent = parent;
    this.slots = new Map();
    this.keys = [];
    this.capacity = 0;
    const shared = {
      uAlpha: { value: 0.1 },
      uHiAlpha: { value: 0.8 },
      uFocus: { value: 0 },
      uHiColor: { value: new THREE.Color(0xffffff) },
    };
    this.uniforms = shared;
    this.lineMaterial = new THREE.ShaderMaterial({
      vertexShader: lineVertex,
      fragmentShader: lineFragment,
      transparent: true,
      depthWrite: false,
      uniforms: { ...shared, uColor: { value: new THREE.Color(0xffffff) } },
    });
    this.dotMaterial = new THREE.ShaderMaterial({
      vertexShader: dotVertex,
      fragmentShader: dotFragment,
      transparent: true,
      depthWrite: false,
      uniforms: {
        ...shared,
        uTime: timeUniform,
        uFlow: { value: 1 },
        uSize: { value: 0.28 },
        uScale: { value: 600 },
        uDotAlpha: { value: 0.5 },
        uFlowColor: { value: new THREE.Color(0xffffff) },
      },
    });
    const lineParams = [];
    for (let i = 0; i < SEGMENTS; i++) lineParams.push(i / SEGMENTS, (i + 1) / SEGMENTS);
    this.lines = new THREE.LineSegments(baseGeometry(lineParams), this.lineMaterial);
    this.dots = new THREE.Points(
      baseGeometry(Array.from({ length: DOTS }, (_, k) => k)),
      this.dotMaterial,
    );
    for (const o of [this.lines, this.dots]) {
      o.frustumCulled = false;
      o.renderOrder = 3;
      parent.add(o);
    }
    this.dirty = false;
    this.allocate(64);
  }

  get count() {
    return this.keys.length;
  }

  allocate(cap) {
    const old = this.attrs;
    const attrs = {
      aFrom: new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3),
      aTo: new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3),
      aMeta: new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3),
    };
    for (const [name, a] of Object.entries(attrs)) {
      a.setUsage(THREE.DynamicDrawUsage);
      if (old) a.array.set(old[name].array.subarray(0, this.keys.length * 3));
    }
    // Fresh geometries: three.js caches the instance count limit per geometry.
    for (const o of [this.lines, this.dots]) {
      const g = o.geometry;
      const fresh = new THREE.InstancedBufferGeometry();
      fresh.setAttribute('position', g.getAttribute('position'));
      for (const [name, a] of Object.entries(attrs)) fresh.setAttribute(name, a);
      fresh.instanceCount = this.keys.length;
      o.geometry = fresh;
      g.dispose();
    }
    this.attrs = attrs;
    this.capacity = cap;
    this.dirty = true;
  }

  /**
   * Adds or updates a link.
   * @param {string} key the agent
   * @param {{x: number, y: number, z: number}} from the agent's top
   * @param {{x: number, y: number, z: number}} to the worker pad
   * @param {number} level highlight level (see workers.js HI)
   * @param {number} rate 0 (idle) to 1 (busy)
   * @param {number} seed 0..1, the phase of the dots
   */
  set(key, from, to, level, rate, seed) {
    let i = this.slots.get(key);
    if (i === undefined) {
      if (this.keys.length >= this.capacity) this.allocate(this.capacity * 2);
      i = this.keys.length;
      this.keys.push(key);
      this.slots.set(key, i);
      this.setCount();
    }
    const f = this.attrs.aFrom.array;
    const t = this.attrs.aTo.array;
    const m = this.attrs.aMeta.array;
    const o = i * 3;
    f[o] = from.x;
    f[o + 1] = from.y;
    f[o + 2] = from.z;
    t[o] = to.x;
    t[o + 1] = to.y;
    t[o + 2] = to.z;
    m[o] = level;
    m[o + 1] = rate;
    m[o + 2] = seed;
    this.dirty = true;
  }

  /** Moves a link's agent end only. */
  setFrom(key, x, y, z) {
    const i = this.slots.get(key);
    if (i === undefined) return;
    const f = this.attrs.aFrom.array;
    f[i * 3] = x;
    f[i * 3 + 1] = y;
    f[i * 3 + 2] = z;
    this.dirty = true;
  }

  /** Sets a link's highlight level. */
  setLevel(key, level) {
    const i = this.slots.get(key);
    if (i === undefined) return;
    this.attrs.aMeta.array[i * 3] = level;
    this.dirty = true;
  }

  has(key) {
    return this.slots.has(key);
  }

  remove(key) {
    const i = this.slots.get(key);
    if (i === undefined) return;
    const last = this.keys.length - 1;
    if (i !== last) {
      const moved = this.keys[last];
      this.keys[i] = moved;
      this.slots.set(moved, i);
      for (const a of Object.values(this.attrs)) a.array.copyWithin(i * 3, last * 3, last * 3 + 3);
    }
    this.keys.pop();
    this.slots.delete(key);
    this.setCount();
    this.dirty = true;
  }

  clear() {
    this.keys.length = 0;
    this.slots.clear();
    this.setCount();
  }

  setCount() {
    this.lines.geometry.instanceCount = this.keys.length;
    this.dots.geometry.instanceCount = this.keys.length;
  }

  /** Colors and blending from a theme; restAlpha is the arcs' alpha at rest. */
  setLook({ color, highlight, flow, restAlpha, focusAlpha, dotAlpha, blending }) {
    this.lineMaterial.uniforms.uColor.value.set(color);
    this.uniforms.uHiColor.value.set(highlight);
    this.dotMaterial.uniforms.uFlowColor.value.set(flow);
    this.uniforms.uAlpha.value = restAlpha;
    this.uniforms.uHiAlpha.value = focusAlpha;
    this.dotMaterial.uniforms.uDotAlpha.value = dotAlpha;
    for (const m of [this.lineMaterial, this.dotMaterial]) {
      m.blending = blending;
      m.needsUpdate = true;
    }
  }

  /** Dots flowing (false: static arcs only). */
  setFlow(on) {
    this.dotMaterial.uniforms.uFlow.value = on ? 1 : 0;
    this.dots.visible = on;
  }

  /** 0..1: how much a focus fades the links that aren't in it. */
  setFocus(v) {
    this.uniforms.uFocus.value = v;
  }

  /** Pixels per world unit at distance 1 (for dot sizes). */
  setScale(px) {
    this.dotMaterial.uniforms.uScale.value = px;
  }

  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    for (const a of Object.values(this.attrs)) a.needsUpdate = true;
  }

  dispose() {
    for (const o of [this.lines, this.dots]) {
      this.parent.remove(o);
      o.geometry.dispose();
    }
    this.lineMaterial.dispose();
    this.dotMaterial.dispose();
  }
}
