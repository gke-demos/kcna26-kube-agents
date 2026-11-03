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

// Level of detail (semantic zoom) for big clusters, as pure functions:
//   far    one aggregate tile per district (or node pool), no agent objects
//   mid    one point sprite per agent
//   close  full shapes for the agents nearest the camera, within a budget
// plus what makes it cheap: per-district aggregate counts kept
// incrementally, a uniform-grid index of district rectangles, nearest-agent
// selection without sorting 100,000 distances, and picking along a ray
// through the agent grid instead of raycasting every instance.

import { CELL } from './layout.js';

/** Cell size on screen (px) below which a district shows as its aggregate tile... */
export const FAR_LO = 2.5;
/** ...and above which it shows its agents (points); in between they crossfade. */
export const FAR_HI = 5;
/** Cell size on screen (px) from which agents may be drawn as full shapes. */
export const SHAPE_PX = 11;
/** Most agents drawn as full shapes at once (?budget= overrides). */
export const SHAPE_BUDGET = 5000;

/** Pixels one agent cell covers at view depth (world units) for a viewport height and vertical fov (degrees). */
export function cellPixels(depth, viewportH, fovDeg, cell = CELL) {
  return (cell * viewportH) / (2 * Math.tan((fovDeg * Math.PI) / 360) * Math.max(depth, 1e-3));
}

/** The view depth at which a cell covers px pixels (the inverse of cellPixels). */
export function depthForPixels(px, viewportH, fovDeg, cell = CELL) {
  return (cell * viewportH) / (2 * Math.tan((fovDeg * Math.PI) / 360) * px);
}

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** How far toward the aggregate tile a district is drawn: 1 all tile, 0 all agents. */
export function farMix(px) {
  return 1 - smoothstep(FAR_LO, FAR_HI, px);
}

/**
 * The level of detail to report for a view: 'far' when the district under
 * the view's center shows mostly as its tile, 'close' when full shapes are
 * drawn, else 'mid'.
 */
export function lodLevel(centerCellPx, shapesDrawn) {
  if (farMix(centerCellPx) > 0.5) return 'far';
  return shapesDrawn > 0 ? 'close' : 'mid';
}

// ------------------------------------------------------------ aggregates

const emptyCounts = () => ({ total: 0, running: 0, transition: 0, suspended: 0, crashed: 0, pending: 0, match: 0, teams: new Map() });

/**
 * Agents per group (district) and visual class, kept as agents come, go,
 * change class or move between groups, so district labels and far tiles
 * never rescan every agent. match counts agents that pass the filter;
 * teams counts atespaces (for worker platforms' "runs" chips).
 */
export class Aggregates {
  constructor() {
    /** @type {Map<string, ReturnType<typeof emptyCounts>>} */
    this.groups = new Map();
    this.version = 0;
  }

  /** The counts of a group (zeros when it has no agents). */
  get(group) {
    return this.groups.get(group) || emptyCounts();
  }

  add(group, cls, match, team) {
    let c = this.groups.get(group);
    if (!c) {
      c = emptyCounts();
      this.groups.set(group, c);
    }
    c.total++;
    c[cls]++;
    if (match) c.match++;
    if (team !== undefined) c.teams.set(team, (c.teams.get(team) || 0) + 1);
    this.version++;
  }

  remove(group, cls, match, team) {
    const c = this.groups.get(group);
    if (!c) return;
    c.total--;
    c[cls]--;
    if (match) c.match--;
    if (team !== undefined) {
      const n = (c.teams.get(team) || 0) - 1;
      if (n > 0) c.teams.set(team, n);
      else c.teams.delete(team);
    }
    if (c.total <= 0) this.groups.delete(group);
    this.version++;
  }

  clear() {
    this.groups.clear();
    this.version++;
  }

  /** Sums groups (a node pool's workers, for its far tile). */
  sum(groups) {
    const out = emptyCounts();
    for (const g of groups) {
      const c = this.groups.get(g);
      if (!c) continue;
      for (const k of ['total', 'running', 'transition', 'suspended', 'crashed', 'pending', 'match']) out[k] += c[k];
    }
    return out;
  }
}

// ------------------------------------------------------------ rect index

/**
 * A uniform grid over rectangles ({x, z, w, d}, corner and size), for
 * "which district is at this point" with thousands of districts.
 */
export class RectIndex {
  constructor(rects) {
    this.rects = rects;
    let x0 = Infinity;
    let z0 = Infinity;
    let x1 = -Infinity;
    let z1 = -Infinity;
    let area = 0;
    for (const r of rects) {
      x0 = Math.min(x0, r.x);
      z0 = Math.min(z0, r.z);
      x1 = Math.max(x1, r.x + r.w);
      z1 = Math.max(z1, r.z + r.d);
      area += r.w * r.d;
    }
    if (!rects.length) {
      x0 = z0 = 0;
      x1 = z1 = 1;
    }
    this.cell = Math.max(1, Math.sqrt(area / Math.max(1, rects.length)));
    this.x0 = x0;
    this.z0 = z0;
    this.cols = Math.max(1, Math.ceil((x1 - x0) / this.cell));
    this.rows = Math.max(1, Math.ceil((z1 - z0) / this.cell));
    this.bins = new Map();
    rects.forEach((r, i) => {
      const c0 = this.col(r.x);
      const c1 = this.col(r.x + r.w);
      const r0 = this.row(r.z);
      const r1 = this.row(r.z + r.d);
      for (let row = r0; row <= r1; row++) {
        for (let col = c0; col <= c1; col++) {
          const k = row * this.cols + col;
          let b = this.bins.get(k);
          if (!b) this.bins.set(k, (b = []));
          b.push(i);
        }
      }
    });
  }

