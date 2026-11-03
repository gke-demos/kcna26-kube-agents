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

// The "two decks" layout as pure functions: agents on a glassy top deck
// (atespace districts, every agent), workers on a separate deck below
// (node pool -> node -> worker pads), thin beams from each agent that holds
// a worker down to its pad, and, zoomed out, flow ribbons from each
// atespace tile to each node-pool tile sized by the running agents on that
// pair. No three.js or DOM, so it runs under `node --test`.

import { planPadArea, levelOf, HI, PAD_SPACING, PAD_ROW } from './workers.js';

/** Layouts: two decks (default), or the original single island. */
export const LAYOUTS = ['decks', 'combined'];
export const DEFAULT_LAYOUT = 'decks';

/** A valid layout id (the default unless it is a known one). */
export function layoutId(id) {
  return LAYOUTS.includes(id) ? id : DEFAULT_LAYOUT;
}

/** Deck views: both decks, or one with the other faded out (keys 3, 1, 2). */
export const DECK_VIEWS = ['both', 'agents', 'workers'];
export const DECK_KEYS = { 1: 'agents', 2: 'workers', 3: 'both' };

/** A valid deck view. */
export function deckViewId(v) {
  return DECK_VIEWS.includes(v) ? v : 'both';
}

/** How opaque each deck is in a view: {agents, workers}, 0..1. */
export function deckAlphas(view) {
  const v = deckViewId(view);
  return { agents: v === 'workers' ? 0 : 1, workers: v === 'agents' ? 0 : 1 };
}

/** Pad footprint (matches pads.js) and the margin of the worker deck's slab. */
const PAD_W = 3.2;
const PAD_D = 1.8;
export const DECK_MARGIN = 3.5;
/** Room at the deck's front edge for its name. */
export const DECK_FRONT = 3;

/**
 * The vertical gap between the decks: enough that the worker deck reads as
 * its own object under a camera that sees both, growing with the decks.
 * @param {{depth: number}} agentDeck
 * @param {{depth: number}} workerDeck
 */
export function deckGap(agentDeck, workerDeck) {
  return Math.min(420, Math.max(16, 0.3 * Math.max(agentDeck.depth, workerDeck.depth) + 10));
}

/**
 * Plans the worker deck under an agent deck: the pads grouped by node pool
 * (a framed block per pool when there are several, nodes in order inside),
 * shaped roughly 1.7:1 whatever the number of workers, a gap below the
 * agent deck, centered under it left to right and with the front edges
 * lined up, so a camera in front sees the worker deck below the agent
 * deck instead of hidden under its middle.
 *
 * @param {{name: string, pod?: string, pool?: string, node?: string}[]} workers
 * @param {{cx: number, cz: number, width: number, depth: number}} agentDeck
 * @returns {{items: {name: string, x: number, z: number}[], frames: object[], tiles: object[],
 *   poolOf: Map<string, string>, width: number, depth: number, cx: number, cz: number, y: number, gap: number}}
 *   items: pad centers (deck-local x/z are world x/z; y is the deck's);
 *   frames: pool frames ({kind: 'pool', name, x, z, w, d, strip, workers});
 *   tiles: the far tiles, one per pool ({name, kind: 'pool', x, z, w, d, groups: worker names});
 *   poolOf: worker -> its tile's name (the ribbons' lower end).
 */
