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

// Agents and the workers they run on: the "group by worker" layout, the
// highlight rules (which agents light up when a worker or agent is in focus),
// worker usage (actor slots, CPU, memory) and atespace tints. Pure functions,
// no three.js or DOM, so they run under `node --test`.

import { CELL, PAD, GAP, LABEL_STRIP } from './layout.js';

/** Ways to group agents into districts. */
export const GROUPS = ['atespace', 'worker'];

/** The district key for agents without a worker in worker view. */
export const PARKED = '\u0000parked';

/** Label strip of a worker platform: room for its label and its pad. */
export const WORKER_STRIP = 2.8;

/** Smallest number of cell columns on a worker platform (fits label and pad). */
export const MIN_WORKER_COLS = 6;

/** A valid group mode ('atespace' unless it is a known one). */
export function groupId(mode) {
  return GROUPS.includes(mode) ? mode : 'atespace';
}

/** The district an agent belongs to in a group mode. */
export function groupOf(agent, mode) {
  if (mode === 'worker') return agent.worker || PARKED;
  return agent.atespace;
}

/**
 * Agents per district for a group mode. Atespace mode includes empty
 * atespaces; worker mode includes every known worker (idle ones too) and the
 * parked area, plus workers that agents name but the worker list lacks.
 * @param {{agents: Map, atespaces: Map, workers: Map}} model
 * @param {string} mode
 * @returns {Map<string, number>}
 */
export function groupCounts(model, mode) {
  const m = new Map();
  if (mode === 'worker') {
    for (const name of model.workers.keys()) m.set(name, 0);
    m.set(PARKED, 0);
  } else {
    for (const name of model.atespaces.keys()) m.set(name, 0);
  }
  for (const a of model.agents.values()) {
    const g = groupOf(a, mode);
    m.set(g, (m.get(g) || 0) + 1);
  }
  return m;
}

/** Smallest number of cells on a worker platform. */
export const MIN_WORKER_CELLS = 6;

/**
 * Cells a worker platform needs for the agents assigned to it, with
 * headroom so a few more can land without re-planning. Never the worker's
 * actor capacity: real workers report capacities like 1000, which would make
 * every platform huge and its agents specks. Capacity is a label and a bar.
 */
export function workerCells(count) {
  return Math.max(MIN_WORKER_CELLS, Math.ceil(count * 1.35) + 2);
}

/** Cells the parked area reserves for n agents without a worker (plus spare). */
export function parkedCells(n) {
  return Math.max(6, Math.ceil(n * 1.08) + 4);
}

/** Margin of a node's frame around its workers. */
export const NODE_PAD = 0.45;
/** Margin of a node pool's frame, and the strip at its back for its label. */
export const POOL_PAD = 1.0;
export const POOL_STRIP = 2.6;

const natural = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true });

/**
 * Packs boxes ({w, d}) left to right into rows no wider than maxW (a box
 * wider than maxW gets a row of its own), each row centered in the widest.
 * Returns each box's corner relative to (0, 0) and the bounds.
 */
export function shelfPack(boxes, maxW, gap) {
  const pos = [];
  const rows = [];
  let x = 0;
  let z = 0;
  let rowD = 0;
  let row = [];
  const close = () => {
    if (row.length) rows.push({ items: row, w: x - gap });
  };
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    if (row.length && x + b.w > maxW + 1e-9) {
      close();
      z += rowD + gap;
      x = 0;
      rowD = 0;
      row = [];
    }
    pos[i] = { x, z };
    row.push(i);
    x += b.w + gap;
    rowD = Math.max(rowD, b.d);
  }
  close();
  const width = Math.max(0, ...rows.map((r) => r.w));
  for (const r of rows) for (const i of r.items) pos[i].x += (width - r.w) / 2;
  return { pos, width, depth: boxes.length ? z + rowD : 0 };
}

