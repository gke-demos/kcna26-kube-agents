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

// Every agent as one point sprite (the mid level of detail): one vertex per
// agent, one draw call for all of them, drawn by a shader that sizes the
// sprite to the agent's cell on screen and gives it its state color, glow,
// running breath, crash pulse and change flash. The sprite's outline hints
// at the agent shape (orb, spark, meeple, droid, box). Points fade out where
// a district shows as its aggregate tile (far) and where the agent is drawn
// as a full shape (close). Agents keep a stable index; a state change
// rewrites a few floats and uploads only the ranges written (dirty.js).
// Pure three.js (no DOM), so node tests can build it.

import * as THREE from 'three';
import { CLASSES } from './model.js';
import { DirtyRanges, uploadRanges } from './dirty.js';

/** Sprite shape per agent shape id (the fragment shader's uShape). */
export const SPRITE = { orb: 0, spark: 1, meeple: 2, droid: 3, box: 4 };

/** Class index per visual class (the order of CLASSES). */
export const CLASS_INDEX = Object.fromEntries(CLASSES.map((c, i) => [c, i]));

const vertex = /* glsl */ `
attribute vec4 aA; // class, seed, dim, worker index (-1 none)
attribute vec4 aB; // flash time, drawn as a shape (0/1), team hue (-1 none, +2 parked), live (0/1)
uniform float uTime;
uniform float uScale;
uniform float uFarLo;
uniform float uFarHi;
uniform float uCloseNear;
uniform float uCloseFar;
uniform float uAllShapes;
uniform float uFocusW;
uniform float uFocusStrong;
uniform float uHiDim;
uniform vec3 uColors[5];
uniform float uLift[5];
uniform float uTeam;
uniform float uTeamSat;
uniform float uTeamLight;
varying vec3 vColor;
varying float vA;
varying float vCls;
varying float vHi;
varying float vDim;
varying vec3 vTint;
varying float vTeamA;
varying float vSprite;
vec3 hsl2rgb(float h, float s, float l) {
  vec3 k = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  return l + s * (k - 0.5) * (1.0 - abs(2.0 * l - 1.0));
}
void main() {
  if (aB.w < 0.5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    return;
  }
  int c = int(aA.x + 0.5);
  vec3 p = position;
  p.y += uLift[c];
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float depth = max(-mv.z, 0.01);
  float px = 1.5 * uScale / depth;
  float far = 1.0 - smoothstep(uFarLo, uFarHi, px);
  float close = aB.y > 0.5 ? (uAllShapes > 0.5 ? 1.0 : smoothstep(uCloseFar, uCloseNear, distance(p, cameraPosition))) : 0.0;
  float a = (1.0 - far) * (1.0 - close);
  if (a < 0.01) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    return;
  }
  // Worker focus: lit (2) on the focused worker, dimmed (-1) elsewhere when strong.
  float hi = 0.0;
  if (uFocusW >= 0.0) {
    if (abs(aA.w - uFocusW) < 0.5) hi = uFocusStrong > 0.5 ? 2.0 : 1.0;
    else hi = uFocusStrong > 0.5 ? -1.0 : 0.0;
  }
  float ph = aA.y * 6.2831;
  float wave = 0.5 + 0.5 * sin(uTime * (c == 3 ? 5.0 : 1.4) + ph);
  float age = uTime - aB.x;
  float flash = (aB.x > 0.0 && age >= 0.0) ? exp(-age * 1.6) : 0.0;
  float pulse = c == 3 ? pow(wave, 4.0) : 0.0;
  float size = clamp(px * 0.6, 2.0, 44.0);
  size *= (c == 2 ? 0.78 : 1.0) * (1.0 + 0.5 * flash + 0.3 * pulse) * (hi > 1.5 ? 1.2 : 1.0);
  // Room for the team tint square around the sprite (worker view).
  float teamA = (aB.z >= 0.0 && uTeam > 0.005) ? uTeam * (aB.z >= 2.0 ? 0.45 : 1.0) : 0.0;
  gl_PointSize = teamA > 0.0 ? max(size, px * 0.9) : size;
  vTeamA = teamA;
  vTint = hsl2rgb(fract(aB.z), uTeamSat, uTeamLight);
  float breath = c == 0 ? 0.8 + 0.2 * wave : 1.0;
  vColor = uColors[c] * breath + uColors[c] * (flash * 1.2 + pulse * 0.8);
  vA = a;
  vCls = float(c);
  vHi = hi;
  vDim = max(aA.z * 0.85, hi < -0.5 ? uHiDim : 0.0);
  // The sprite fills size/pointSize of the point (the rest is team tint).
  vSprite = size / gl_PointSize;
  gl_Position = projectionMatrix * mv;
}`;