export function planWorkerDeck(workers, agentDeck) {
  const pools = new Set(workers.map((w) => w.pool || ''));
  const multi = pools.size > 1;
  const area = Math.max(1, workers.length) * PAD_SPACING * PAD_ROW * (multi ? 1.5 : 1);
  const target = Math.max(22, Math.sqrt(area * 1.7));
  const pa = planPadArea(workers, target);
  // Bounds of the pads (with room for their compact labels) and the frames.
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const it of pa.items) {
    x0 = Math.min(x0, it.x - PAD_W / 2);
    x1 = Math.max(x1, it.x + PAD_W / 2);
    z0 = Math.min(z0, it.z - PAD_D / 2);
    z1 = Math.max(z1, it.z + PAD_D / 2 + 0.9);
  }
  for (const f of pa.frames) {
    x0 = Math.min(x0, f.x);
    x1 = Math.max(x1, f.x + f.w);
    z0 = Math.min(z0, f.z);
    z1 = Math.max(z1, f.z + f.d);
  }
  if (!Number.isFinite(x0)) {
    x0 = -8;
    x1 = 8;
    z0 = -4;
    z1 = 4;
  }
  const width = x1 - x0 + 2 * DECK_MARGIN;
  const depth = z1 - z0 + 2 * DECK_MARGIN + DECK_FRONT;
  const cx = agentDeck.cx;
  const cz = agentDeck.cz + (agentDeck.depth - depth) / 2;
  // Shift so the slab (pads, margins and the front strip) sits at (cx, cz).
  const dx = cx - (x0 + x1) / 2;
  const dz = cz - (z0 + z1 + DECK_FRONT) / 2;
  const items = pa.items.map((it) => ({ name: it.name, x: it.x + dx, z: it.z + dz }));
  const frames = pa.frames.map((f) => ({ ...f, x: f.x + dx, z: f.z + dz }));
  const poolOf = new Map();
  let tiles;
  if (multi) {
    tiles = frames.map((f) => ({ name: f.name, kind: 'pool', x: f.x, z: f.z, w: f.w, d: f.d, groups: f.workers }));
    for (const f of frames) for (const w of f.workers) poolOf.set(w, f.name);
  } else {
    const name = [...pools][0] || 'workers';
    tiles = [{ name, kind: 'pool', x: x0 + dx, z: z0 + dz, w: x1 - x0, d: z1 - z0, groups: items.map((it) => it.name) }];
    for (const it of items) poolOf.set(it.name, name);
  }
  const deck = { items, frames, tiles, poolOf, width, depth, cx, cz };
  deck.gap = deckGap(agentDeck, deck);
  deck.y = -deck.gap;
  return deck;
}

// ------------------------------------------------------------------ flows

const SEP = '\u0000';

/** The key of an atespace -> pool pair. */
export function pairKey(atespace, pool) {
  return `${atespace}${SEP}${pool}`;
}

/**
 * Agents holding a worker, per (atespace, node pool) pair: what the flow
 * ribbons draw. Kept incrementally as agents get or lose a worker; pairs
 * that drop to zero stay (count 0, drawn as nothing) until clear(), so
 * churn doesn't reshuffle the ribbons. dirty collects the pairs changed
 * since the last take().
 */
export class FlowCounts {
  constructor() {
    /** @type {Map<string, {key: string, atespace: string, pool: string, count: number}>} */
    this.pairs = new Map();
    this.dirty = new Set();
    this.total = 0;
  }

  add(atespace, pool, n = 1) {
    if (pool === undefined || pool === null) return;
    const key = pairKey(atespace, pool);
    let p = this.pairs.get(key);
    if (!p) {
      p = { key, atespace, pool, count: 0 };
      this.pairs.set(key, p);
    }
    p.count = Math.max(0, p.count + n);
    this.total = Math.max(0, this.total + n);
    this.dirty.add(key);
  }

  get(atespace, pool) {
    return this.pairs.get(pairKey(atespace, pool))?.count || 0;
  }

  /** The biggest pair (ribbon widths scale against it). */
  max() {
    let m = 0;
    for (const p of this.pairs.values()) m = Math.max(m, p.count);
    return m;
  }

  /** Pairs with agents (count > 0). */
  live() {
    return [...this.pairs.values()].filter((p) => p.count > 0);
  }

  /** The dirty pair keys, cleared. */
  take() {
    const out = [...this.dirty];
    this.dirty.clear();
    return out;
  }

  clear() {
    this.pairs.clear();
    this.dirty.clear();
    this.total = 0;
  }
}

/**
 * Ribbon width (world units) and strength (0..1, drives alpha) for a pair
 * of count agents when the biggest pair has max: area-true (square root),
 * never thinner than a hairline. widthMax: the widest ribbon.
 */
export function ribbonSize(count, max, widthMax) {
  if (count <= 0 || max <= 0) return { width: 0, strength: 0 };
  const s = Math.sqrt(count / max);
  return { width: Math.max(widthMax * 0.08, widthMax * s), strength: 0.25 + 0.75 * s };
}

