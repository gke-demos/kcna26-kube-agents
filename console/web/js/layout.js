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

// Island layout: atespaces become districts sized by their agent count
// (squarified treemap), agents get a stable cell in their district's grid.
// Pure functions, no three.js, so they run under `node --test`.

/** Size of one agent cell, in world units. */
export const CELL = 1.5;
/** Padding inside a district around its grid. */
export const PAD = 0.9;
/** Strip at the back of a district for its name. */
export const LABEL_STRIP = 2.0;
/** Gap between districts. */
export const GAP = 0.8;

/**
 * Where a district's label is pinned (x, z in world units): its bottom-left
 * corner, at the front of the label strip just behind the first row. Labels
 * are sized in pixels, so zoomed out one is far deeper than the strip; pinned
 * by its bottom it grows back over the strip and the gap, not over the
 * agents (rows fill from the strip forward).
 */
export function labelAnchor(district) {
  return { x: district.x + 0.4, z: district.z + (district.strip ?? LABEL_STRIP) - 0.15 };
}

/**
 * Squarified treemap (Bruls, Huizing, van Wijk). Lays out items with a
 * positive weight inside rect so each gets area proportional to its weight
 * with aspect ratios close to 1.
 * @param {{key: string, weight: number}[]} items
 * @param {{x: number, y: number, w: number, h: number}} rect
 * @returns {{key: string, x: number, y: number, w: number, h: number}[]}
 */
export function squarify(items, rect) {
  const total = items.reduce((s, it) => s + it.weight, 0);
  if (!items.length || total <= 0) return [];
  const scale = (rect.w * rect.h) / total;
  const rest = items
    .map((it) => ({ key: it.key, area: it.weight * scale }))
    .sort((a, b) => b.area - a.area || (a.key < b.key ? -1 : 1));
  const out = [];
  let r = { ...rect };
  let row = [];

  const worst = (rowItems, side) => {
    const s = rowItems.reduce((acc, it) => acc + it.area, 0);
    let max = 0;
    for (const it of rowItems) {
      const ratio = Math.max((side * side * it.area) / (s * s), (s * s) / (side * side * it.area));
      max = Math.max(max, ratio);
    }
    return max;
  };

  const layoutRow = (rowItems) => {
    const s = rowItems.reduce((acc, it) => acc + it.area, 0);
    if (r.w >= r.h) {
      // Column on the left.
      const colW = s / r.h;
      let y = r.y;
      for (const it of rowItems) {
        const h = it.area / colW;
        out.push({ key: it.key, x: r.x, y, w: colW, h });
        y += h;
      }
      r = { x: r.x + colW, y: r.y, w: r.w - colW, h: r.h };
    } else {
      // Row on the top.
      const rowH = s / r.w;
      let x = r.x;
      for (const it of rowItems) {
        const w = it.area / rowH;
        out.push({ key: it.key, x, y: r.y, w, h: rowH });
        x += w;
      }
      r = { x: r.x, y: r.y + rowH, w: r.w, h: r.h - rowH };
    }
  };

  while (rest.length) {
    const side = Math.min(r.w, r.h);
    const next = rest[0];
    if (!row.length || worst([...row, next], side) <= worst(row, side)) {
      row.push(rest.shift());
    } else {
      layoutRow(row);
      row = [];
    }
  }
  if (row.length) layoutRow(row);
  return out;
}

/** Cells a district reserves for n agents: room to grow without re-flowing. */
export function reservedCells(n) {
  return Math.max(6, Math.ceil(n * 1.35) + 2);
}

/**
 * Plans the island for the given atespaces.
 * @param {{name: string, count: number}[]} atespaces
 * @returns {{width: number, depth: number, districts: Map<string, District>}}
 *
 * District: {name, x, z, w, d, cols, rows, capacity} with x/z the corner of
 * the district in world units (island centered on the origin).
 */
