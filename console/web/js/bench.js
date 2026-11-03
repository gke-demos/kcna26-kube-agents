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

// The benchmark's camera path and its summary: a fixed 20 s orbit through
// far (the whole island), mid (a few districts) and close (a few dozen
// agents), so the same test runs on every machine and the numbers compare.
// No imports and no DOM: hack/scale.mjs loads this file into any build of
// the page (old ones too) to measure them the same way, and node tests run it.

/** Seconds of the benchmark. */
export const BENCH_SECONDS = 20;

/** Phases: name and [start, end) in seconds. */
export const BENCH_PHASES = [
  { name: 'far', t0: 0, t1: 6 },
  { name: 'mid', t0: 6, t1: 13 },
  { name: 'close', t0: 13, t1: 20 },
];

/** The phase at time t (seconds since the start). */
export function benchPhase(t) {
  return (BENCH_PHASES.find((p) => t >= p.t0 && t < p.t1) || BENCH_PHASES[BENCH_PHASES.length - 1]).name;
}

const smooth = (k) => k * k * (3 - 2 * k);

/**
 * The camera at time t for an island {cx, cz, width, depth}: target and
 * position as [x, y, z]. Far orbits the whole island; mid flies low over a
 * band of districts; close circles slowly over the middle of the island.
 * Distances blend over the first second of each phase.
 */
export function benchPose(t, island) {
  const span = Math.max(island.width, island.depth * 1.5, 30);
  const far = Math.max(26, span * 0.95);
  const mid = Math.max(22, Math.min(far * 0.45, 90));
  const close = 16;
  let dist;
  let tx = island.cx;
  let tz = island.cz;
  let az;
  if (t < 6) {
    dist = far;
    az = -0.5 + (t / 6) * 1.0;
  } else if (t < 13) {
    const k = (t - 6) / 7;
    dist = far + (mid - far) * smooth(Math.min(1, (t - 6) / 1));
    // Pan across the island's middle band, left to right.
    tx = island.cx + (k - 0.5) * island.width * 0.6;
    tz = island.cz - island.depth * 0.1;
    az = 0.5 - k * 0.6;
  } else {
    const k = Math.min(1, (t - 13) / 7);
    dist = mid + (close - mid) * smooth(Math.min(1, (t - 13) / 1));
    tx = island.cx + island.width * 0.05 + Math.sin(k * Math.PI) * 6;
    tz = island.cz - island.depth * 0.05;
    az = -0.1 + k * 1.4;
  }
  const elev = 0.62; // radians above the ground plane
  const h = dist * Math.cos(elev);
  return {
    target: [tx, 0, tz],
    position: [tx + h * Math.sin(az), dist * Math.sin(elev), tz + h * Math.cos(az)],
  };
}

/** p-th quantile (0..1) of a sorted array. */
function quantile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

/**
 * Summarizes benchmark samples ({t, dt, cpu?, calls?, tris?} with dt the
 * frame interval in ms) per phase and overall: frames, fps, avg/p95/max
 * frame ms, avg CPU ms, draw calls and triangles.
 */
export function summarize(samples) {
  const rows = [];
  for (const ph of [...BENCH_PHASES, { name: 'all', t0: -Infinity, t1: Infinity }]) {
    const s = samples.filter((x) => (ph.name === 'all' ? true : benchPhase(x.t) === ph.name));
    const dts = s.map((x) => x.dt).sort((a, b) => a - b);
    const mean = dts.reduce((a, b) => a + b, 0) / (dts.length || 1);
    const avg = (k) => (s.length ? s.reduce((a, x) => a + (x[k] || 0), 0) / s.length : 0);
    rows.push({
      phase: ph.name,
      frames: s.length,
      fps: s.length ? 1000 / mean : 0,
      avgMs: mean,
      p95Ms: quantile(dts, 0.95),
      maxMs: dts.length ? dts[dts.length - 1] : 0,
      cpuMs: avg('cpu'),
      calls: avg('calls'),
      tris: avg('tris'),
    });
  }
  return rows;
}

/** The summary as plain text, to paste into a chat or an issue. */
export function formatSummary(info, rows) {
  const f = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '-');
  const k = (v) => (v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : f(v, 0));
  const lines = [
    `substrate-scope benchmark (${BENCH_SECONDS}s orbit: far, mid, close)`,
    ...Object.entries(info).map(([key, v]) => `${key}: ${v}`),
    '',
    'phase  frames   fps   avg ms  p95 ms  max ms  cpu ms  calls  tris',
    ...rows.map(
      (r) =>
        `${r.phase.padEnd(6)} ${String(r.frames).padStart(6)} ${f(r.fps).padStart(5)} ${f(r.avgMs).padStart(8)} ${f(r.p95Ms).padStart(7)} ${f(r.maxMs).padStart(7)} ${f(r.cpuMs).padStart(7)} ${f(r.calls, 0).padStart(6)}  ${k(r.tris)}`,
    ),
  ];
  return lines.join('\n');
}