// -------------------------------------------------------------- highlight

/**
 * A beam's highlight level (workers.js HI, plus 3 for the agent itself):
 * the selected or hovered agent's own beam is brightest; a hovered or
 * pinned worker lights its agents' beams and dims the rest; an agent in
 * focus gives its siblings on the same worker a subtle lift.
 */
export function beamLevel(focus, agentWorker, own) {
  if (own) return 3;
  return levelOf(focus, agentWorker);
}

/**
 * A ribbon's highlight level for a hovered tile ({kind: 'atespace'|'pool',
 * name}) and the worker in focus's pool: a ribbon touching the hovered tile
 * is lit and the others dim; without a hovered tile, a strongly focused
 * worker's pool lights its ribbons softly (dimOthers: and dims the rest).
 */
export function ribbonLevel(pair, tile, focusPool = null, strong = false, dimOthers = false) {
  if (tile) {
    const hit = tile.kind === 'atespace' ? pair.atespace === tile.name : pair.pool === tile.name;
    return hit ? HI.LIT : HI.DIM;
  }
  // Focus beams: a pinned or hovered worker's beams are the story; the
  // other ribbons step back.
  if (focusPool && strong) return pair.pool === focusPool ? HI.SIBLING : dimOthers ? HI.DIM : HI.NONE;
  return HI.NONE;
}

/**
 * The tiles a hovered tile lights: itself and every tile at the other end
 * of one of its ribbons that carries agents.
 * @returns {{atespaces: Set<string>, pools: Set<string>}}
 */
export function litTiles(flows, tile) {
  const out = { atespaces: new Set(), pools: new Set() };
  if (!tile) return out;
  (tile.kind === 'atespace' ? out.atespaces : out.pools).add(tile.name);
  for (const p of flows.pairs.values()) {
    if (p.count <= 0) continue;
    if (tile.kind === 'atespace' && p.atespace === tile.name) out.pools.add(p.pool);
    if (tile.kind === 'pool' && p.pool === tile.name) out.atespaces.add(p.atespace);
  }
  return out;
}

/** True when two hovered tiles are the same (or both none). */
export function sameTile(a, b) {
  return (!a && !b) || (!!a && !!b && a.kind === b.kind && a.name === b.name);
}

// ------------------------------------------------------------------ beams

/**
 * Most individual beams drawn at once; beyond it the nearest in view are
 * kept and the ribbons carry the rest. A 100,000-agent cluster has about
 * 10,000 agents holding a worker: more beams than read as beams.
 */
export const BEAM_BUDGET = 4000;
/** Seconds a beam takes to drop (wake) or retract (suspend). */
export const BEAM_DROP = 0.7;

/**
 * Which agents get a beam: every agent holding a worker while they fit the
 * budget; else the nearest ones (nearest: keys in nearest-first order, from
 * the level-of-detail pass), plus the ones that must show (focus, selection).
 * @param {Set<string>|string[]} holders agents holding a worker
 * @param {number} budget
 * @param {() => string[]} nearest
 * @param {Iterable<string>} must
 * @returns {{keys: Set<string>, trimmed: boolean}}
 */
export function beamSet(holders, budget, nearest, must = []) {
  const all = holders instanceof Set ? holders : new Set(holders);
  if (all.size <= budget) return { keys: new Set(all), trimmed: false };
  const keys = new Set();
  for (const k of must) if (all.has(k)) keys.add(k);
  for (const k of nearest()) {
    if (keys.size >= budget) break;
    if (all.has(k)) keys.add(k);
  }
  return { keys, trimmed: true };
}

// ---------------------------------------------------------- movable decks

/**
 * Deck offsets: how far each deck has been moved from the planned
 * arrangement, {agents: {x, y, z}, workers: {x, y, z}}, plus whether a move
 * drags both decks (linked) or just the one grabbed. x and z slide a deck
 * in its plane; y raises or lowers it, which changes the gap between the
 * decks (clamped so they never intersect).
 */
export const DECK_MIN_GAP = 6;

/** The planned arrangement: nothing moved, linked. */
export function defaultOffsets() {
  return { agents: { x: 0, y: 0, z: 0 }, workers: { x: 0, y: 0, z: 0 }, linked: true };
}

