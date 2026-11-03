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

// Records one pass of the controls tour (?demo=controls) in headless
// Chromium (WebGL on SwiftShader): a video of the whole pass, a screenshot
// of every step mid-way (its caption and the input being simulated), and
// checks that the user's state is back after the tour ends.
//
//   node hack/tour.mjs --url http://localhost:8081/ --out DIR [--theme orchid-night] [--query synthetic=2000&workers=40]
//     [--video false] [--maxdt 0.25] [--prefix name-]
//
// SwiftShader draws a few frames a second; the tour advances at most
// --maxdt seconds a frame (the app uses 0.1), so a pass takes about real time.

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
const dir = args.out || 'screens/tour';
const theme = args.theme || 'orchid-night';
const query = new URLSearchParams(args.query || 'synthetic=2000&workers=40');
const video = args.video !== 'false';
const prefix = args.prefix || '';
fs.mkdirSync(dir, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const size = { width: 1600, height: 900 };
const context = await browser.newContext({ viewport: size, ...(video ? { recordVideo: { dir, size } } : {}) });
const page = await context.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => m.type() === 'error' && console.log('[console]', m.text()));
await page.addInitScript(() => {
  localStorage.clear();
  localStorage.setItem('substrate-scope:feed-collapsed', '1');
});
query.set('theme', theme);
query.set('demo', 'controls');
query.set('loop', '0');
await page.goto(`${base}?${query}`);
await page.waitForFunction(() => window.scope?.tour?.running, null, { timeout: 300000 });
await page.evaluate((m) => (window.scope.tour.ctl.maxDt = m), Number(args.maxdt || 0.25));
const t0 = Date.now();
const before = await page.evaluate(() => window.scope.tour.ctl.saved);

const n = await page.evaluate(() => window.scope.tour.ctl.steps.length);
let shot = -1;
// One screenshot per step, taken when the step's clock passes ~60% (mid-movement).
while (await page.evaluate(() => window.scope.tour.running)) {
  const s = await page.evaluate(() => {
    const c = window.scope.tour.ctl;
    return { i: c.index, t: c.t, dur: c.step.dur, id: c.step.id, now: document.querySelector('.tour-now').textContent };
  });
  if (s.i > shot && s.t > s.dur * 0.42) {
    const file = path.join(dir, `${prefix}${String(s.i + 1).padStart(2, '0')}-${s.id}.png`);
    await page.screenshot({ path: file });
    console.log(`step ${s.i + 1}/${n} ${s.id}: ${s.now} -> ${file}`);
    shot = s.i;
  }
  await page.waitForTimeout(150);
}
console.log(`tour pass took ${((Date.now() - t0) / 1000).toFixed(1)} s`);
const after = await page.evaluate(() => {
  const sc = window.scope.scene;
  return { layout: sc.layout, beams: sc.beamMode, view: sc.deckView, offsets: sc.copyDeckOffsets(), cam: sc.camera.position.toArray(), overlay: document.getElementById('tour').hidden };
});
console.log('restored:', JSON.stringify({ before: { layout: before.layout, beams: before.beams, view: before.view, offsets: before.offsets }, after }));
await page.waitForTimeout(800);
const v = page.video();
await context.close();
if (v) {
  const out = path.join(dir, `${prefix}tour-${theme}.webm`);
  fs.renameSync(await v.path(), out);
  console.log('video ->', out);
}
await browser.close();