const fragment = /* glsl */ `
uniform float uShape;
uniform float uAdditive;
uniform vec3 uDimColor;
uniform float uFade;
varying vec3 vColor;
varying float vA;
varying float vCls;
varying float vHi;
varying float vDim;
varying vec3 vTint;
varying float vTeamA;
varying float vSprite;
float sdBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  q.y = -q.y;
  // Team tint: a rounded square behind the sprite (worker view).
  float tint = vTeamA * (1.0 - smoothstep(-0.05, 0.05, sdBox(q, vec2(0.86), 0.3)));
  vec2 s = q / max(vSprite, 0.05);
  float d;
  if (uShape < 0.5) {
    d = length(s) - 0.62; // orb
  } else if (uShape < 1.5) {
    vec2 a = abs(s); // spark: a four-point star
    d = pow(pow(a.x, 0.55) + pow(a.y, 0.55), 1.0 / 0.55) - 0.78;
  } else if (uShape < 2.5) {
    // meeple: a head over a body
    float head = length(s - vec2(0.0, 0.42)) - 0.26;
    float body = sdBox(s + vec2(0.0, 0.22), vec2(0.42, 0.36), 0.2);
    d = min(head, body);
  } else if (uShape < 3.5) {
    d = sdBox(s, vec2(0.52, 0.6), 0.22); // droid
  } else {
    d = sdBox(s, vec2(0.55), 0.06); // box
  }
  float aa = 0.12;
  float body = 1.0 - smoothstep(-aa, aa, d);
  // Pending: an outline only.
  if (vCls > 3.5) body *= smoothstep(-0.3, -0.12, d);
  float glow = exp(-max(d, 0.0) * 5.0) * (vCls < 0.5 || vCls > 2.5 ? 0.55 : 0.18) * uAdditive;
  vec3 col = vColor;
  // Suspended: flatter and a little desaturated.
  if (vCls > 1.5 && vCls < 2.5) col = mix(col, vec3(dot(col, vec3(0.299, 0.587, 0.114))), 0.35) * 0.85;
  if (uShape > 2.5 && uShape < 3.5) {
    // The droid's visor band.
    float band = 1.0 - smoothstep(0.0, 0.05, abs(s.y - 0.1) - 0.1);
    col = mix(col, vCls < 0.5 ? mix(col, vec3(1.0), 0.6) : col * 0.25, band * body * 0.8);
  }
  float hi = vHi > 1.5 ? 1.0 : (vHi > 0.5 ? 0.4 : 0.0);
  col = mix(col, mix(col * 0.92, col + (col * 0.7 + 0.1), uAdditive), hi);
  float a = max(body, glow);
  col = mix(col, uDimColor, vDim);
  a *= 1.0 - vDim * 0.5;
  // Composite over the tint.
  vec3 outc = mix(vTint, col, a);
  float outa = max(a, tint);
  outa *= vA * uFade;
  if (outa < 0.01) discard;
  gl_FragColor = vec4(outc, outa);
}`;

/** One point per agent, with stable indices and partial uploads. */
export class PointLayer {
  /**
   * @param {THREE.Object3D} parent
   * @param {{value: number}} timeUniform
   * @param {object} look shared uniforms (uScale, uFarLo, uFarHi, uCloseNear, uCloseFar, uAllShapes, uHiDim, uDimColor, uTeam, uTeamSat, uTeamLight, uAdditive)
   * @param {{fade?: {value: number}}} opts fade: a 0..1 uniform the points' alpha follows (the decks' fade)
   */
  constructor(parent, timeUniform, look, opts = {}) {
    this.parent = parent;
    this.capacity = 0;
    this.hwm = 0; // highest index in use + 1 (the draw range)
    this.freeList = [];
    this.live = new Uint8Array(0);
    this.ranges = { pos: new DirtyRanges(), a: new DirtyRanges(), b: new DirtyRanges() };
    this.uniforms = {
      uTime: timeUniform,
      uColors: { value: CLASSES.map(() => new THREE.Color(0xffffff)) },
      uLift: { value: [0.75, 0.55, 0.24, 0.32, 0.45] },
      uShape: { value: 0 },
      uFocusW: { value: -1 },
      uFocusStrong: { value: 0 },
      ...look,
      uFade: opts.fade || { value: 1 },
    };
    this.material = new THREE.ShaderMaterial({
      vertexShader: vertex,
      fragmentShader: fragment,
      transparent: true,
      depthWrite: false,
      uniforms: this.uniforms,
    });
    this.geometry = new THREE.BufferGeometry();
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
    parent.add(this.points);
    this.allocate(1024);
  }

