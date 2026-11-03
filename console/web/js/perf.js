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

// Performance tooling: ?perf=1 shows an overlay (FPS, frame ms avg/p95,
// draw calls, triangles, geometries/textures, JS heap, instance counts per
// layer, the level of detail), and ?bench=1 or its Benchmark button runs
// the fixed 20 s camera path from bench.js and prints a summary that is
// also copied to the clipboard, so the same test can run on any machine.

import { BENCH_SECONDS, benchPose, benchPhase, summarize, formatSummary } from './bench.js';

/** Rolling frame statistics over the last n frames. */
export class FrameStats {
  constructor(n = 240) {
    this.n = n;
    this.dt = new Float32Array(n);
    this.cpu = new Float32Array(n);
    this.i = 0;
    this.count = 0;
    this.last = 0;
  }

  /** Records a frame: now (ms, performance.now()) and its CPU time (ms). */
  push(now, cpu) {
    if (this.last) {
      this.dt[this.i] = now - this.last;
      this.cpu[this.i] = cpu;
      this.i = (this.i + 1) % this.n;
      this.count = Math.min(this.count + 1, this.n);
    }
    this.last = now;
  }

  /** {fps, avgMs, p95Ms, cpuMs} over the window. */
  summary() {
    const k = this.count;
    if (!k) return { fps: 0, avgMs: 0, p95Ms: 0, cpuMs: 0 };
    const dts = Array.from(this.dt.subarray(0, k)).sort((a, b) => a - b);
    const mean = dts.reduce((a, b) => a + b, 0) / k;
    let cpu = 0;
    for (let j = 0; j < k; j++) cpu += this.cpu[j];
    return { fps: 1000 / mean, avgMs: mean, p95Ms: dts[Math.min(k - 1, Math.floor(k * 0.95))], cpuMs: cpu / k };
  }
}

/** The GPU's name, when the browser tells (WEBGL_debug_renderer_info). */
export function gpuName(renderer) {
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
  } catch {
    return 'unknown';
  }
}

const fmtK = (v) => (v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e4 ? `${(v / 1e3).toFixed(0)}k` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : String(Math.round(v)));

/**
 * The ?perf=1 overlay and the benchmark. scene must offer: frameStats
 * (a FrameStats it feeds every frame), stats() (renderer and layer
 * counts), island, setCameraDriver(fn|null) and renderer.
 */
export class PerfOverlay {
  /**
   * @param {HTMLElement} parent
   * @param {object} scene
   * @param {() => object} info extra lines for the benchmark summary (agents, workers, theme...)
   * @param {{visible?: boolean}} opts
   */
  constructor(parent, scene, info, { visible = true } = {}) {
    this.scene = scene;
    this.info = info;
    const el = document.createElement('div');
    el.id = 'perf';
    el.innerHTML = `<div class="perf-head"><b>perf</b><span><button type="button" class="copy" hidden>Copy result</button> <button type="button" class="bench">Benchmark (20s)</button></span></div><pre class="perf-body"></pre><textarea class="perf-result" readonly hidden></textarea>`;
    el.hidden = !visible;
    parent.appendChild(el);
    this.el = el;
    this.body = el.querySelector('.perf-body');
    this.result = el.querySelector('.perf-result');
    el.querySelector('.bench').addEventListener('click', () => this.runBench());
    this.copyBtn = el.querySelector('.copy');
    this.copyBtn.addEventListener('click', () => this.copy(this.result.value));
    this.timer = setInterval(() => this.update(), 500);
    this.update();
  }

  update() {
    if (this.el.hidden) return;
    const f = this.scene.frameStats.summary();
    const s = this.scene.stats();
    const layers = Object.entries(s.layers)
      .map(([k, v]) => `  ${k.padEnd(10)} ${fmtK(v)}`)
      .join('\n');
    const lines = [
      `fps        ${f.fps.toFixed(1)}`,
      `frame ms   ${f.avgMs.toFixed(1)} avg  ${f.p95Ms.toFixed(1)} p95`,
      `cpu ms     ${f.cpuMs.toFixed(1)}`,
      `draw calls ${s.calls}`,
      `triangles  ${fmtK(s.triangles)}  points ${fmtK(s.points)}`,
      `geometries ${s.geometries}  textures ${s.textures}`,
      s.heapMB ? `js heap    ${s.heapMB.toFixed(0)} MB` : null,
      `lod        ${s.lod}`,
      `quality    ${s.quality}`,
      s.layout ? `layout     ${s.layout}` : null,
      `instances`,
      layers,
    ].filter((x) => x !== null);
    if (this.bench) lines.unshift(`BENCH ${this.bench.phase} ${this.bench.t.toFixed(1)}s / ${BENCH_SECONDS}s`);
    this.body.textContent = lines.join('\n');
  }