/**
 * Plans the worker view: one platform per worker at the front, grouped by
 * node pool (a framed block with the pool's name) and, inside a pool, by
 * node (a frame around the node's workers), and a parked area behind them
 * for agents without a worker (suspended, pending). Platforms share one
 * width and base depth (sized for the 90th-percentile worker's agents, with
 * headroom) so their fill compares at a glance; a busier worker's platform
 * gets extra rows. The parked area is shaped to hold its agents comfortably
 * (roughly 1.6 times as wide as deep, never a thin strip), and the whole
 * thing stays roughly landscape. With one pool there is no pool frame; with
 * one worker per node (or one node per pool) no node frames (a plain grid
 * of platforms).
 *
 * @param {{name: string, count: number, capacity?: number, pool?: string, node?: string}[]} workers
 * @param {number} parked agents without a worker
 * @returns {{width: number, depth: number, districts: Map<string, object>, frames: object[], tiles: object[]}}
 *
 * A worker district has kind 'worker', its own label strip (strip), a slot
 * grid (cols x rows, capacity) and shown: the cells to draw as room (all of
 * them, or fewer when the worker's actor capacity is smaller), and its pool
 * and node. The parked district has kind 'parked'. frames are the pool and
 * node frames ({kind, name, x, z, w, d, workers}); tiles are what the far
 * level of detail draws ({name, x, z, w, d, groups}: the parked area and
 * each pool, or each worker when there is one pool).
 */
