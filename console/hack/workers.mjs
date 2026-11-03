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

// Screenshots and frame timing for agents-to-workers: a hovered worker pad,
// a selected agent with its worker lit, flowing links at rest, the worker
// view, and the move between views. Headless Chromium with WebGL on
// SwiftShader (no GPU; frame times are pessimistic, compare them with each
// other only).
//
//   node hack/workers.mjs --url http://localhost:8081/ --out DIR [--themes orchid-night,google-light] [--only hover,selected,links,view,transition]
//   node hack/workers.mjs --url http://localhost:8081/ --perf 5000 [--seconds 8]

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .join(' ')
    .split('--')
    .filter(Boolean)
    .map((s) => {
      const [k, ...v] = s.trim().split(' ');
      return [k, v.join(' ') || 'true'];
    }),
);
const base = args.url || 'http://localhost:8081/';
const out = args.out || '.';
const themes = (args.themes || 'orchid-night,google-light').split(',');
const only = new Set((args.only || 'hover,selected,links,view,pinned,transition').split(','));

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

async function open(query, { width = 1600, height = 900 } = {}) {
  const page = await browser.newPage({ viewport: { width, height } });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('[browser]', m.text());
  });
  // A clean slate: no remembered grouping, labels or feed state.
  await page.addInitScript(() => localStorage.clear());
  await page.goto(`${base}?${new URLSearchParams({ router: 'portal', agents: 'orb', ...query })}`);
  await page.waitForFunction(() => window.scope && window.scope.model.seq > 0, null, { timeout: 60000 });
  return page;
}