export function planIsland(atespaces) {
  const items = atespaces.map((a) => ({ key: a.name, weight: reservedCells(a.count) }));
  const totalCells = items.reduce((s, it) => s + it.weight, 0) || 6;
  // Each cell costs CELL^2; districts add padding and a label strip, which
  // matters most for small ones.
  let area = totalCells * CELL * CELL * 1.25 + atespaces.length * 22;
  const aspect = 1.6;
  for (let attempt = 0; attempt < 40; attempt++) {
    const depth = Math.sqrt(area / aspect);
    const width = depth * aspect;
    const rects = squarify(items, { x: -width / 2, y: -depth / 2, w: width, h: depth });
    const districts = new Map();
    let fits = true;
    for (const rc of rects) {
      const w = rc.w - GAP;
      const d = rc.h - GAP;
      const cols = Math.max(1, Math.floor((w - 2 * PAD) / CELL));
      const rows = Math.max(0, Math.floor((d - PAD - LABEL_STRIP) / CELL));
      const capacity = cols * rows;
      const need = atespaces.find((a) => a.name === rc.key)?.count ?? 0;
      if (capacity < Math.max(need, 1)) fits = false;
      districts.set(rc.key, { name: rc.key, kind: 'atespace', x: rc.x + GAP / 2, z: rc.y + GAP / 2, w, d, cols, rows, capacity });
    }
    if (fits) return { width, depth, districts };
    area *= 1.15;
  }
  throw new Error('island layout did not converge');
}

/**
 * World position (center of the cell floor) of a slot in a district. Slots
 * fill rows front-to-back, left-to-right, centered in the district. A
 * district may set its own label strip depth (strip).
 */
export function slotPosition(district, slot) {
  const col = slot % district.cols;
  const row = Math.floor(slot / district.cols);
  const strip = district.strip ?? LABEL_STRIP;
  const gridW = district.cols * CELL;
  const gridD = district.rows * CELL;
  const x0 = district.x + (district.w - gridW) / 2;
  const z0 = district.z + strip + (district.d - strip - gridD) / 2;
  return { x: x0 + (col + 0.5) * CELL, z: z0 + (row + 0.5) * CELL };
}

/**
 * Keeps agents in stable slots. Assign returns -1 when the district is
 * full, which means the island must be re-planned. Freed slots are reused
 * lowest first (a min-heap, so churn costs O(log n) per agent), and keyAt
 * maps a slot back to its agent (picking by grid cell).
 */
export class SlotTable {
  constructor(capacity) {
    this.capacity = capacity;
    this.byKey = new Map();
    /** @type {(string|undefined)[]} */
    this.keys = [];
    this.free = [];
    this.next = 0;
  }
  get size() {
    return this.byKey.size;
  }
  /** The agent in a slot, or undefined. */
  keyAt(slot) {
    return this.keys[slot];
  }
  assign(key) {
    if (this.byKey.has(key)) return this.byKey.get(key);
    let slot;
    if (this.free.length) {
      slot = heapPop(this.free);
    } else if (this.next < this.capacity) {
      slot = this.next++;
    } else {
      return -1;
    }
    this.byKey.set(key, slot);
    this.keys[slot] = key;
    return slot;
  }
  release(key) {
    const slot = this.byKey.get(key);
    if (slot === undefined) return;
    this.byKey.delete(key);
    this.keys[slot] = undefined;
    heapPush(this.free, slot);
  }
}

function heapPush(h, v) {
  h.push(v);
  let i = h.length - 1;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (h[p] <= v) break;
    h[i] = h[p];
    i = p;
  }
  h[i] = v;
}

function heapPop(h) {
  const top = h[0];
  const last = h.pop();
  if (h.length) {
    let i = 0;
    const n = h.length;
    for (;;) {
      const l = 2 * i + 1;
      if (l >= n) break;
      const c = l + 1 < n && h[l + 1] < h[l] ? l + 1 : l;
      if (h[c] >= last) break;
      h[i] = h[c];
      i = c;
    }
    h[i] = last;
  }
  return top;
}

/** The slot of the cell at world (x, z) in a district (inverse of slotPosition), or -1. */
export function slotAt(district, x, z) {
  const strip = district.strip ?? LABEL_STRIP;
  const gridW = district.cols * CELL;
  const gridD = district.rows * CELL;
  const x0 = district.x + (district.w - gridW) / 2;
  const z0 = district.z + strip + (district.d - strip - gridD) / 2;
  const col = Math.floor((x - x0) / CELL);
  const row = Math.floor((z - z0) / CELL);
  if (col < 0 || row < 0 || col >= district.cols || row >= district.rows) return -1;
  return row * district.cols + col;
}