export function planWorkerView(workers, parked) {
  const list = [...workers].sort((a, b) => natural(a.name, b.name));
  // Platforms share a width and a base depth sized for the 90th-percentile
  // worker, so one busy (or draining) worker doesn't blow every platform
  // up; a worker that needs more gets extra rows.
  const needs = list.map((w) => workerCells(w.count)).sort((a, b) => a - b);
  const need = Math.max(1, needs.length ? needs[Math.min(needs.length - 1, Math.floor(needs.length * 0.9))] : 1);
  const cols = Math.max(MIN_WORKER_COLS, Math.ceil(Math.sqrt(need * 1.4)));
  const rows = Math.max(1, Math.ceil(need / cols));
  const rowsOf = (w) => Math.max(rows, Math.ceil(workerCells(w.count) / cols));
  const depthOf = (w) => rowsOf(w) * CELL + PAD + WORKER_STRIP;
  const pw = cols * CELL + 2 * PAD;
  const pd = rows * CELL + PAD + WORKER_STRIP;
  const slotW = pw + GAP;
  const slotD = pd + GAP;

  // Pools -> nodes -> workers, in natural order.
  const pools = new Map();
  for (const w of list) {
    const pool = w.pool || '';
    const node = w.node || '';
    if (!pools.has(pool)) pools.set(pool, new Map());
    const nodes = pools.get(pool);
    if (!nodes.has(node)) nodes.set(node, []);
    nodes.get(node).push(w);
  }
  const poolNames = [...pools.keys()].sort(natural);
  const multiPool = poolNames.length > 1;

  const pCells = parkedCells(parked);
  const parkedArea = pCells * CELL * CELL * 1.1;
  const zoneArea = list.length * slotW * slotD * (multiPool ? 1.25 : 1);
  const target = Math.max(pw, Math.sqrt((zoneArea + parkedArea) * 1.6));

  // Each pool: its nodes packed into rows, framed when there are several.
  const poolBoxes = poolNames.map((pool) => {
    const nodes = pools.get(pool);
    const nodeNames = [...nodes.keys()].sort(natural);
    // Node frames only help when nodes hold several workers.
    const framed = nodeNames.length > 1 && nodeNames.some((n) => nodes.get(n).length > 1);
    const np = framed ? NODE_PAD : 0;
    const count = nodeNames.reduce((a, n) => a + nodes.get(n).length, 0);
    const pt = multiPool ? Math.min(target, Math.max(slotW * 2, Math.sqrt(count * slotW * slotD * 1.2 * 1.6))) : target;
    const perRow = Math.max(1, Math.floor((pt + GAP - 2 * np) / slotW));
    const nodeBoxes = nodeNames.map((n) => {
      const ws = nodes.get(n);
      const k = Math.min(ws.length, perRow);
      // Rows of k workers; each row as deep as its deepest platform.
      const rowZ = [];
      let z = 0;
      for (let r = 0; r * k < ws.length; r++) {
        rowZ.push(z);
        z += Math.max(...ws.slice(r * k, r * k + k).map(depthOf)) + GAP;
      }
      return { name: n, workers: ws, k, rowZ, w: k * slotW - GAP + 2 * np, d: z - GAP + 2 * np };
    });
    const packed = shelfPack(nodeBoxes, pt, framed ? GAP * 1.5 : GAP);
    const ox = multiPool ? POOL_PAD : 0;
    const oz = multiPool ? POOL_STRIP : 0;
    return { name: pool, nodeBoxes, packed, framed, np, ox, oz, w: packed.width + 2 * ox, d: packed.depth + oz + (multiPool ? POOL_PAD : 0) };
  });
  const zone = shelfPack(poolBoxes, Math.max(target, ...poolBoxes.map((b) => b.w)), GAP * 3);
  const zoneW = zone.width;
  const zoneD = zone.depth;

  // The parked area keeps its own landscape shape: as wide as it needs to
  // be about 1.6:1, at least 12, at most the wider of the platform zone and
  // the island's target width. Its grid gets a spare row.
  const parkedW = Math.min(Math.max(12, Math.sqrt(parkedArea * 1.6)), Math.max(12, zoneW, target));
  const parkedCols = Math.max(1, Math.floor((parkedW - 2 * PAD) / CELL));
  const parkedRows = Math.max(1, Math.ceil(pCells / parkedCols));
  const parkedD = parkedRows * CELL + PAD + LABEL_STRIP;

  const width = Math.max(zoneW, parkedW);
  const depth = parkedD + (zoneD ? zoneD + 2 * GAP : 0);
  const districts = new Map();
  const frames = [];
  const z0 = -depth / 2;
  const parkedD0 = {
    name: PARKED,
    kind: 'parked',
    x: -parkedW / 2,
    z: z0,
    w: parkedW,
    d: parkedD,
    cols: parkedCols,
    rows: parkedRows,
    capacity: parkedCols * parkedRows,
  };
  districts.set(PARKED, parkedD0);
  const zz = z0 + parkedD + 2 * GAP;
  poolBoxes.forEach((pb, pi) => {
    const px = -zoneW / 2 + zone.pos[pi].x;
    const pz = zz + zone.pos[pi].z;
    const poolWorkers = [];
    pb.nodeBoxes.forEach((nb, ni) => {
      const nx = px + pb.ox + pb.packed.pos[ni].x;
      const nz = pz + pb.oz + pb.packed.pos[ni].z;
      nb.workers.forEach((wk, i) => {
        const x = nx + pb.np + (i % nb.k) * slotW;
        const z = nz + pb.np + nb.rowZ[Math.floor(i / nb.k)];
        const wr = rowsOf(wk);
        poolWorkers.push(wk.name);
        districts.set(wk.name, {
          name: wk.name,
          kind: 'worker',
          pool: pb.name,
          node: nb.name,
          x,
          z,
          w: pw,
          d: depthOf(wk),
          cols,
          rows: wr,
          strip: WORKER_STRIP,
          capacity: cols * wr,
          shown: wk.capacity > 0 ? Math.min(cols * wr, Math.max(wk.capacity, wk.count)) : cols * wr,
        });
      });
      if (pb.framed) frames.push({ kind: 'node', name: nb.name, pool: pb.name, x: nx, z: nz, w: nb.w, d: nb.d, workers: nb.workers.map((w) => w.name) });
    });
    if (multiPool) frames.push({ kind: 'pool', name: pb.name, x: px, z: pz, w: pb.w, d: pb.d, strip: POOL_STRIP, workers: poolWorkers });
  });
  const rect = (d) => ({ name: d.name, x: d.x, z: d.z, w: d.w, d: d.d });
  const tiles = [{ ...rect(parkedD0), kind: 'parked', groups: [PARKED] }];
  if (multiPool) for (const f of frames) if (f.kind === 'pool') tiles.push({ ...rect(f), kind: 'pool', groups: f.workers });
  if (!multiPool) for (const d of districts.values()) if (d.kind === 'worker') tiles.push({ ...rect(d), kind: 'worker', groups: [d.name] });
  return { width, depth, districts, frames, tiles };
}

