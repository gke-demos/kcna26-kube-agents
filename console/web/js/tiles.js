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

// Far level of detail: each district (atespace, or in worker view each node
// pool and the parked area) is one aggregate tile, a grid of cells (one per
// agent, or per few agents in big districts) colored in the district's mix
// of states, with running cells breathing and crashed ones pulsing, so the
// cluster's shape and heat read without a single agent object. One
// instanced draw for every tile; the tile fades in per pixel where agent
// cells get too small on screen (the same rule the points fade out by).
// Pure three.js (no DOM), so node tests can build it.

import * as THREE from 'three';
import { CLASSES } from './model.js';
import { DirtyRanges, uploadRanges } from './dirty.js';

/** Most waffle cells per tile (a cell stands for several agents beyond this). */
export const MAX_CELLS = 900;

/**
 * The waffle fractions of a district's counts: running, changing, crashed,
 * pending (suspended is the rest), and the share of the tile its agents
 * fill. counts: {total, running, transition, crashed, pending, ...}.
 */
export function tileFractions(c) {
  const t = Math.max(1, c.total);
  return [c.running / t, c.transition / t, c.crashed / t, c.pending / t];
}

const vertex = /* glsl */ `
attribute vec4 aFrac; // running, changing, crashed, pending (suspended: the rest)
attribute vec4 aInfo; // total agents, match fraction, lit (focus), seed
attribute vec2 aSize; // world width, depth
varying vec2 vUv;
varying vec4 vFrac;
varying vec4 vInfo;
varying vec2 vSize;
varying float vDepth;
void main() {
  vUv = uv;
  vFrac = aFrac;
  vInfo = aInfo;
  vSize = aSize;
  vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;

const fragment = /* glsl */ `
uniform float uTime;
uniform float uScale;
uniform float uFarLo;
uniform float uFarHi;
uniform vec3 uColors[5];
uniform vec3 uDimColor;
uniform float uAdditive;
uniform float uCell;
uniform float uFade;
varying vec2 vUv;
varying vec4 vFrac;
varying vec4 vInfo;
varying vec2 vSize;
varying float vDepth;
void main() {
  float px = uCell * uScale / max(vDepth, 0.01);
  float far = 1.0 - smoothstep(uFarLo, uFarHi, px);
  if (far < 0.01 || vInfo.x < 0.5) discard;
  // Waffle grid: one cell per agent up to ${MAX_CELLS} cells, then a cell stands for several.
  float total = vInfo.x;
  float per = max(1.0, ceil(total / ${MAX_CELLS.toFixed(1)}));
  float units = ceil(total / per);
  float aspect = vSize.x / max(vSize.y, 0.01);
  float cols = max(1.0, ceil(sqrt(units * aspect)));
  float rows = max(1.0, ceil(units / cols));
  vec2 g = vec2(vUv.x * cols, (1.0 - vUv.y) * rows);
  vec2 cell = floor(g);
  vec2 f = fract(g) - 0.5;
  float idx = cell.y * cols + cell.x;
  if (idx >= units) discard;
  // Each cell's state is drawn from the district's mix (a hash per cell),
  // so the tile reads as a heat map of its agents: the share of running,
  // changing, crashed cells matches the counts.
  float u = fract(sin(idx * 91.3458 + vInfo.w * 47.853) * 23421.631);
  float c0 = vFrac.x;
  float c1 = c0 + vFrac.y;
  float c2 = c1 + vFrac.z;
  float c3 = c2 + vFrac.w;
  vec3 col;
  float glow = 0.0;
  float seed = fract(sin(idx * 12.9898 + vInfo.w * 78.233) * 43758.5453);
  if (u < c0) {
    col = uColors[0];
    glow = 0.55 + 0.45 * sin(uTime * 1.4 + seed * 6.2831);
  } else if (u < c1) {
    col = uColors[1];
    glow = 0.6;
  } else if (u < c2) {
    col = uColors[3];
    glow = pow(0.5 + 0.5 * sin(uTime * 5.0 + seed * 6.2831), 4.0) * 1.5;
  } else if (u < c3) {
    col = uColors[4];
  } else {
    col = mix(uColors[2], vec3(dot(uColors[2], vec3(0.299, 0.587, 0.114))), 0.35) * 0.8;
  }
  // Rounded cells with a gap, softened when they get small on screen.
  float cellPx = px * vSize.x / cols / uCell;
  float gap = cellPx > 3.0 ? 0.36 : 0.5;
  vec2 q = abs(f) - (gap - 0.1);
  float d = length(max(q, 0.0)) - 0.1;
  float inside = 1.0 - smoothstep(-0.04, 0.04, d);
  if (cellPx < 2.0) inside = 1.0;
  col += col * glow * 0.6 * mix(0.5, 1.0, uAdditive);
  // Lit (focused worker's pool) tiles brighten; non-matching ones dim.
  col = mix(col, col + 0.25, vInfo.z);
  col = mix(uDimColor, col, mix(0.25, 1.0, vInfo.y));
  float a = inside * far * uFade;
  if (a < 0.01) discard;
  gl_FragColor = vec4(col, a);
}`;

/** One instanced tile per district (or pool) with its counts. */
export class AggregateTiles {
  /**
   * @param {THREE.Object3D} parent
   * @param {{value: number}} timeUniform
   * @param {object} look shared uniforms (uScale, uFarLo, uFarHi, uDimColor, uAdditive)
   * @param {{y?: number, cell?: number, fade?: {value: number}}} opts y: the tiles' height; cell: the
   *   world size of one unit the level of detail measures (an agent cell, or a worker pad's spacing);
   *   fade: a 0..1 uniform the tiles' alpha follows (the decks' fade)
   */
  constructor(parent, timeUniform, look, opts = {}) {
    this.parent = parent;
    const g = new THREE.PlaneGeometry(1, 1);
    g.rotateX(-Math.PI / 2);
    this.base = g;
    this.uniforms = {
      uTime: timeUniform,
      uColors: { value: CLASSES.map(() => new THREE.Color(0xffffff)) },
      ...look,
      uCell: { value: opts.cell ?? 1.5 },
      uFade: opts.fade || { value: 1 },
    };
    this.y = opts.y ?? 0.15;
    this.material = new THREE.ShaderMaterial({
      vertexShader: vertex,
      fragmentShader: fragment,
      transparent: true,
      depthWrite: false,
      uniforms: this.uniforms,
    });
    this.ranges = new DirtyRanges();
    this.mesh = null;
    this.tiles = [];
    this.index = new Map();
    this.allocate(16);
  }

  allocate(cap) {
    if (this.mesh) {
      this.parent.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh.dispose();
    }
    const g = this.base.clone();
    this.attrs = {
      aFrac: new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4),
      aInfo: new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4),
      aSize: new THREE.InstancedBufferAttribute(new Float32Array(cap * 2), 2),
    };
    for (const [name, a] of Object.entries(this.attrs)) {
      a.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute(name, a);
    }
    const mesh = new THREE.InstancedMesh(g, this.material, cap);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.renderOrder = 1;
    this.mesh = mesh;
    this.capacity = cap;
    this.parent.add(mesh);
  }

  /**
   * Lays out the tiles ({name, x, z, w, d, groups}) and writes their counts.
   * @param {object[]} tiles
   * @param {(tile: object) => object} countsOf counts for a tile (see Aggregates.sum)
   */
  sync(tiles, countsOf) {
    if (tiles.length > this.capacity) this.allocate(Math.max(tiles.length, this.capacity * 2));
    this.tiles = tiles;
    this.index = new Map();
    const m = new THREE.Matrix4();
    tiles.forEach((t, i) => {
      for (const gname of t.groups) this.index.set(gname, i);
      m.makeScale(t.w, 1, t.d).setPosition(t.x + t.w / 2, this.y, t.z + t.d / 2);
      this.mesh.setMatrixAt(i, m);
      this.attrs.aSize.array[i * 2] = t.w;
      this.attrs.aSize.array[i * 2 + 1] = t.d;
      this.write(i, countsOf(t));
    });
    this.mesh.count = tiles.length;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.ranges.markAll();
    this.flush();
  }

  /** The tile index of a group (district), or undefined. */
  tileOf(group) {
    return this.index.get(group);
  }

  /** Writes tile i's counts ({total, running, transition, crashed, pending, match}), lit 0..1. */
  write(i, c, lit = 0) {
    const f = tileFractions(c);
    this.attrs.aFrac.array.set(f, i * 4);
    const info = this.attrs.aInfo.array;
    info[i * 4] = c.total;
    info[i * 4 + 1] = c.total ? c.match / c.total : 1;
    info[i * 4 + 2] = lit;
    info[i * 4 + 3] = (i * 0.618034) % 1;
    this.ranges.mark(i);
  }

  setColors(colors, blending) {
    CLASSES.forEach((c, i) => this.uniforms.uColors.value[i].set(colors[c]));
    this.material.blending = blending;
    this.material.needsUpdate = true;
  }

  get count() {
    return this.mesh.count;
  }

  flush() {
    uploadRanges([this.attrs.aFrac, this.attrs.aInfo, this.attrs.aSize], this.ranges.take(this.mesh.count));
  }

  dispose() {
    this.parent.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.dispose();
    this.base.dispose();
    this.material.dispose();
  }
}
