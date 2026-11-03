// Records the fleet-scope walkthrough: the fleet, a workload, an earlier
// incident's thread, then a live bad-image incident from the button press to
// the agent's PR, the merge and the heal, and a reset. Real state changes:
// the press and the reset commit to the fleet repo; the merge uses gh.
//
//   LD_LIBRARY_PATH=$HOME/.local/lib/chromium-deps node video/record.mjs
//   LD_LIBRARY_PATH=$HOME/.local/lib/chromium-deps PART=<x> node video/record.mjs   (retake)
// Then: DEMO_OUT=video/out python3 ~/.claude/skills/record-demo-video/edit.py
import { chromium } from '/home/user/projects/substrate-scope/node_modules/playwright/index.mjs';
import { execSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readdirSync, renameSync } from 'node:fs';

const OUT = new URL('./out', import.meta.url).pathname;
const SERVE = new URL('./serve-local.sh', import.meta.url).pathname;
const URL_ = 'http://127.0.0.1:18081/';
const REPO = 'gke-demos/kcna26-fleet-gitops';
const TARGET = process.env.TARGET || 'checkoutservice';
const KEY = `boutique-prod/${TARGET}`;
const PEEK_KEY = 'bank-prod/ledger-db';
const PART = process.env.PART || 'all';
const SUFFIX = PART === 'all' ? '' : `-${PART}`;
const MIN = 60000;
mkdirSync(OUT, { recursive: true });

const markers = [];
let T0 = 0;
const now = () => (Date.now() - T0) / 1000;
const mark = (name, speed = 1) => { markers.push({ name, t: now(), speed }); console.log(`[${now().toFixed(1)}s] ${name}${speed !== 1 ? ` (x${speed})` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd) => execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const bg = (cmd) => spawn('bash', ['-c', cmd], { stdio: 'ignore', detached: true }).unref();

const overlay = () => {
  const css = `
    #__cap{position:fixed;left:50%;bottom:44px;transform:translateX(-50%);max-width:1300px;padding:14px 26px;
      background:rgba(8,12,20,.86);color:#f0f6fc;font:600 26px/1.35 system-ui,sans-serif;border:1px solid rgba(88,166,255,.55);
      border-radius:12px;z-index:2147483647;pointer-events:none;text-align:center;transition:opacity .35s;opacity:0}
    #__cap small{display:block;font-weight:500;font-size:19px;color:#9fb8d4;margin-top:4px}
    #__card{position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;
      background:rgba(5,8,14,.9);color:#f0f6fc;z-index:2147483646;pointer-events:none;font-family:system-ui,sans-serif;transition:opacity .5s;opacity:0}
    #__card h1{font-size:56px;margin:0} #__card p{font-size:26px;color:#9fb8d4;margin:0}
    #__cur{position:fixed;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;border:3px solid #f0b72f;
      background:rgba(240,183,47,.25);z-index:2147483647;pointer-events:none;transition:transform .12s;left:-50px;top:-50px}
    #__cur.down{transform:scale(.7);background:rgba(240,183,47,.7)}`;
  const add = () => {
    if (document.getElementById('__cap')) return;
    const s = document.createElement('style'); s.textContent = css; document.head.appendChild(s);
    for (const id of ['__cap', '__card', '__cur']) { const d = document.createElement('div'); d.id = id; document.body.appendChild(d); }
    addEventListener('mousemove', (e) => { const c = document.getElementById('__cur'); c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; }, true);
    addEventListener('mousedown', () => document.getElementById('__cur').classList.add('down'), true);
    addEventListener('mouseup', () => document.getElementById('__cur').classList.remove('down'), true);
  };
  window.__cap = (html) => { add(); const c = document.getElementById('__cap'); if (!html) { c.style.opacity = 0; return; } c.innerHTML = html; c.style.opacity = 1; };
  window.__card = (html) => { add(); const c = document.getElementById('__card'); if (!html) { c.style.opacity = 0; return; } c.innerHTML = html; c.style.opacity = 1; };
  if (document.readyState !== 'loading') add(); else addEventListener('DOMContentLoaded', add);
};

// The local console (same code, live data) unless it is already up.
try { sh(`curl -sf ${URL_}healthz`); } catch {
  console.log('starting the local console');
  bg(`bash ${SERVE} > /tmp/fleet-scope-video.log 2>&1`);
  for (let i = 0; i < 120; i++) { try { sh(`curl -sf ${URL_}healthz`); break; } catch { await sleep(1000); } }
}

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, recordVideo: { dir: OUT, size: { width: 1920, height: 1080 } } });
await ctx.addInitScript(overlay);
const page = await ctx.newPage();
page.on('dialog', (d) => d.accept());
T0 = Date.now();
page.on('pageerror', (e) => console.log('pageerror:', String(e).slice(0, 200)));

const cap = (html) => page.evaluate((h) => window.__cap(h), html).catch(() => {});
const card = (html) => page.evaluate((h) => window.__card(h), html).catch(() => {});
async function waitFor(fn, arg, timeoutMs, everyMs = 2000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { try { const v = await page.evaluate(fn, arg); if (v) return v; } catch {} await sleep(everyMs); }
  return null;
}
async function glide(locator) {
  const box = await locator.boundingBox();
  if (!box) { await locator.click(); return; }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 25 });
  await sleep(300);
  await page.mouse.down(); await sleep(120); await page.mouse.up();
}
// A signal about KEY of type t, since the press (with a minute of clock slack).
const since = (t) => ({ key: KEY, t, after: pressAt - MIN });
const signal = ({ key, t, after }) => window.scope.signalEvents.find((e) => e.key === key && e.type === t && Date.parse(e.time) >= after);
const state = (key) => window.scope.model.agents.get(key)?.state;
let pressAt = 0;
let prNumber = '';