/** Spacing of worker pads in the atespace view's pad area, and between its rows. */
export const PAD_SPACING = 4.2;
export const PAD_ROW = 3;

/**
 * Plans the atespace view's worker pads along the island's front edge, for
 * an island width. One pool: rows of pads, centered. Several: one framed
 * block per node pool (pads in node order), packed into rows. Pad
 * positions are relative to the first row's center line (x centered on 0);
 * depth is how much of the island the area takes.
 * @param {{name: string, pod?: string, pool?: string, node?: string}[]} workers
 * @param {number} width
 * @returns {{items: {name: string, x: number, z: number}[], frames: object[], depth: number}}
 */
export function planPadArea(workers, width) {
  const sorted = [...workers].sort((a, b) => natural(a.pod || a.name, b.pod || b.name));
  const pools = new Map();
  for (const w of sorted) {
    const p = w.pool || '';
    if (!pools.has(p)) pools.set(p, []);
    pools.get(p).push(w);
  }
  const items = [];
  const frames = [];
  if (pools.size <= 1) {
    const perRow = Math.max(1, Math.floor((width + 4) / PAD_SPACING));
    sorted.forEach((wk, i) => {
      const row = Math.floor(i / perRow);
      const col = i % perRow;
      const inRow = Math.min(perRow, sorted.length - row * perRow);
      items.push({ name: wk.name, x: -((inRow - 1) * PAD_SPACING) / 2 + col * PAD_SPACING, z: row * PAD_ROW });
    });
    const rows = Math.ceil(sorted.length / perRow);
    return { items, frames, depth: Math.max(1, rows) * PAD_ROW };
  }
  const strip = 2.2;
  const blocks = [...pools.keys()].sort(natural).map((name) => {
    const ws = pools.get(name).sort((a, b) => natural(a.node || '', b.node || '') || natural(a.pod || a.name, b.pod || b.name));
    const cols = Math.max(4, Math.ceil(Math.sqrt(ws.length * 2.2)));
    const rows = Math.ceil(ws.length / cols);
    return { name, ws, cols, w: cols * PAD_SPACING + 1.2, d: rows * PAD_ROW + strip + 0.4 };
  });
  const packed = shelfPack(blocks, Math.max(width, ...blocks.map((b) => b.w)), 1.6);
  const top = -1.6;
  blocks.forEach((b, i) => {
    const bx = -packed.width / 2 + packed.pos[i].x;
    const bz = top + packed.pos[i].z;
    frames.push({ kind: 'pool', name: b.name, x: bx, z: bz, w: b.w, d: b.d, strip, workers: b.ws.map((w) => w.name) });
    b.ws.forEach((wk, j) => {
      items.push({ name: wk.name, x: bx + 0.6 + ((j % b.cols) + 0.5) * PAD_SPACING, z: bz + strip + 1.1 + Math.floor(j / b.cols) * PAD_ROW });
    });
  });
  return { items, frames, depth: packed.depth };
}

// --------------------------------------------------------------- highlight

/**
 * The worker in focus, from what the user points at. A hovered or pinned
 * worker pad is a strong focus: its agents light up and the rest dim. A
 * hovered or selected agent on a worker is a soft focus: its worker pad
 * lights up and its siblings get a subtle highlight; nothing dims.
 *
 * @param {{hoverWorker?: string, pinnedWorker?: string, hoverAgent?: string, selectedAgent?: string}} state
 * @param {(key: string) => string|undefined} workerOf an agent's worker
 * @returns {{worker: string|null, strong: boolean}}
 */
export function focusOf(state, workerOf) {
  const strong = state.hoverWorker || state.pinnedWorker;
  if (strong) return { worker: strong, strong: true };
  for (const key of [state.hoverAgent, state.selectedAgent]) {
    const w = key ? workerOf(key) : null;
    if (w) return { worker: w, strong: false };
  }
  return { worker: null, strong: false };
}