  col(x) {
    return Math.min(this.cols - 1, Math.max(0, Math.floor((x - this.x0) / this.cell)));
  }

  row(z) {
    return Math.min(this.rows - 1, Math.max(0, Math.floor((z - this.z0) / this.cell)));
  }

  /** The rectangle containing (x, z), or null. */
  at(x, z) {
    const b = this.bins.get(this.row(z) * this.cols + this.col(x));
    if (!b) return null;
    for (const i of b) {
      const r = this.rects[i];
      if (x >= r.x && x < r.x + r.w && z >= r.z && z < r.z + r.d) return r;
    }
    return null;
  }
}

// -------------------------------------------------------- nearest agents

/** k-th smallest value of a[0..n) (partially reorders a and idx together). */
function quickselect(a, idx, n, k) {
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const pivot = a[(lo + hi) >> 1];
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (a[i] < pivot) i++;
      while (a[j] > pivot) j--;
      if (i <= j) {
        const t = a[i];
        a[i] = a[j];
        a[j] = t;
        const u = idx[i];
        idx[i] = idx[j];
        idx[j] = u;
        i++;
        j--;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else break;
  }
  return a[k];
}

/**
 * The agents to draw as full shapes: the nearest `budget` live points within
 * maxR of the camera (and inside the frustum planes, when given), and the
 * radius that set reaches. Linear in the number of points, no sort.
 *
 * @param {Float32Array} pos xyz per point
 * @param {Uint8Array} live 1 for points in use
 * @param {number} n points to consider
 * @param {{x: number, y: number, z: number}} cam
 * @param {number} budget
 * @param {number} maxR
 * @param {{x: number, y: number, z: number, c: number}[]} [planes] frustum planes (inside: dot + c >= -margin)
 * @param {number} [margin]
 * @param {Int32Array|number[]|null} [subset] only consider these points (e.g. the districts within reach)
 * @returns {{idx: Int32Array, radius: number}}
 */
export function selectNearest(pos, live, n, cam, budget, maxR, planes = null, margin = 2, subset = null) {
  const max2 = maxR * maxR;
  const count = subset ? subset.length : n;
  const d2 = new Float32Array(count);
  const idx = new Int32Array(count);
  let m = 0;
  for (let j = 0; j < count; j++) {
    const i = subset ? subset[j] : j;
    if (i >= n || !live[i]) continue;
    const x = pos[i * 3];
    const y = pos[i * 3 + 1];
    const z = pos[i * 3 + 2];
    const dx = x - cam.x;
    const dy = y - cam.y;
    const dz = z - cam.z;
    const d = dx * dx + dy * dy + dz * dz;
    if (d > max2) continue;
    if (planes) {
      let inside = true;
      for (const p of planes) {
        if (p.x * x + p.y * y + p.z * z + p.c < -margin) {
          inside = false;
          break;
        }
      }
      if (!inside) continue;
    }
    d2[m] = d;
    idx[m] = i;
    m++;
  }
  if (m <= budget) return { idx: idx.slice(0, m), radius: maxR };
  const kth = quickselect(d2, idx, m, budget - 1);
  // quickselect leaves the budget smallest in [0, budget).
  return { idx: idx.slice(0, budget), radius: Math.sqrt(kth) };
}

// ---------------------------------------------------------------- picking

/**
 * Picks along a ray through the agent grid: walks the ray across the slab
 * where agents stand (y0..y1), asks lookup(x, z) for the agent whose cell is
 * there, and tests each candidate's body (a vertical capsule) against the
 * ray. Returns the nearest hit's key, or null. Cost is a few dozen lookups,
 * whatever the number of agents.
 *
 * @param {{x: number, y: number, z: number}} o ray origin
 * @param {{x: number, y: number, z: number}} d ray direction (normalized)
 * @param {{lookup: (x: number, z: number) => (string|null), body: (key: string) => ({x: number, z: number, y0: number, y1: number, r: number}|null), y0?: number, y1?: number, step?: number, maxSamples?: number}} opts
 */
export function pickRay(o, d, { lookup, body, y0 = 0.1, y1 = 2.2, step = 0.35, maxSamples = 160 }) {
  if (d.y > -1e-4) return null;
  const tTop = Math.max(0, (y1 - o.y) / d.y);
  const tBot = (y0 - o.y) / d.y;
  if (tBot <= 0) return null;
  const horiz = Math.hypot(d.x, d.z);
  const len = (tBot - tTop) * horiz;
  const samples = Math.min(maxSamples, Math.max(2, Math.ceil(len / step) + 1));
  const seen = new Set();
  for (let s = 0; s < samples; s++) {
    const t = tTop + ((tBot - tTop) * s) / (samples - 1);
    const key = lookup(o.x + d.x * t, o.z + d.z * t);
    if (key) seen.add(key);
  }
  let best = null;
  let bestT = Infinity;
  const h2 = d.x * d.x + d.z * d.z;
  for (const key of seen) {
    const b = body(key);
    if (!b) continue;
    // Closest approach in the ground plane, then check the height there.
    const t = h2 > 1e-9 ? ((b.x - o.x) * d.x + (b.z - o.z) * d.z) / h2 : (b.y1 - o.y) / d.y;
    const px = o.x + d.x * t - b.x;
    const pz = o.z + d.z * t - b.z;
    const y = o.y + d.y * t;
    const dist = Math.hypot(px, pz);
    if (dist > b.r || y < b.y0 - b.r * 0.5 || y > b.y1 + b.r * 0.5) continue;
    // Enter the capsule a little before its axis: nearer bodies win.
    const enter = t - Math.sqrt(Math.max(0, b.r * b.r - dist * dist)) / Math.max(Math.sqrt(h2), 1e-3);
    if (enter < bestT) {
      bestT = enter;
      best = key;
    }
  }
  return best;
}