/** A deep copy of offsets. */
export function copyOffsets(o) {
  return { agents: { ...o.agents }, workers: { ...o.workers }, linked: o.linked };
}

/** True when nothing has moved. */
export function isDefaultOffsets(o) {
  return ['agents', 'workers'].every((d) => o[d].x === 0 && o[d].y === 0 && o[d].z === 0);
}

/** The vertical gap between the decks for offsets o, when the plan's gap is base. */
export function gapOf(o, base) {
  return base + o.agents.y - o.workers.y;
}

/** The largest gap a deck may be pulled to (plan's gap base). */
export function maxGap(base) {
  return Math.max(base * 4, base + 120);
}

/**
 * Limits for a plan: the gap (min, max) and how far a deck may slide from
 * its planned place (reach), from the decks' sizes.
 * @param {number} base the planned gap
 * @param {number} span the bigger deck's bigger side
 */
export function deckLimits(base, span) {
  return { base, minGap: Math.min(DECK_MIN_GAP, base), maxGap: maxGap(base), reach: Math.max(200, span * 3) };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Offsets after moving a deck by d ({x, y, z}, world units): x and z slide
 * it (and, linked, the other deck the same, keeping their relative
 * offset), y changes its height only (the gap between the decks; linked or
 * not, moving both up together would change nothing you can see). The gap
 * stays within [minGap, maxGap] and every offset within reach.
 * @param {object} o offsets (not modified)
 * @param {'agents'|'workers'} deck the deck grabbed
 * @param {{x?: number, y?: number, z?: number}} d
 * @param {{base: number, minGap: number, maxGap: number, reach: number}} lim
 */
export function moveDeck(o, deck, d, lim) {
  const out = copyOffsets(o);
  const decks = o.linked ? ['agents', 'workers'] : [deck];
  let dx = d.x || 0;
  let dz = d.z || 0;
  // Linked moves stop together at the reach (keeping the relative offset).
  for (const k of decks) {
    dx = clamp(o[k].x + dx, -lim.reach, lim.reach) - o[k].x;
    dz = clamp(o[k].z + dz, -lim.reach, lim.reach) - o[k].z;
  }
  for (const k of decks) {
    out[k].x = o[k].x + dx;
    out[k].z = o[k].z + dz;
  }
  if (d.y) {
    const other = deck === 'agents' ? 'workers' : 'agents';
    // gap = base + agents.y - workers.y, within [minGap, maxGap].
    const sign = deck === 'agents' ? 1 : -1;
    const gap = clamp(gapOf(o, lim.base) + sign * d.y, lim.minGap, lim.maxGap);
    out[deck].y = deck === 'agents' ? gap - lim.base + o[other].y : o[other].y + lim.base - gap;
  }
  return out;
}

/** Clamps offsets to a plan's limits (a plan change, or offsets read from storage). */
export function clampOffsets(o, lim) {
  const out = copyOffsets(o);
  for (const k of ['agents', 'workers']) {
    out[k].x = clamp(out[k].x, -lim.reach, lim.reach);
    out[k].z = clamp(out[k].z, -lim.reach, lim.reach);
  }
  const gap = clamp(gapOf(out, lim.base), lim.minGap, lim.maxGap);
  out.workers.y = out.agents.y + lim.base - gap;
  return out;
}

/** The worker deck's position relative to the agent deck's, beyond the plan: workers - agents. */
export function relOffset(o) {
  return { x: o.workers.x - o.agents.x, y: o.workers.y - o.agents.y, z: o.workers.z - o.agents.z };
}

/** Moves offsets cur toward tgt by a fraction k (0..1); snaps when close. */
export function easeOffsets(cur, tgt, k) {
  const out = copyOffsets(tgt);
  let moving = false;
  for (const d of ['agents', 'workers']) {
    for (const a of ['x', 'y', 'z']) {
      const v = cur[d][a] + (tgt[d][a] - cur[d][a]) * k;
      if (Math.abs(tgt[d][a] - v) > 0.01) {
        out[d][a] = v;
        moving = true;
      }
    }
  }
  return { offsets: out, moving };
}

/** Offsets as stored (localStorage). */
export function serializeOffsets(o) {
  const r = (v) => Math.round(v * 100) / 100;
  const p = (v) => ({ x: r(v.x), y: r(v.y), z: r(v.z) });
  return JSON.stringify({ agents: p(o.agents), workers: p(o.workers), linked: !!o.linked });
}

/** Offsets read back (anything malformed falls back to the default, per field). */
export function parseOffsets(text) {
  const out = defaultOffsets();
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    return out;
  }
  if (!v || typeof v !== 'object') return out;
  const num = (x) => (typeof x === 'number' && Number.isFinite(x) && Math.abs(x) < 1e5 ? x : 0);
  for (const d of ['agents', 'workers']) {
    const s = v[d];
    if (s && typeof s === 'object') out[d] = { x: num(s.x), y: num(s.y), z: num(s.z) };
  }
  if (typeof v.linked === 'boolean') out.linked = v.linked;
  return out;
}