  /** Runs the 20 s camera path; resolves with the summary text (also copied to the clipboard). */
  runBench() {
    if (this.bench) return this.bench.promise;
    this.el.hidden = false;
    const sc = this.scene;
    const samples = [];
    let resolve;
    const promise = new Promise((r) => (resolve = r));
    const b = { t: 0, phase: 'far', last: 0, promise };
    this.bench = b;
    this.result.hidden = true;
    // The decks run in their planned arrangement, so runs compare whatever
    // the user dragged them to; their layout comes back afterwards.
    const decks = sc.offsets && sc.copyDeckOffsets ? sc.copyDeckOffsets() : null;
    if (decks) sc.setDeckOffsets({ ...decks, agents: { x: 0, y: 0, z: 0 }, workers: { x: 0, y: 0, z: 0 } });
    this.benchDecks = decks ? (decks.agents.x || decks.agents.y || decks.agents.z || decks.workers.x || decks.workers.y || decks.workers.z ? 'reset to the plan for the run (restored after)' : 'as planned') : null;
    const island = { ...sc.island };
    // Quality stays where it is during the run ('auto' would otherwise
    // re-size render targets mid-run, a long frame that isn't the scene's).
    if (sc.quality) sc.quality.held = true;
    sc.setCameraDriver((frame) => {
      const now = performance.now();
      if (!b.last) b.last = now;
      else {
        b.t += (now - b.last) / 1000;
        samples.push({ t: b.t, dt: now - b.last, cpu: frame.cpu, calls: frame.calls, tris: frame.tris });
      }
      b.last = now;
      b.phase = benchPhase(b.t);
      const p = benchPose(Math.min(b.t, BENCH_SECONDS - 1e-3), island);
      sc.controls.target.set(...p.target);
      sc.camera.position.set(...p.position);
      sc.camera.lookAt(sc.controls.target);
      if (b.t >= BENCH_SECONDS) {
        sc.setCameraDriver(null);
        if (sc.quality) sc.quality.held = false;
        if (decks) sc.setDeckOffsets(decks);
        this.bench = null;
        const text = formatSummary(this.benchInfo(), summarize(samples));
        this.showResult(text);
        resolve(text);
      }
    });
    return promise;
  }

  benchInfo() {
    const r = this.scene.renderer;
    const c = r.domElement;
    return {
      date: new Date().toISOString(),
      gpu: gpuName(r),
      browser: navigator.userAgent,
      canvas: `${c.width}x${c.height} (dpr ${r.getPixelRatio().toFixed(2)})`,
      ...this.info(),
      ...(this.benchDecks ? { decks: this.benchDecks } : {}),
    };
  }

  showResult(text) {
    this.result.hidden = false;
    this.result.value = text;
    this.result.rows = text.split('\n').length;
    console.log(text);
    window.scope && (window.scope.benchResult = text);
    this.copyBtn.hidden = false;
    this.copy(text);
  }

  /** Copies text to the clipboard; without permission, selects it for a manual copy. */
  copy(text) {
    const copied = () => this.flash('copied to clipboard');
    navigator.clipboard?.writeText(text).then(copied, () => {
      // No clipboard permission (e.g. ?bench=1 without a click): select it.
      this.result.select();
      try {
        if (document.execCommand('copy')) copied();
        else this.flash('select and copy the text below');
      } catch {
        this.flash('select and copy the text below');
      }
    });
  }

  flash(msg) {
    const head = this.el.querySelector('.perf-head b');
    head.textContent = `perf · ${msg}`;
    setTimeout(() => (head.textContent = 'perf'), 4000);
  }

  dispose() {
    clearInterval(this.timer);
    this.el.remove();
  }
}
