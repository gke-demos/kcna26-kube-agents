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

// Screenshots of a running substrate-scope with headless Chromium (WebGL on
// SwiftShader, so no GPU is needed).
//
//   node hack/screens.mjs --url http://localhost:8080/ --out DIR --name overview [--hash agent=cred-test/x] [--wait 4000]
//   node hack/screens.mjs ... --watch 120 --every 3   # a frame every 3s for 2 minutes (incident capture)

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
const url = (args.url || 'http://localhost:8080/') + (args.hash ? '#' + args.hash : '');
const out = args.out || '.';
const name = args.name || 'scope';
const width = Number(args.width || 1600);
const height = Number(args.height || 900);
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: Number(args.scale || 1) });
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') console.log('[browser]', m.type(), m.text());
});
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(url);
await page.waitForFunction(() => window.scope && window.scope.model.seq > 0, null, { timeout: 30000 });
if (args.eval) await page.evaluate(args.eval);
await page.waitForTimeout(Number(args.wait || 4000));

if (args.event) {
  // Wait for an event type (e.g. agent_woke), then take a burst of frames
  // so the animation it starts is caught.
  const before = await page.evaluate((t) => window.scope.eventCounts[t] || 0, args.event);
  await page.waitForFunction((a) => (window.scope.eventCounts[a.t] || 0) > a.n, { t: args.event, n: before }, { timeout: Number(args.timeout || 900) * 1000, polling: 100 });
  const burst = Number(args.burst || 8);
  for (let i = 0; i < burst; i++) {
    const file = path.join(out, `${name}-${String(i).padStart(2, "0")}.png`);
    await page.screenshot({ path: file });
    console.log(file);
  }
} else if (args.watch) {
  const until = Date.now() + Number(args.watch) * 1000;
  let i = 0;
  let lastSeq = -1;
  while (Date.now() < until) {
    const seq = await page.evaluate(() => window.scope.model.seq);
    if (seq !== lastSeq || args.all) {
      const file = path.join(out, `${name}-${String(i++).padStart(3, '0')}.png`);
      await page.screenshot({ path: file });
      console.log(file, 'seq', seq);
      lastSeq = seq;
    }
    await page.waitForTimeout(Number(args.every || 3) * 1000);
  }
} else {
  const file = path.join(out, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(file);
}
await browser.close();