try {
  await page.goto(URL_, { waitUntil: 'load' });
  await waitFor(() => window.scope?.model?.agents?.size > 30, null, MIN, 500);
  await sleep(6000); // first frames, labels settle

  if (PART === 'all' || PART === 'intro') {
    mark('title');
    await card('<h1>kube-agents at KubeCon NA 2026</h1><p>fleet-scope: the fleet, and the agents working on it, live</p>');
    await sleep(6000);
    await card(null);

    mark('fleet');
    await cap('Three GKE clusters, one fleet<small>boutique-prod runs Online Boutique, bank-prod runs Bank of Anthos, kube-agents-hub runs the agents</small>');
    await sleep(9000);

    mark('agents');
    await cap('kube-agents: a Planning Agent, a Platform Agent, a Cluster Agent per cluster<small>Each cluster is watched by its own read-only Cluster Agent; alerts go out through Slack</small>');
    await page.mouse.move(1150, 760, { steps: 30 });
    await sleep(9000);

    mark('workload');
    await cap('Every workload, live from the clusters<small>Click one for its health, replicas, image and memory limit</small>');
    await page.evaluate((k) => window.scope.select(k), PEEK_KEY);
    await sleep(8000);
    await page.keyboard.press('Escape');
    await page.click('#home').catch(() => {});
    await sleep(2000);

    mark('feed');
    await cap('Fleet activity, from Slack and GitHub<small>Alerts, the agents\' notes, audits and pull requests, each linking back to where it happened</small>');
    await page.mouse.move(200, 420, { steps: 30 });
    await sleep(8000);
  }

  if (PART === 'all' || PART === 'incident') {
    mark('press');
    await cap('Break something: roll out an image tag that does not exist<small>The button commits to the fleet repo, exactly how a bad change would arrive</small>');
    await page.locator(`select[data-for="trigger-badimage"]`).selectOption(TARGET).catch(() => {});
    await sleep(1200);
    pressAt = Date.now();
    await glide(page.locator('button[data-run="trigger-badimage"]'));
    await sleep(7000);

    mark('sync-and-fail', 3);
    await cap('Config Sync applies the commit and the rollout fails<small>The tracker follows every step (sped up)</small>');
    await waitFor((k) => window.scope.model.agents.get(k)?.state === 'CRASHED', KEY, 4 * MIN);
    await sleep(3000);

    mark('alert', 2);
    await cap('The event watcher sees the failed pull and alerts at once<small>A bad tag never fixes itself, so there is no debounce (sped up)</small>');
    // The keyed alert, or else the first keyed note of its thread.
    const first = await waitFor((a) => {
      const s = window.scope.signalEvents;
      return s.find((e) => e.key === a.key && e.type === 'alert' && Date.parse(e.time) >= a.after)
        || s.find((e) => e.key === a.key && e.type === 'triage' && e.thread && Date.parse(e.time) >= a.after);
    }, since('alert'), 4 * MIN, 1000);
    await sleep(3000);

    mark('investigate', 6);
    await cap('The Cluster Agent investigates, read-only<small>Its notes stream into the Slack thread and the console (sped up)</small>');
    if (first?.thread) await page.evaluate((t) => window.scope.openThread(t), first.thread);
    await waitFor(signal, since('triage_report'), 12 * MIN, 3000);
    await sleep(2000);

    mark('report');
    await cap('The diagnosis: what is wrong, why, and the options<small>The recommended fix is highlighted; the evidence (the commands it ran) folds underneath</small>');
    await sleep(14000);

    mark('pr', 8);
    await cap('It opens the recommended fix as a pull request<small>Nothing touches the cluster until a person merges (sped up)</small>');
    const pr = await waitFor(signal, since('pr_opened'), 8 * MIN, 3000);
    prNumber = (pr?.link || '').split('/').pop();
    await sleep(3000);

    mark('merge');
    await cap('A person reviews and merges<small>The only way anything changes: a commit to the fleet repo</small>');
    if (prNumber) sh(`gh pr merge ${prNumber} -R ${REPO} --merge`);
    await sleep(6000);

    mark('heal', 3);
    await cap('Config Sync applies the fix and the workload heals<small>(sped up)</small>');
    await waitFor((k) => window.scope.model.agents.get(k)?.state === 'RUNNING', KEY, 6 * MIN);
    await sleep(6000);
    await page.evaluate(() => window.scope.closeThread()).catch(() => {});
    await sleep(3000);
  }

  if (PART === 'all' || PART === 'reset') {
    mark('reset', 2);
    await cap('One button puts the demo back<small>Reset restores the fleet repo\'s baseline and closes leftover incident PRs</small>');
    await glide(page.locator('button[data-run="reset"]'));
    await waitFor(() => document.querySelector('#tracker .trk.reset.done'), null, 3 * MIN);
    await sleep(5000);
  }

  mark('end');
  await cap(null);
  await card('<h1>kube-agents</h1><p>github.com/gke-labs/kube-agents · demo: github.com/gke-demos/kcna26-kube-agents</p>');
  await sleep(6000);
  mark('done');
} catch (e) {
  console.log('ERROR:', e.message);
  mark('error');
} finally {
  writeFileSync(`${OUT}/markers${SUFFIX}.json`, JSON.stringify({ markers, prNumber }, null, 2));
  await ctx.close();
  await browser.close();
  const vid = readdirSync(OUT).find((f) => f.endsWith('.webm') && f.startsWith('page@'));
  if (vid) renameSync(`${OUT}/${vid}`, `${OUT}/raw${SUFFIX}.webm`);
  console.log('wrote', `${OUT}/raw${SUFFIX}.webm`);
}