/**
 * Where a ray meets the horizontal plane at height y: {x, z, t}, or null
 * when it doesn't (parallel, or behind the origin).
 */
export function rayAtY(origin, dir, y) {
  if (Math.abs(dir.y) < 1e-6) return null;
  const t = (y - origin.y) / dir.y;
  if (t <= 0) return null;
  return { x: origin.x + dir.x * t, z: origin.z + dir.z * t, t };
}

/**
 * Where a point is on a deck's slab ({cx, cz, width, depth}): 'rim' within
 * tol of its edge (either side, so a thin rim is easy to grab), 'body'
 * inside, or null outside.
 */
export function slabZone(x, z, rect, tol) {
  const ex = Math.abs(x - rect.cx) - rect.width / 2;
  const ez = Math.abs(z - rect.cz) - rect.depth / 2;
  const out = Math.max(ex, ez);
  if (out > tol) return null;
  if (out >= -tol) return 'rim';
  return 'body';
}

/**
 * The deck under a ray: decks are [{id, rect, y, off: {x, z}}] (rect in
 * the deck's own coordinates, y its top in the scene, off its slide), tol
 * (t) => the rim tolerance in world units at ray distance t. A rim wins
 * over a body (the glass agent deck shouldn't hide the worker deck's rim);
 * otherwise the nearest hit. Returns {id, zone, x, z, y, t} with x and z in
 * the deck's coordinates, or null.
 */
export function deckAt(origin, dir, decks, tol) {
  let best = null;
  for (const d of decks) {
    const p = rayAtY(origin, dir, d.y);
    if (!p) continue;
    const lx = p.x - d.off.x;
    const lz = p.z - d.off.z;
    const zone = slabZone(lx, lz, d.rect, tol(p.t));
    if (!zone) continue;
    const hit = { id: d.id, zone, x: lx, z: lz, y: d.y, t: p.t };
    if (!best || (zone === 'rim' && best.zone !== 'rim') || (zone === best.zone && p.t < best.t)) best = hit;
  }
  return best;
}

/** World units per screen pixel at depth (camera space), for a vertical fov in degrees and a view h pixels high. */
export function unitsPerPixel(depth, fovDeg, h) {
  return (2 * depth * Math.tan((fovDeg * Math.PI) / 360)) / Math.max(1, h);
}

// ------------------------------------------------- beam focus and bundles

/** Beam modes: only the beams in focus (default; ribbons carry the rest), or every beam up to the budget. */
export const BEAM_MODES = ['focus', 'all'];

/** A valid beam mode. */
export function beamModeId(m) {
  return BEAM_MODES.includes(m) ? m : 'focus';
}

/** Seconds a woken or suspended agent's beam shows in focus mode before it fades (BEAM_FADE more). */
export const BEAM_RECENT = 3.5;
export const BEAM_FADE = 1.2;
/** Recent-change beams started per second in focus mode (big clusters change hundreds a second). */
export const BEAM_RECENT_RATE = 8;
/** How strongly focused beams bundle per atespace -> node pool (0 straight, 1 fully through the shared points). */
export const BUNDLE = 0.85;

