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

// Scale measurements in headless Chromium (WebGL on SwiftShader: no GPU, so
// only compare numbers from this script with each other). It loads
// web/js/bench.js into the page and drives the camera along the same 20 s
// path as the in-app benchmark, so it measures any build of the page the
// same way, including builds from before the benchmark existed.
//
//   node hack/scale.mjs --url http://localhost:8081/ [--sizes 10000,50000,100000] [--workers 2000] [--seconds 20] [--viewport 1280x720] [--query k=v&...] [--json out.json]
//
// A small --viewport (e.g. 320x180) takes SwiftShader's fill and
// post-processing cost out of the numbers, so what is left is the scene's
// geometry and the main thread.
//   node hack/scale.mjs --url http://localhost:8081/ --shots DIR   (screenshots at 100k agents / 2k workers)

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
const sizes = (args.sizes || '10000,50000,100000').split(',').map(Number);
const workers = args.workers || '2000';
const extra = args.query ? Object.fromEntries(new URLSearchParams(args.query)) : {};
const benchSrc = fs.readFileSync(new URL('../web/js/bench.js', import.meta.url), 'utf8');

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-precise-memory-info'],
});

async function measure(n) {
  const [vw, vh] = (args.viewport || '1280x720').split('x').map(Number);
  const page = await browser.newPage({ viewport: { width: vw, height: vh } });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.addInitScript(() => localStorage.clear());
  const q = new URLSearchParams({ synthetic: n, workers, theme: 'orchid-night', router: 'portal', agents: 'orb', ...extra });
  const t0 = Date.now();
  await page.goto(`${base}?${q}`);
  await page.waitForFunction(() => window.scope && window.scope.model.seq > 0 && window.scope.scene.island, null, { timeout: 300000 });
  // The first rendered frame after the snapshot.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const loadMs = Date.now() - t0;
  await page.waitForTimeout(2000);
  const result = await page.evaluate(
    async ({ src, seconds }) => {
      const bench = await import(`data:text/javascript,${encodeURIComponent(src)}`);
      const sc = window.scope.scene;
      sc.flyAnim = null;
      const info = sc.renderer.info;
      info.autoReset = false;
      info.reset();
      const island = { ...sc.island };
      let long = 0;
      const obs = new PerformanceObserver((l) => l.getEntries().forEach((e) => (long += e.duration)));
      try {
        obs.observe({ entryTypes: ['longtask'] });
      } catch {
        /* not supported */
      }
      const samples = [];
      return await new Promise((resolve) => {
        let start = 0;
        let last = 0;
        const tick = (now) => {
          if (!start) start = last = now;
          const t = (now - start) / 1000;
          // cpu: the scene's main-thread work in the frame (scene.lastCpu, where the build has it).
          if (now !== last) samples.push({ t: (last - start) / 1000, dt: now - last, cpu: sc.lastCpu || 0, calls: info.render.calls, tris: info.render.triangles });
          info.reset();
          last = now;
          const p = bench.benchPose(Math.min(t, bench.BENCH_SECONDS - 1e-3), island);
          sc.controls.target.set(...p.target);
          sc.camera.position.set(...p.position);
          sc.camera.lookAt(sc.controls.target);
          if (t < seconds) requestAnimationFrame(tick);
          else {
            obs.disconnect();
            resolve({ rows: bench.summarize(samples), longTaskMs: long, heapMB: performance.memory ? performance.memory.usedJSHeapSize / 2 ** 20 : 0 });
          }
        };
        requestAnimationFrame(tick);
      });
    },
    { src: benchSrc, seconds: Number(args.seconds || 20) },
  );
  await page.close();
  return { n, workers: Number(workers), loadMs, ...result };
}