  allocate(cap) {
    const old = this.attrs;
    const attrs = {
      position: new THREE.BufferAttribute(new Float32Array(cap * 3), 3),
      aA: new THREE.BufferAttribute(new Float32Array(cap * 4), 4),
      aB: new THREE.BufferAttribute(new Float32Array(cap * 4), 4),
    };
    for (const [name, a] of Object.entries(attrs)) {
      a.setUsage(THREE.DynamicDrawUsage);
      if (old) a.array.set(old[name].array.subarray(0, Math.min(old[name].array.length, a.array.length)));
    }
    const live = new Uint8Array(cap);
    live.set(this.live.subarray(0, Math.min(this.live.length, cap)));
    this.live = live;
    // A fresh geometry: three.js sizes GPU buffers when it first sees them.
    const g = new THREE.BufferGeometry();
    for (const [name, a] of Object.entries(attrs)) g.setAttribute(name, a);
    g.setDrawRange(0, this.hwm);
    this.points.geometry = g;
    this.geometry.dispose();
    this.geometry = g;
    this.attrs = attrs;
    this.capacity = cap;
  }

  /** A free index for a new agent. */
  alloc() {
    let i;
    if (this.freeList.length) i = this.freeList.pop();
    else {
      if (this.hwm >= this.capacity) this.allocate(this.capacity * 2);
      i = this.hwm++;
      this.geometry.setDrawRange(0, this.hwm);
    }
    this.live[i] = 1;
    this.attrs.aB.array[i * 4 + 3] = 1;
    this.ranges.b.mark(i);
    return i;
  }

  /** Frees an agent's index (the point stops drawing). */
  free(i) {
    if (i < 0 || !this.live[i]) return;
    this.live[i] = 0;
    this.attrs.aB.array[i * 4 + 3] = 0;
    this.ranges.b.mark(i);
    this.freeList.push(i);
  }

  /** Forgets every point. */
  clear() {
    this.live.fill(0);
    this.attrs.aB.array.fill(0);
    this.freeList.length = 0;
    this.hwm = 0;
    this.geometry.setDrawRange(0, 0);
    for (const r of Object.values(this.ranges)) r.markAll();
  }

  get count() {
    return this.hwm - this.freeList.length;
  }

  setPos(i, x, y, z) {
    const p = this.attrs.position.array;
    p[i * 3] = x;
    p[i * 3 + 1] = y;
    p[i * 3 + 2] = z;
    this.ranges.pos.mark(i);
  }

  /** Writes aA: class index, seed, dim (0/1), worker index (-1 none). */
  setA(i, cls, seed, dim, worker) {
    const a = this.attrs.aA.array;
    a[i * 4] = cls;
    a[i * 4 + 1] = seed;
    a[i * 4 + 2] = dim;
    a[i * 4 + 3] = worker;
    this.ranges.a.mark(i);
  }

  setClass(i, cls) {
    this.attrs.aA.array[i * 4] = cls;
    this.ranges.a.mark(i);
  }

  setDim(i, dim) {
    const a = this.attrs.aA.array;
    if (a[i * 4 + 2] === dim) return;
    a[i * 4 + 2] = dim;
    this.ranges.a.mark(i);
  }

  setWorker(i, w) {
    this.attrs.aA.array[i * 4 + 3] = w;
    this.ranges.a.mark(i);
  }

  setFlash(i, t) {
    this.attrs.aB.array[i * 4] = t;
    this.ranges.b.mark(i);
  }

  /** Whether the agent is drawn as a full shape (the point fades out close). */
  setNear(i, on) {
    this.attrs.aB.array[i * 4 + 1] = on ? 1 : 0;
    this.ranges.b.mark(i);
  }

  setTeam(i, team) {
    this.attrs.aB.array[i * 4 + 2] = team;
    this.ranges.b.mark(i);
  }

  /** Colors per class (theme) and the sprite for the agent shape. */
  setLook(colors, shapeId, blending) {
    CLASSES.forEach((c, i) => this.uniforms.uColors.value[i].set(colors[c]));
    this.uniforms.uShape.value = SPRITE[shapeId] ?? 0;
    this.material.blending = blending;
    this.material.needsUpdate = true;
  }

  /** The worker in focus as an index (-1 none) and whether it is a strong focus. */
  setFocus(workerIndex, strong) {
    this.uniforms.uFocusW.value = workerIndex;
    this.uniforms.uFocusStrong.value = strong ? 1 : 0;
  }

  /** Uploads what was written since the last flush: ranges, or whole buffers when cheaper. */
  flush() {
    const n = this.hwm;
    uploadRanges([this.attrs.position], this.ranges.pos.take(n));
    uploadRanges([this.attrs.aA], this.ranges.a.take(n));
    uploadRanges([this.attrs.aB], this.ranges.b.take(n));
  }

  dispose() {
    this.parent.remove(this.points);
    this.geometry.dispose();
    this.material.dispose();
  }
}