/** Highlight levels: 2 lit, 1 sibling, 0 normal, -1 dimmed. */
export const HI = { LIT: 2, SIBLING: 1, NONE: 0, DIM: -1 };

/** An agent's (or its link's) highlight level under a focus. */
export function levelOf(focus, agentWorker) {
  if (!focus.worker) return HI.NONE;
  if (agentWorker && agentWorker === focus.worker) return focus.strong ? HI.LIT : HI.SIBLING;
  return focus.strong ? HI.DIM : HI.NONE;
}

/** True when two foci light up the same things. */
export function sameFocus(a, b) {
  return a.worker === b.worker && a.strong === b.strong;
}

// ------------------------------------------------------------------- usage

const SUFFIX = {
  n: 1e-9, u: 1e-6, m: 1e-3, '': 1, k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18,
  Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, Ei: 2 ** 60,
};

/** Parses a Kubernetes quantity ("500m", "4", "16Gi", "1.5e3") to a number; NaN if it isn't one. */
export function parseQuantity(s) {
  if (s === undefined || s === null || s === '') return NaN;
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+))(?:[eE]([+-]?\d+))?([a-zA-Z]*)$/.exec(String(s).trim());
  if (!m || !(m[3] in SUFFIX)) return NaN;
  return parseFloat(m[1]) * 10 ** Number(m[2] || 0) * SUFFIX[m[3]];
}

const trim = (v) => String(Number(v.toFixed(v >= 10 ? 0 : 1)));

/** CPU cores for people: "750m", "3.5", "16". */
export function formatCPU(cores) {
  if (!Number.isFinite(cores)) return '';
  if (cores > 0 && cores < 1) return `${Math.round(cores * 1000)}m`;
  return trim(cores);
}

/** Bytes for people: "512 MiB", "12 GiB". */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${trim(v)} ${units[i]}`;
}

/**
 * A worker's usage: actor slots (used = agents the scene shows on it, cap =
 * its capacity, 0 when unknown), and CPU and memory. A resource is null when
 * the worker reports neither capacity nor allocation; {reported: false, cap}
 * when it reports capacity but no allocation (real Substrate today: ax tasks
 * declare no resource limits, so nothing is allocated even while the worker
 * hosts agents); else {used, cap, frac} with frac = used/cap.
 */
export function workerUsage(worker, hosted) {
  const res = (used, cap) => {
    const u = parseQuantity(used);
    const c = parseQuantity(cap);
    const hasCap = Number.isFinite(c) && c > 0;
    // Nothing allocated while it hosts agents means "not declared", not idle.
    const hasUse = Number.isFinite(u) && (u > 0 || hosted === 0);
    if (!hasCap && !hasUse) return null;
    if (!hasCap || !hasUse) return { reported: false, cap: hasCap ? c : NaN };
    return { reported: true, used: u, cap: c, frac: u / c };
  };
  const cap = worker?.capacityActors || 0;
  return {
    actors: { used: hosted, cap, frac: cap > 0 ? hosted / cap : 0 },
    cpu: res(worker?.allocatedCpu, worker?.capacityCpu),
    memory: res(worker?.allocatedMemory, worker?.capacityMemory),
  };
}

// ------------------------------------------------------------------- teams

/**
 * Hue (0..1) of each atespace's tint in worker view: spread by the golden
 * ratio over the sorted names, so neighbours in the list differ and the same
 * set of atespaces always gets the same tints.
 */
export function teamHues(names) {
  const out = new Map();
  [...names].sort().forEach((n, i) => out.set(n, (0.08 + i * 0.618034) % 1));
  return out;
}

/** CSS color of a tint (for label chips that match the floor tiles). */
export function teamCSS(hue, theme) {
  const t = theme.team;
  return `hsl(${Math.round(hue * 360)} ${Math.round(t.saturation * 100)}% ${Math.round(t.lightness * 100)}%)`;
}

/** The atespaces with the most agents on a worker: [{name, count}], biggest first. */
export function topTeams(agents, n = 3) {
  const m = new Map();
  for (const a of agents) m.set(a.atespace, (m.get(a.atespace) || 0) + 1);
  return [...m.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1))
    .slice(0, n);
}