/** Screenshots of the levels of detail, the worker view, the perf overlay and a capacity-1000 cluster. */
async function shots(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const open = async (query, { feed = false } = {}) => {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    page.on('pageerror', (e) => console.log('[pageerror]', e.message));
    await page.addInitScript((feed) => {
      localStorage.clear();
      if (!feed) localStorage.setItem('substrate-scope:feed-collapsed', '1');
    }, feed);
    await page.goto(`${base}?${new URLSearchParams({ router: 'portal', agents: 'orb', ...query })}`);
    await page.waitForFunction(() => window.scope && window.scope.model.seq > 0 && window.scope.scene.island, null, { timeout: 300000 });
    await page.waitForTimeout(1500);
    return page;
  };
  const pose = (page, p) =>
    page.evaluate((p) => {
      const sc = window.scope.scene;
      const I = sc.island;
      if (p.fit) sc.fitCamera();
      else {
        const tx = p.x ?? I.cx + I.width * (p.fx || 0);
        const tz = p.z ?? I.cz + I.depth * (p.fz || 0);
        sc.controls.target.set(tx, 0, tz);
        sc.camera.position.set(tx + p.d * 0.22, p.d * 0.62, tz + p.d * 0.75);
        sc.controls.update();
      }
    }, p);
  const shot = async (page, name, wait = 3000) => {
    await page.waitForTimeout(wait);
    const file = `${dir}/${name}.png`;
    await page.screenshot({ path: file });
    const st = await page.evaluate(() => window.scope.scene.stats());
    console.log(file, '|', st.lod, '| calls', st.calls, '| tris', st.triangles, '| shapes', st.layers.shapes);
  };
  // quality=high: the same pixel ratio, bloom and shape budget in every shot.
  const big = { synthetic: 100000, workers: 2000, quality: 'high' };
  for (const theme of ['orchid-night', 'google-light']) {
    const page = await open({ ...big, theme });
    await pose(page, { fit: true });
    await shot(page, `100k-${theme}-far`);
    await pose(page, { d: 230, fx: -0.12, fz: -0.05 });
    await shot(page, `100k-${theme}-mid`);
    await pose(page, { d: 26, fx: -0.12, fz: -0.05 });
    await shot(page, `100k-${theme}-close`);
    await page.close();
  }
  // Worker view at 2,000 workers: the whole fleet, then one node pool.
  {
    const page = await open({ ...big, theme: 'orchid-night', group: 'worker' });
    await pose(page, { fit: true });
    await shot(page, 'workers-2k-far');
    const pool = await page.evaluate(() => {
      const f = window.scope.scene.plan.frames.filter((x) => x.kind === 'pool').sort((a, b) => b.w * b.d - a.w * a.d)[3];
      return { x: f.x + f.w / 2, z: f.z + f.d / 2, d: Math.max(f.w, f.d * 1.4) * 0.95 };
    });
    await pose(page, pool);
    await shot(page, 'workers-2k-pool');
    await pose(page, { x: pool.x, z: pool.z, d: 34 });
    await shot(page, 'workers-2k-close');
    await page.close();
  }
  // The perf overlay, after a benchmark run.
  {
    const page = await open({ ...big, theme: 'orchid-night', perf: '1' }, { feed: true });
    await page.evaluate(() => window.scope.perf.runBench());
    await page.waitForFunction(() => window.scope.benchResult, null, { timeout: 600000 });
    await shot(page, 'perf-overlay', 500);
    fs.writeFileSync(`${dir}/perf-overlay-bench.txt`, await page.evaluate(() => window.scope.benchResult));
    await page.close();
  }
  // Task A: real Substrate workers report 1000 slots and no CPU/memory allocation.
  {
    const page = await open({ synthetic: 25, workercap: 1000, alloc: '0', group: 'worker', theme: 'orchid-night', quality: 'high' }, { feed: true });
    await page.evaluate(() => window.scope.stream.close());
    await pose(page, { fit: true });
    await shot(page, 'cap1000-worker-view');
    await page.evaluate(() => {
      const sc = window.scope.scene;
      const w = [...sc.model.agents.values()].find((a) => a.worker)?.worker;
      sc.pinWorker(w);
      sc.flyToWorker(w);
    });
    await shot(page, 'cap1000-pinned-card');
    await page.close();
  }
}

if (args.shots) {
  await shots(args.shots);
  await browser.close();
  process.exit(0);
}

// Warm up first: SwiftShader compiles each shader and pipeline variant on
// first use and caches it for the browser's lifetime, so the first page in
// a fresh browser is slow for seconds whatever it draws. A short throwaway
// run of the same path keeps that out of the numbers.
async function warmup() {
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  await page.goto(`${base}?${new URLSearchParams({ synthetic: 20000, workers: 200, theme: 'orchid-night', router: 'portal', agents: 'orb', ...extra })}`);
  await page.waitForFunction(() => window.scope && window.scope.model.seq > 0 && window.scope.scene.island, null, { timeout: 300000 });
  await page.evaluate(async (src) => {
    const bench = await import(`data:text/javascript,${encodeURIComponent(src)}`);
    const sc = window.scope.scene;
    const island = { ...sc.island };
    const t0 = performance.now();
    await new Promise((resolve) => {
      const tick = (now) => {
        const t = ((now - t0) / 1000) * 2;
        const p = bench.benchPose(Math.min(t, bench.BENCH_SECONDS - 1e-3), island);
        sc.controls.target.set(...p.target);
        sc.camera.position.set(...p.position);
        sc.camera.lookAt(sc.controls.target);
        if (t < bench.BENCH_SECONDS) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
  }, benchSrc);
  await page.close();
}
await warmup();

const all = [];
for (const n of sizes) {
  const r = await measure(n);
  all.push(r);
  console.log(`\n${r.n} agents, ${r.workers} workers: load ${(r.loadMs / 1000).toFixed(1)}s, heap ${r.heapMB.toFixed(0)} MB, long tasks ${(r.longTaskMs / 1000).toFixed(1)}s`);
  console.table(r.rows.map((x) => ({ phase: x.phase, frames: x.frames, fps: x.fps.toFixed(2), avgMs: x.avgMs.toFixed(0), p95Ms: x.p95Ms.toFixed(0), maxMs: x.maxMs.toFixed(0), cpuMs: x.cpuMs.toFixed(1), calls: x.calls.toFixed(0), tris: Math.round(x.tris) })));
}
if (args.json) fs.writeFileSync(args.json, JSON.stringify(all, null, 2));
await browser.close();
