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

// Screenshots of movable decks and focus beams in headless Chromium (WebGL
// on SwiftShader), driven with real mouse and keyboard input: the hover
// outline on a deck's rim, the decks pulled apart sideways (unlinked), the
// worker deck lowered (Shift+drag), a linked move mid-drag, and at 100,000
// agents beams=focus with a worker pinned, beams=focus at rest (ribbons
// only) and beams=all for comparison, per theme.
//
//   node hack/decks-move.mjs --url http://localhost:8081/ --out DIR [--themes orchid-night,google-light] [--only name,...]

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
const dir = args.out || 'screens/decks-move';
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

/** Screen position of a point on a deck: which 'agents'|'workers', u and v from -1 to 1 across its slab (1.02: just past the rim). */
const onDeck = (page, which, u, v) =>
  page.evaluate(
    ([which, u, v]) => {
      const sc = window.scope.scene;
      const o = which === 'workers' ? sc.workerOrigin() : { x: 0, y: 0, z: 0 };
      const r0 = which === 'workers' ? sc.deck : sc.island;
      const p = sc.camera.position.clone().set(r0.cx + (u * r0.width) / 2 + o.x, o.y, r0.cz + (v * r0.depth) / 2 + o.z).project(sc.camera);
      const r = sc.renderer.domElement.getBoundingClientRect();
      return { x: r.left + (p.x * 0.5 + 0.5) * r.width, y: r.top + (-p.y * 0.5 + 0.5) * r.height };
    },
    [which, u, v],
  );

/** Drags with the mouse from a to b in steps (keys held: e.g. ['Shift']); hold: leave the button down at the end. */
async function drag(page, a, b, { keys = [], steps = 12, hold = false } = {}) {
  await page.mouse.move(a.x, a.y);
  await page.waitForTimeout(400);
  for (const k of keys) await page.keyboard.down(k);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps);
    await page.waitForTimeout(40);
  }
  if (hold) return;
  await page.mouse.up();
  for (const k of keys) await page.keyboard.up(k);
}

async function shot(page, name, wait = 2500) {
  await page.waitForTimeout(wait);
  const file = `${dir}/${name}.png`;
  await page.screenshot({ path: file });
  const st = await page.evaluate(() => ({ s: window.scope.scene.stats(), o: window.scope.scene.offsets }));
  console.log(file, '|', st.s.layout, '| beams', st.s.layers.beams, '| ribbons', st.s.layers.ribbons, '| offsets', JSON.stringify(st.o));
}

const want = (name) => !only || only.has(name);

for (const theme of themes) {
  // Moving the decks: a mid-sized cluster, so both decks and their beams read in one view.
  if (['rim-hover', 'linked-move', 'pulled-apart', 'worker-lowered'].some(want)) {
    const page = await open({ synthetic: 20000, workers: 300, theme });
    await page.evaluate(() => window.scope.scene.fitCamera());
    await page.waitForTimeout(1000);
    // Hovering the worker deck's right rim: its grab outline and a move cursor.
    const rim = await onDeck(page, 'workers', 1.0, 0.1);
    await page.mouse.move(rim.x, rim.y);
    if (want('rim-hover')) await shot(page, `${theme}-rim-hover`, 1500);
    // A linked move, mid-drag: both decks follow the pointer, both outlined.
    if (want('linked-move')) {
      await drag(page, rim, { x: rim.x + 160, y: rim.y - 40 }, { hold: true });
      await shot(page, `${theme}-linked-move`, 1200);
      await page.mouse.up();
    }
    await page.keyboard.press('r');
    await page.waitForTimeout(1500);
    // Unlink (Shift+L), then slide the worker deck out to the right by its
    // rim, until it clears the agent deck (the grabbed point follows the pointer).
    await page.keyboard.press('Shift+L');
    const r2 = await onDeck(page, 'workers', 1.0, 0.1);
    const to = await page.evaluate(() => {
      const sc = window.scope.scene;
      const I = sc.island;
      const D = sc.deck;
      const o = sc.workerOrigin();
      const p = sc.camera.position.clone().set(I.cx + I.width / 2 + D.width + 20, o.y, D.cz + (0.1 * D.depth) / 2 - D.depth * 0.25).project(sc.camera);
      const r = sc.renderer.domElement.getBoundingClientRect();
      return { x: r.left + (p.x * 0.5 + 0.5) * r.width, y: r.top + (-p.y * 0.5 + 0.5) * r.height };
    });
    await drag(page, r2, to, { steps: 20 });
    await page.evaluate(() => window.scope.scene.fitCamera());
    if (want('pulled-apart')) await shot(page, `${theme}-pulled-apart`, 2500);
    // Lower the worker deck: Shift+drag on its rim (a bigger gap).
    const r3 = await onDeck(page, 'workers', 1.0, -0.2);
    await drag(page, r3, { x: r3.x, y: r3.y + 160 }, { keys: ['Shift'] });
    await page.mouse.move(5, 890);
    await page.evaluate(() => window.scope.scene.fitCamera());
    if (want('worker-lowered')) await shot(page, `${theme}-worker-lowered`, 2500);
    await page.close();
  }

  // Beams at 100,000 agents and 2,000 workers, mid zoom: focus at rest, focus with a worker pinned, and all.
  if (['focus-rest', 'focus-pinned', 'beams-all'].some(want)) {
    const page = await open({ synthetic: 100000, workers: 2000, theme });
    const mid = await page.evaluate(() => {
      const sc = window.scope.scene;
      const I = sc.island;
      const D = sc.deck;
      return { x: D.cx - D.width * 0.1, y: D.y * 0.35, z: I.cz + I.depth * 0.3, d: Math.abs(D.y) * 1.65 };
    });
    const look = () =>
      page.evaluate((p) => {
        const sc = window.scope.scene;
        sc.flyAnim = null;
        const el = 0.55;
        const az = 0.35;
        const h = p.d * Math.cos(el);
        sc.controls.target.set(p.x, p.y, p.z);
        sc.camera.position.set(p.x + h * Math.sin(az), p.y + p.d * Math.sin(el), p.z + h * Math.cos(az));
        sc.controls.update();
      }, mid);
    await look();
    await page.mouse.move(5, 890);
    if (want('focus-rest')) await shot(page, `${theme}-100k-focus-rest`, 3000);
    // Pin the busiest worker in view (as a click on its pad would).
    await page.evaluate(() => {
      const sc = window.scope.scene;
      const fr = sc.frustum();
      const o = sc.workerOrigin();
      const cands = [...sc.byWorker.entries()].filter(([w]) => {
        const p = sc.pads.get(w);
        return p && fr.containsPoint(p.pos.clone().add(o));
      });
      const [name] = cands.sort((a, b) => b[1].size - a[1].size)[0];
      sc.pinWorker(name);
    });
    if (want('focus-pinned')) await shot(page, `${theme}-100k-focus-pinned`, 3000);
    await page.evaluate(() => window.scope.scene.pinWorker(null));
    // The same view with every beam (the old behavior).
    await page.click('#beams button[data-beams="all"]');
    await look();
    await page.mouse.move(5, 890);
    if (want('beams-all')) await shot(page, `${theme}-100k-beams-all`, 4000);
    await page.close();
  }
}
await browser.close();
