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

// Screenshots and frame timing for the router looks and agent shapes, with
// headless Chromium (WebGL on SwiftShader, so no GPU is needed; frame times
// are pessimistic, compare them with each other only).
//
//   node hack/shapes.mjs --url http://localhost:8081/ --out DIR [--themes orchid-night,google-light] [--only overview,shapes,closeup,wake]
//   node hack/shapes.mjs --url http://localhost:8081/ --perf 5000 [--seconds 10]

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
const only = new Set((args.only || 'overview,shapes,closeup,wake').split(','));
const ROUTERS = ['portal', 'lighthouse', 'core', 'tower'];
const SHAPES = ['orb', 'spark', 'meeple', 'droid', 'box'];
const DEFAULT = { router: 'portal', agents: 'orb' };

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

async function open(query, { width = 1600, height = 900 } = {}) {
  const page = await browser.newPage({ viewport: { width, height } });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('[browser]', m.text());
  });
  await page.goto(`${base}?${new URLSearchParams(query)}`);
  await page.waitForFunction(() => window.scope && window.scope.model.seq > 0, null, { timeout: 60000 });
  return page;
}

async function shot(page, name) {
  const file = path.join(out, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(file);
}

// In the page: stop the synthetic churn and set agents' states directly.
const setStates = (page, picks) =>
  page.evaluate((picks) => {
    const { scope } = window;
    let seq = scope.model.seq;
    const events = picks.map(([key, state]) => {
      const a = { ...scope.model.agents.get(key), state, stateSince: new Date().toISOString() };
      scope.model.agents.set(key, a);
      return { type: 'agent_state', key, agent: a, seq: ++seq };
    });
    scope.model.seq = seq;
    scope.scene.applyEvents(events);
  }, picks);

/** Four neighbours in one row near the middle of a district: keys left to right. */
const pickRow = (page, n, atespace) =>
  page.evaluate(
    ({ n, atespace }) => {
      const recs = [...window.scope.scene.recs.values()].filter((r) => !atespace || r.agent.atespace === atespace);
      const rows = new Map();
      for (const r of recs) {
        const z = r.z.toFixed(2);
        if (!rows.has(z)) rows.set(z, []);
        rows.get(z).push(r);
      }
      const zs = [...rows.keys()].sort((a, b) => a - b);
      const row = rows.get(zs[Math.floor(zs.length * 0.75)]).sort((a, b) => a.x - b.x);
      const mid = Math.max(0, Math.floor(row.length / 2) - Math.floor(n / 2));
      return row.slice(mid, mid + n).map((r) => r.key);
    },
    { n, atespace },
  );

async function overview(theme, router, agents, name) {
  const page = await open({ synthetic: 1500, theme, router, agents });
  await page.waitForTimeout(6000);
  await shot(page, name);
  await page.close();
}

async function closeup(theme, agents) {
  const page = await open({ synthetic: 300, theme, agents, router: DEFAULT.router });
  await page.evaluate(() => window.scope.stream.close());
  const keys = await pickRow(page, 4, 'payments');
  // Everything else in the district suspended, so nothing hides the four.
  const others = await page.evaluate(
    (keys) => [...window.scope.scene.recs.values()].filter((r) => r.agent.atespace === 'payments' && !keys.includes(r.key) && r.cls !== 'suspended').map((r) => r.key),
    keys,
  );
  await setStates(page, others.map((k) => [k, 'SUSPENDED']));
  await setStates(page, [
    [keys[0], 'RUNNING'],
    [keys[1], 'SUSPENDED'],
    [keys[2], 'RESUMING'],
    [keys[3], 'CRASHED'],
  ]);
  await page.evaluate((keys) => {
    const sc = window.scope.scene;
    // The running one serves a request: particles and a full idle ring.
    const r = sc.recs.get(keys[0]);
    sc.layers[r.cls].attrs.aServe.array[r.slot] = 1;
    sc.layers[r.cls].markDirty();
    const pts = keys.map((k) => sc.recs.get(k));
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const cz = pts[0].z;
    sc.controls.target.set(cx, 0.6, cz);
    sc.camera.position.set(cx + 0.6, 4.6, cz + 7.6);
    sc.controls.update();
    sc.setLabelMode('off');
  }, keys);
  await page.waitForTimeout(4000);
  // Captions under the four agents (screenshot tooling only).
  await page.evaluate((keys) => {
    const sc = window.scope.scene;
    const names = ['running', 'suspended', 'changing', '✕ crashed'];
    const v = sc.camera.position.clone();
    keys.forEach((k, i) => {
      const r = sc.recs.get(k);
      v.set(r.x, 0, r.z + 0.9).project(sc.camera);
      const d = document.createElement('div');
      d.textContent = names[i];
      d.style.cssText = `position:fixed;left:${((v.x + 1) / 2) * innerWidth}px;top:${((1 - v.y) / 2) * innerHeight}px;transform:translate(-50%,0);font:600 15px Inter,system-ui,sans-serif;color:var(--text);background:var(--label-bg);border:1px solid var(--label-border);padding:3px 10px;border-radius:7px;z-index:50`;
      document.body.appendChild(d);
    });
  }, keys);
  await page.waitForTimeout(300);
  await shot(page, `closeup-${theme}-${agents}`);
  await page.close();
}

async function wake(theme, router) {
  const page = await open({ synthetic: 1500, theme, router, agents: DEFAULT.agents, slowmo: 4 });
  await page.evaluate(() => window.scope.stream.close());
  await page.waitForTimeout(3000);
  // Wake a suspended agent far from the router.
  await page.evaluate(() => {
    const { scope } = window;
    const recs = [...scope.scene.recs.values()].filter((r) => r.cls === 'suspended' && r.agent.atespace === 'search');
    recs.sort((a, b) => b.x + b.z - (a.x + a.z));
    const r = recs[Math.floor(recs.length / 3)];
    const a = { ...r.agent, state: 'RUNNING', stateSince: new Date().toISOString() };
    scope.model.agents.set(r.key, a);
    scope.scene.applyEvents([{ type: 'agent_woke', key: r.key, agent: a, seq: ++scope.model.seq, reason: 'ResumedByRequest' }]);
  });
  // Mid-flight: the arc (or comet) about half way.
  await page.waitForFunction(() => {
    const sc = window.scope.scene;
    return sc.effects.items.some((it) => sc.time.value - it.t0 > 0.8);
  }, null, { timeout: 60000, polling: 50 });
  await shot(page, `wake-${theme}-${router}`);
  await page.close();
}

async function perf(n, seconds) {
  const rows = [];
  for (const agents of SHAPES) {
    for (const extras of ['1', '0']) {
      if (agents === 'box' && extras === '0') continue;
      const page = await open({ synthetic: n, theme: 'orchid-night', router: DEFAULT.router, agents, extras }, { width: 1280, height: 720 });
      await page.waitForTimeout(4000);
      const r = await page.evaluate(
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
      rows.push({ agents, extras: extras === '1' ? 'on' : 'off', fps: (1000 / r.mean).toFixed(1), meanMs: r.mean.toFixed(1), p95Ms: r.p95.toFixed(1), frames: r.frames });
      console.log(JSON.stringify(rows.at(-1)));
      await page.close();
    }
  }
  console.table(rows);
}

fs.mkdirSync(out, { recursive: true });
if (args.perf) {
  await perf(Number(args.perf), Number(args.seconds || 10));
} else {
  for (const theme of themes) {
    if (args.routers) { for (const router of args.routers.split(',')) await wake(theme, router); continue; }
    if (only.has('overview')) for (const router of ROUTERS) await overview(theme, router, DEFAULT.agents, `router-${theme}-${router}`);
    if (only.has('shapes')) for (const agents of SHAPES) await overview(theme, DEFAULT.router, agents, `agents-${theme}-${agents}`);
    if (only.has('closeup')) for (const agents of SHAPES) await closeup(theme, agents);
    if (only.has('wake')) for (const router of ROUTERS) await wake(theme, router);
  }
}
await browser.close();
