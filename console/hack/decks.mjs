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

// Screenshots of the two-decks layout in headless Chromium (WebGL on
// SwiftShader): the overview with flow ribbons at 100,000 agents and 2,000
// workers, a mid zoom with beams, a woken agent's beam dropping to its
// worker, a hovered worker, a selected agent, the deck fade modes and a
// small cluster, per theme.
//
//   node hack/decks.mjs --url http://localhost:8081/ --out DIR [--themes orchid-night,google-light] [--only name,...]

import { chromium } from 'playwright';
import fs from 'node:fs';

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
const dir = args.out || 'screens/decks';
const themes = (args.themes || 'orchid-night,google-light').split(',');
const only = args.only ? new Set(args.only.split(',')) : null;
fs.mkdirSync(dir, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

async function open(query) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem('substrate-scope:feed-collapsed', '1');
  });
  await page.goto(`${base}?${new URLSearchParams({ router: 'portal', agents: 'orb', layout: 'decks', quality: 'high', ...query })}`);
  await page.waitForFunction(() => window.scope && window.scope.model.seq > 0 && window.scope.scene.island, null, { timeout: 300000 });
  await page.waitForTimeout(1500);
  return page;
}

/** Points the camera: target (x, y, z), distance d, elevation (radians) and azimuth (radians, 0 = from the front). */
const look = (page, p) =>
  page.evaluate((p) => {
    const sc = window.scope.scene;
    sc.flyAnim = null;
    const el = p.el ?? 0.6;
    const az = p.az ?? 0.15;
    const h = p.d * Math.cos(el);
    sc.controls.target.set(p.x, p.y ?? 0, p.z);
    sc.camera.position.set(p.x + h * Math.sin(az), (p.y ?? 0) + p.d * Math.sin(el), p.z + h * Math.cos(az));
    sc.controls.update();
  }, p);

async function shot(page, name, wait = 3000) {
  if (only && !only.has(name.replace(/^[^-]+-[^-]+-/, ''))) return;
  await page.waitForTimeout(wait);
  const file = `${dir}/${name}.png`;
  await page.screenshot({ path: file });
  const st = await page.evaluate(() => window.scope.scene.stats());
  console.log(file, '|', st.lod, '|', st.layout, '| calls', st.calls, '| beams', st.layers.beams, '| ribbons', st.layers.ribbons);
}

for (const theme of themes) {
  const page = await open({ synthetic: 100000, workers: 2000, theme });
  // Overview: far, ribbons from every atespace to every node pool.
  await page.evaluate(() => window.scope.scene.fitCamera());
  await shot(page, `${theme}-100k-overview`);
  // A far atespace under the pointer: its ribbons light up, the pools they reach too, and a tooltip says what flows.
  const at = await page.evaluate(() => {
    const sc = window.scope.scene;
    const big = [...sc.plan.districts.values()].sort((a, b) => b.capacity - a.capacity)[0];
    const v = sc.camera.position.clone().set(big.x + big.w * 0.6, 0.15, big.z + big.d * 0.6).project(sc.camera);
    const r = sc.renderer.domElement.getBoundingClientRect();
    return { x: r.left + (v.x * 0.5 + 0.5) * r.width, y: r.top + (-v.y * 0.5 + 0.5) * r.height };
  });
  await page.mouse.move(at.x, at.y);
  await shot(page, `${theme}-100k-atespace-hovered`, 2000);
  await page.mouse.move(5, 890);
  // Mid zoom: a band of districts and the pools under them, with beams.
  const mid = await page.evaluate(() => {
    const sc = window.scope.scene;
    const I = sc.island;
    const D = sc.deck;
    return { x: D.cx - D.width * 0.1, y: D.y * 0.35, z: I.cz + I.depth * 0.3, d: Math.abs(D.y) * 1.65, el: 0.55, az: 0.35 };
  });
  await look(page, mid);
  await shot(page, `${theme}-100k-mid-beams`);
  // Hover a worker: its beams light up, the others dim.
  await page.evaluate(() => {
    const sc = window.scope.scene;
    const [name] = [...sc.byWorker.entries()].filter(([w]) => sc.pads.get(w)).sort((a, b) => b[1].size - a[1].size)[0];
    sc.setHoverWorker(name);
  });
  await shot(page, `${theme}-100k-worker-hovered`, 2000);
  await page.evaluate(() => window.scope.scene.setHoverWorker(null));
  // Select an agent: its beam and worker light up.
  await page.evaluate(() => {
    const sc = window.scope.scene;
    const D = sc.deck;
    const rec = [...sc.recs.values()].filter((r) => r.agent.worker && r.cls === 'running').sort((a, b) => Math.abs(a.x - D.cx) - Math.abs(b.x - D.cx) + (Math.abs(a.z - D.cz) - Math.abs(b.z - D.cz)))[0];
    window.scope.select(rec.key, false);
  });
  await shot(page, `${theme}-100k-agent-selected`, 2000);
  await page.evaluate(() => window.scope.select(null));
  // Deck fade modes.
  await page.evaluate(() => window.scope.scene.setDeckView('workers', false));
  await page.evaluate(() => window.scope.scene.fitCamera());
  await shot(page, `${theme}-100k-workers-only`);
  await page.evaluate(() => window.scope.scene.setDeckView('agents', false));
  await page.evaluate(() => window.scope.scene.fitCamera());
  await shot(page, `${theme}-100k-agents-only`);
  await page.close();

  // A woken agent's beam dropping to its worker (a smaller cluster, so agent and pad fit one close view).
  {
    const p = await open({ synthetic: 3000, workers: 40, theme, slowmo: 12 });
    const target = await p.evaluate(() => {
      const sc = window.scope.scene;
      const D = sc.deck;
      const rec = [...sc.recs.values()].filter((r) => r.agent.worker && r.cls === 'running').sort((a, b) => Math.abs(a.z - (D.cz - D.depth / 2)) - Math.abs(b.z - (D.cz - D.depth / 2)))[0];
      const pad = sc.pads.get(rec.agent.worker);
      sc.select(rec.key);
      return { key: rec.key, x: (rec.x + pad.pos.x) / 2, y: D.y * 0.45, z: (rec.z + pad.pos.z) / 2, d: Math.max(30, Math.abs(D.y) * 2.1) };
    });
    await look(p, { ...target, el: 0.2, az: 0.55 });
    await p.waitForTimeout(2500);
    // Replay the wake: the beam drops from the agent (slowed down twelve times).
    await p.evaluate((key) => {
      const sc = window.scope.scene;
      sc.syncBeam(sc.recs.get(key), true);
    }, target.key);
    await shot(p, `${theme}-wake-beam-dropping`, 700);
    await shot(p, `${theme}-wake-beam-landed`, 9000);
    await p.close();
  }
  // A small cluster: 25 agents on workers reporting 1000 slots.
  {
    const p = await open({ synthetic: 25, workercap: 1000, theme });
    await p.evaluate(() => window.scope.stream.close());
    await p.evaluate(() => window.scope.scene.fitCamera());
    await shot(p, `${theme}-small-25`);
    await p.close();
  }
}
await browser.close();