async function shot(page, name) {
  const file = path.join(out, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(file);
}

/** Screen position of a worker's pad. */
const padScreen = (page, name) =>
  page.evaluate((name) => {
    const sc = window.scope.scene;
    const p = sc.pads.get(name).pos.clone().project(sc.camera);
    return { x: ((p.x + 1) / 2) * innerWidth, y: ((1 - p.y) / 2) * innerHeight };
  }, name);

/** Frames the front of the island (the pad row) from a little closer. */
const frameFront = (page, { pull = 0.62, shift = 0 } = {}) =>
  page.evaluate(
    ({ pull, shift }) => {
      const sc = window.scope.scene;
      sc.fitCamera();
      const offset = sc.camera.position.clone().sub(sc.controls.target);
      sc.controls.target.x += shift;
      sc.controls.target.z += sc.island.depth * 0.18;
      sc.camera.position.copy(sc.controls.target).add(offset.multiplyScalar(pull));
      sc.controls.update();
    },
    { pull, shift },
  );

/** The busiest active worker. */
const busiest = (page) =>
  page.evaluate(() => {
    const { scope } = window;
    const n = new Map();
    for (const a of scope.model.agents.values()) if (a.worker) n.set(a.worker, (n.get(a.worker) || 0) + 1);
    return [...scope.model.workers.values()].filter((w) => w.state === 'ACTIVE').sort((a, b) => (n.get(b.name) || 0) - (n.get(a.name) || 0))[0].name;
  });

async function hover(theme) {
  const page = await open({ synthetic: 1500, theme });
  await page.evaluate(() => window.scope.stream.close());
  await frameFront(page);
  await page.waitForTimeout(2500);
  const w = await busiest(page);
  const at = await padScreen(page, w);
  await page.mouse.move(at.x, at.y);
  await page.waitForTimeout(2500);
  await shot(page, `pad-hover-${theme}`);
  await page.close();
}

async function selected(theme) {
  const page = await open({ synthetic: 1500, theme });
  await page.evaluate(() => window.scope.stream.close());
  // A running agent left of center on a worker whose pad is left of center
  // too, framed left of the side panel with its pad in view.
  const key = await page.evaluate(() => {
    const sc = window.scope.scene;
    const cx = sc.island.cx;
    const recs = [...sc.recs.values()].filter((r) => r.cls === 'running' && r.agent.worker && sc.pads.get(r.agent.worker)?.pos.x < cx - 4 && r.x < cx - 4);
    recs.sort((a, b) => b.z - a.z);
    const r = recs[Math.floor(recs.length * 0.3)];
    const pad = sc.pads.get(r.agent.worker).pos;
    const mid = { x: (r.x + pad.x) / 2, z: (r.z + pad.z) / 2 };
    const d = Math.max(30, Math.hypot(r.x - pad.x, r.z - pad.z) * 1.6);
    sc.controls.target.set(mid.x + d * 0.22, 0, mid.z);
    sc.camera.position.set(mid.x + d * 0.3, d * 0.62, mid.z + d * 0.78);
    sc.controls.update();
    return r.key;
  });
  await page.evaluate((key) => window.scope.select(key, false), key);
  await page.waitForTimeout(3000);
  await shot(page, `agent-selected-${theme}`);
  await page.close();
}

async function links(theme) {
  const page = await open({ synthetic: 1500, theme });
  await frameFront(page, { pull: 0.55, shift: 4 });
  await page.waitForTimeout(4000);
  await shot(page, `links-rest-${theme}`);
  await page.close();
}

async function view(theme) {
  const page = await open({ synthetic: 1500, theme, group: 'worker' });
  await page.waitForTimeout(5000);
  await shot(page, `worker-view-${theme}`);
  await page.close();
}

async function pinned(theme) {
  const page = await open({ synthetic: 1500, theme, group: 'worker' });
  await page.evaluate(() => window.scope.stream.close());
  const w = await busiest(page);
  await page.evaluate((w) => {
    window.scope.scene.pinWorker(w);
    window.scope.scene.flyToWorker(w);
  }, w);
  await page.waitForTimeout(5000);
  await shot(page, `worker-view-pinned-${theme}`);
  await page.close();
}

async function transition(theme) {
  const page = await open({ synthetic: 1500, theme, slowmo: 8 });
  await page.evaluate(() => window.scope.stream.close());
  await page.waitForTimeout(2500);
  await page.evaluate(() => document.querySelector('#group button[data-group="worker"]').click());
  // About half way.
  await page.waitForFunction(
    () => {
      const sc = window.scope.scene;
      const mv = sc.moves.values().next().value;
      return mv && (sc.time.value - mv.t0) / mv.dur > 0.42;
    },
    null,
    { timeout: 60000, polling: 30 },
  );
  await shot(page, `transition-${theme}`);
  await page.close();
}

/** Mean and p95 frame time over a few seconds. */
const timing = (page, seconds) =>
  page.evaluate(
    (ms) =>
      new Promise((resolve) => {
        const times = [];
        let last = performance.now();
        const t0 = last;
        const tick = (now) => {
          times.push(now - last);
          last = now;
          if (now - t0 < ms) requestAnimationFrame(tick);
          else {
            times.sort((a, b) => a - b);
            const mean = times.reduce((a, b) => a + b, 0) / times.length;
            resolve({ frames: times.length, mean, p95: times[Math.floor(times.length * 0.95)] });
          }
        };
        requestAnimationFrame(tick);
      }),
    seconds * 1000,
  );

async function perf(n, seconds) {
  const rows = [];
  const cases = [
    { name: 'atespace', q: {} },
    { name: 'atespace, links off (x)', q: { extras: '0' } },
    { name: 'atespace, worker pinned', q: {}, pin: true },
    { name: 'worker view', q: { group: 'worker' } },
    { name: 'worker view, worker pinned', q: { group: 'worker' }, pin: true },
  ];
  for (const c of cases) {
    const page = await open({ synthetic: n, theme: 'orchid-night', ...c.q }, { width: 1280, height: 720 });
    await page.waitForTimeout(3000);
    if (c.pin) await page.evaluate(() => window.scope.scene.pinWorker('w-3'));
    await page.waitForTimeout(1000);
    const r = await timing(page, seconds);
    // The switch itself: how long the re-plan takes on the main thread.
    const switchMs = await page.evaluate(() => {
      const sc = window.scope.scene;
      const t = performance.now();
      sc.setGroup(sc.group === 'worker' ? 'atespace' : 'worker');
      return performance.now() - t;
    });
    rows.push({ case: c.name, links: await page.evaluate(() => window.scope.scene.links.count), fps: (1000 / r.mean).toFixed(1), meanMs: r.mean.toFixed(1), p95Ms: r.p95.toFixed(1), switchMs: switchMs.toFixed(0) });
    console.log(JSON.stringify(rows.at(-1)));
    await page.close();
  }
  console.table(rows);
}

fs.mkdirSync(out, { recursive: true });
if (args.perf) {
  await perf(Number(args.perf), Number(args.seconds || 8));
} else {
  for (const theme of themes) {
    if (only.has('hover')) await hover(theme);
    if (only.has('selected')) await selected(theme);
    if (only.has('links')) await links(theme);
    if (only.has('view')) await view(theme);
    if (only.has('pinned')) await pinned(theme);
    if (only.has('transition')) await transition(theme);
  }
}
await browser.close();