/**
 * Which agents get a beam in focus mode: the ones that must show (the
 * selected and hovered agents, the agents of the worker in focus) while
 * they hold a worker, and recent wakes still within their time.
 * @param {Set<string>} holders agents holding a worker
 * @param {Iterable<string>} must
 * @param {Map<string, number>} recent key -> time its beam stops showing
 * @param {number} now
 * @returns {Set<string>}
 */
export function focusBeams(holders, must, recent, now) {
  const keys = new Set();
  for (const k of must) if (holders.has(k)) keys.add(k);
  for (const [k, until] of recent) if (until > now && holders.has(k)) keys.add(k);
  return keys;
}

/**
 * A beam's bundling control points (the shader computes the same):
 * a cubic from agent a to pad p whose inner control points are pulled
 * (by beta) toward points shared by every beam of the same atespace ->
 * node pool pair: under the district's center a third of the way down, and
 * over the pool's center two thirds of the way down. Beams of a pair leave
 * the district together, run as one cable and fan out over the pool.
 * @param {{x, y, z}} a agent end
 * @param {{x, y, z}} p pad end
 * @param {{x, z}} d district center
 * @param {{x, z}} q pool center
 * @param {number} beta 0..1
 * @returns {[{x, y, z}, {x, y, z}]}
 */
export function bundleControls(a, p, d, q, beta) {
  const lerp = (u, v, k) => u + (v - u) * k;
  const dy = p.y - a.y;
  const s1 = { x: lerp(a.x, p.x, 1 / 3), y: a.y + dy / 3, z: lerp(a.z, p.z, 1 / 3) };
  const s2 = { x: lerp(a.x, p.x, 2 / 3), y: a.y + (2 * dy) / 3, z: lerp(a.z, p.z, 2 / 3) };
  const c1 = { x: lerp(s1.x, d.x, beta), y: s1.y, z: lerp(s1.z, d.z, beta) };
  const c2 = { x: lerp(s2.x, q.x, beta), y: s2.y, z: lerp(s2.z, q.z, beta) };
  return [c1, c2];
}

/** A point on the cubic a, c1, c2, p at t. */
export function bezier(a, c1, c2, p, t) {
  const u = 1 - t;
  const w0 = u * u * u;
  const w1 = 3 * u * u * t;
  const w2 = 3 * u * t * t;
  const w3 = t * t * t;
  return { x: w0 * a.x + w1 * c1.x + w2 * c2.x + w3 * p.x, y: w0 * a.y + w1 * c1.y + w2 * c2.y + w3 * p.y, z: w0 * a.z + w1 * c1.z + w2 * c2.z + w3 * p.z };
}

/**
 * Whether a wheel event is a mouse wheel (zoom) rather than a two-finger
 * trackpad scroll (pan). Pinches arrive as wheel events with ctrlKey (zoom).
 * Mouse wheels scroll in lines (deltaMode 1) or in big whole steps on one
 * axis; trackpads send small, fractional or two-axis deltas, in streams, so
 * once a stream looks like a trackpad it stays one until it pauses.
 */
/** Scroll modes: auto guesses wheel vs trackpad; zoom and pan force one. */
export const SCROLL_MODES = ['auto', 'zoom', 'pan'];

/** A valid scroll mode for v, defaulting to auto. */
export function scrollModeId(v) {
  return SCROLL_MODES.includes(v) ? v : 'auto';
}

export class WheelKind {
  constructor() {
    this.padUntil = -Infinity;
    // 'auto' tells mouse wheels (zoom) from trackpad scrolls (pan) by their
    // deltas. A Magic Mouse swipe looks exactly like a trackpad scroll, so
    // its users need 'zoom': every scroll zooms and Shift+scroll pans.
    this.mode = 'auto';
  }

  /** 'zoom' or 'pan' for a wheel event ({deltaX, deltaY, deltaMode, ctrlKey, shiftKey}) at time now (ms). */
  classify(e, now) {
    if (e.ctrlKey) return 'zoom';
    if (this.mode === 'zoom') return e.shiftKey ? 'pan' : 'zoom';
    if (this.mode === 'pan') return 'pan';
    const wheel = e.deltaMode !== 0 || (e.deltaX === 0 && Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 50);
    if (!wheel || now < this.padUntil) {
      this.padUntil = now + 300;
      return 'pan';
    }
    return 'zoom';
  }
}
