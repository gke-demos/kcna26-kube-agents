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

// Wires the stream, the model, the scene, the filters, the event feed and
// the side panel together.

import { Model, CLASSES, CLASS_LABEL, makeFilter, stateClass, isSignal } from './model.js';
import { Stream, streamURL } from './stream.js';
import { Scene, cssColor } from './scene.js';
import { Panel } from './panel.js';
import { esc, duration, since, clock, workerLabel, compact, ago } from './format.js';
import { describe, describeSignal, stateWords } from './feed.js';
import { SyntheticStream, syntheticOptions } from './synth.js';
import { FleetSynthStream } from './fleet-synth.js';
import { ControlPanel, httpActions } from './controls.js';
import { SIGNAL_ICON, SIGNAL_LABEL, signalColor } from './signals-ui.js';
import { ThemePicker } from './theming.js';
import { LookPicker, initialLooks, rememberGroup, rememberLayout, rememberBeams, storedDecks, storeDecks } from './looks.js';
import { DECK_KEYS, layoutId, beamModeId, scrollModeId } from './decks.js';
import { inkOn } from './themes.js';
import { PerfOverlay } from './perf.js';
import { ControlsTour } from './tour-ui.js';
import { ThreadDrawer } from './drawer.js';
import { latestThread } from './thread.js';
import { TrackerStack } from './tracker-ui.js';

const $ = (sel) => document.querySelector(sel);
/** Short state names for the header chips on narrower screens. */
const CLASS_ABBR = { running: 'OK', transition: 'Roll', suspended: 'Zero', crashed: 'Fail', pending: 'Pend' };
/** The header pill that always shows when the links carry it. */
const SLACK_LINK = 'Slack #platform-ops';

const model = new Model();
const filterState = { atespace: '', classes: new Set(CLASSES), prefix: '' };
let selected = null;
/** Events seen per type (for tests and screenshot tooling). */
const eventCounts = {};

const looks0 = initialLooks();
const params = new URLSearchParams(window.location.search);
const scene = new Scene(
  $('#viewport'),
  {
    onPick: (key, worker) => pick(key, worker),
    onHover: (key, x, y) => hover(key, x, y),
    onHoverWorker: (name) => {
      hoverWorker = name;
      updateCursor();
    },
    onHoverTile: (tile, info) => hoverTile(tile, info),
    onDeckHandle: (h) => {
      deckHandle = h;
      updateCursor();
    },
    onDrag: (kind) => {
      dragKind = kind;
      updateCursor();
    },
    onDecksChanged: (o) => {
      storeDecks(o);
      showDeckLink();
    },
  },
  {
    shape: looks0.agents,
    router: looks0.router,
    extras: looks0.extras,
    group: looks0.group,
    layout: looks0.layout,
    beams: looks0.beams,
    budget: Number(params.get('budget')) || undefined,
    quality: params.get('quality') || 'auto',
  },
);
let hoverWorker = null;
let deckHandle = null;
let dragKind = null;
// Deck offsets and the link state from the last visit.
scene.setDeckOffsets(storedDecks());

/** The pointer: grabbing while dragging, move over a deck's rim, pointer over an agent or worker. */
function updateCursor() {
  let c = '';
  if (dragKind === 'deck') c = 'grabbing';
  else if (dragKind === 'pan') c = 'move';
  else if (deckHandle) c = 'move';
  else if (hovered || hoverWorker) c = 'pointer';
  document.body.style.cursor = c;
}
// ?synthetic=1 replaces the collector with the scripted demo fleet (and fake
// action buttons); ?synthetic=N (N > 1) with N generated agents for scale
// checks.
const synthParam = params.get('synthetic');
const synthetic = Number(synthParam) > 1 ? Number(synthParam) : 0;
const fleetSynth = synthParam !== null && !synthetic && synthParam !== '0';
scene.setFakeActivity(synthetic > 0);

// Router look and agent shape: switch live, remembered.
const looks = new LookPicker(
  { router: $('#router-pick'), agents: $('#agents-pick') },
  {
    onRouter: (id) => scene.setRouter(id),
    onAgents: (id) => scene.setAgentShape(id),
    onExtras: (on) => scene.setExtras(on),
  },
);

const panel = new Panel($('#panel'), {
  onClose: () => select(null),
  onShowWorker: (name) => {
    scene.pinWorker(name);
    scene.flyToWorker(name);
  },
  agent: (key) => model.agents.get(key),
  worker: (name) => model.workers.get(name),
  signals: (key) => signalsFor(key),
  threadFor: (key) => latestThread(signalEvents, key),
  onThread: (thread) => openThread(thread),
  iconStyle: (sig) => {
    const c = signalColor(currentTheme || themes.theme, sig);
    return `--c:${c};--ci:${inkOn(c)}`;
  },
});

/** Paints a signal icon in the theme's color for its type. */
function paintSignal(el, sig) {
  const c = signalColor(currentTheme || themes.theme, sig);
  el.style.setProperty('--c', c);
  el.style.setProperty('--ci', inkOn(c));
}
let currentTheme = null;

// Themes: switching re-colors the page (CSS variables), the scene, the open
// panel and the state- and signal-colored feed icons.
const themes = new ThemePicker($('#themes'), (t) => {
  currentTheme = t;
  scene.setTheme(t);
  if (selected) panel.agentChanged();
  document.querySelectorAll('#feed .item[data-state] .icon').forEach((el) => {
    const c = cssColor(el.closest('.item').dataset.state);
    el.style.setProperty('--c', c);
    el.style.setProperty('--ci', inkOn(c));
  });
  document.querySelectorAll('[data-sig] > .icon').forEach((el) => paintSignal(el, el.parentElement.dataset.sig));
}, { onTourStep: () => looks.tourStep() });

// The control panel: only for users the collector lets press buttons.
let stream = null;
const controls = new ControlPanel(
  $('#controls'),
  {
    actions: () => (fleetSynth ? stream.actions() : httpActions.actions()),
    runAction: (name, target) => (fleetSynth ? stream.runAction(name, target) : httpActions.runAction(name, target)),
  },
  {
    // Every press gets an incident tracker card, from "Pushing change…" on.
    onPress: (a, target) => trackers.pressed(a.name, a.title, target),
    onResult: (id, res) => trackers.answered(id, res),
    onError: (id, err) => trackers.failed(id, err),
  },
);

// Header links (features.links): small pills that open in a new tab; the
// Slack channel first.
function renderLinks(links) {
  const el = $('#links');
  const list = [...(links || [])].filter((l) => l && l.url && /^https?:/i.test(l.url));
  list.sort((a, b) => (b.name === SLACK_LINK) - (a.name === SLACK_LINK));
  const html = list.map((l) => `<a class="pill${l.name === SLACK_LINK ? ' slack' : ''}" href="${esc(l.url)}" target="_blank" rel="noopener" title="${esc(l.url)}">${esc(l.name)} <span class="ext">↗</span></a>`).join('');
  if (el.innerHTML !== html) el.innerHTML = html;
}

// ----------------------------------------------------------------- signals

// Signals seen (newest first), for the panel's incident list; ids already
// in the feed, so a reconnect's snapshot doesn't repeat them.
const SIGNALS_MAX = 300;
const signals = [];
const signalSeen = new Set();
// The signal events themselves (oldest first), for the thread view: the
// feed's lines keep only what a line shows.
const SIGNAL_EVENTS_MAX = 1000;
const signalEvents = [];

function signalsFor(key) {
  return signals.filter((s) => s.key === key);
}

/** Records a signal event and its line, and feeds it; false when the feed already has it. */
function addSignal(e) {
  const item = describeSignal(e);
  if (signalSeen.has(item.id)) return false;
  signalSeen.add(item.id);
  signals.unshift(item);
  if (signals.length > SIGNALS_MAX) signalSeen.delete(signals.pop().id);
  signalEvents.push(e);
  if (signalEvents.length > SIGNAL_EVENTS_MAX) signalEvents.shift();
  feed(item);
  return true;
}

// ------------------------------------------------------------ thread view

// An incident's Slack thread in a drawer on the right. It takes the side
// panel's slot: while it is open the panel hides, and "← workload details"
// brings the panel back.
const drawer = new ThreadDrawer($('#drawer'), {
  events: () => signalEvents,
  agent: (key) => model.agents.get(key),
  healthy: (key) => stateClass(model.agents.get(key)?.state) === 'running',
  onClose: () => closeThread(),
  onDetails: (key) => {
    closeThread();
    select(key, false);
  },
});

// The incident tracker: one card per press, top center (tracker-ui.js).
const trackers = new TrackerStack($('#tracker'), {
  model: () => model,
  signals: () => signalEvents,
  onThread: (thread, key) => {
    if (key && model.agents.has(key)) select(key, false);
    openThread(thread);
  },
  onSelect: (key) => model.agents.has(key) && select(key, true),
  resolveKey: (target) => [...model.agents.keys()].find((k) => k.endsWith(`/${target}`)) || '',
  actionTitle: (name) => controls.titleOf(name),
  dock: () => $('#controls'),
});

function openThread(thread) {
  if (!thread) return;
  drawer.open(thread);
  document.body.classList.add('drawer-open');
}

function closeThread() {
  drawer.close();
  document.body.classList.remove('drawer-open');
}

// ------------------------------------------------------------------ stream

const streamHandlers = {
  onStatus: (s) => {
    const el = $('#conn');
    el.className = `conn ${s}`;
    el.querySelector('.txt').textContent = s;
  },
  onSnapshot: (snap, resync) => {
    model.applySnapshot(snap);
    scene.setModel(model);
    if (resync) feed({ type: 'meta', text: 'resynced from a fresh snapshot' });
    else {
      const c = model.counts();
      feed({ type: 'meta', text: `connected to <b>${esc(model.cluster)}</b>: ${model.agents.size} workloads on ${model.atespaces.size} clusters, ${c.running} healthy${c.crashed ? `, ${c.crashed} failing` : ''}` });
    }
    // The latest signals, oldest first: into the feed without replaying
    // their effects (the ones already shown are skipped).
    for (const e of model.recent) if (isSignal(e)) addSignal(e);
    drawer.eventsChanged(null);
    controls.setEnabled(model.features?.actions);
    renderLinks(model.features?.links);
    refreshChrome(true);
    if (selected && !model.agents.has(selected)) select(null);
    else if (selected) panel.agentChanged();
    const want = initialSelection();
    if (want && !selected && model.agents.has(want)) select(want, true);
    trackers.refresh();
  },
  onEvents: (events) => {
    if (!model.applyEvents(events)) return false;
    for (const e of events) eventCounts[e.type] = (eventCounts[e.type] || 0) + 1;
    scene.applyEvents(events);
    // Signals go straight in (they are few and they are the story);
    // workload changes are batched.
    const sigEvents = events.filter((e) => isSignal(e) && addSignal(e));
    const sigs = sigEvents.length > 0;
    queueFeed(describe(events.filter((e) => !isSignal(e))));
    refreshChrome();
    if (sigs) drawer.eventsChanged(sigEvents);
    trackers.onEvents(events);
    if (drawer.key && events.some((e) => e.key === drawer.key && !isSignal(e))) drawer.agentChanged(drawer.key);
    if (selected) {
      const a = model.agents.get(selected);
      if (!a) select(null);
      else if (events.some((e) => e.key === selected && !isSignal(e))) panel.agentChanged(a);
      if (sigs) panel.signalsChanged();
    }
    return true;
  },
};
// &incident=N starts the first scripted incident after N seconds (default 4).
if (fleetSynth) stream = new FleetSynthStream(streamHandlers, params.has('incident') ? { first: Math.max(0, Number(params.get('incident')) || 0) } : {});
else if (synthetic > 0) stream = new SyntheticStream(synthetic, streamHandlers, syntheticOptions(params));
else stream = new Stream(streamURL(), streamHandlers);

function initialSelection() {
  const m = /[#&]agent=([^&]+)/.exec(window.location.hash);
  return m ? decodeURIComponent(m[1]) : null;
}

// --------------------------------------------------------------- selection

/** A click in the scene: an agent selects it, a worker pad pins (or unpins) it, empty space clears both. */
function pick(key, worker) {
  if (key) {
    scene.pinWorker(null);
    select(key, false);
  } else if (worker) {
    scene.pinWorker(scene.pinnedWorker === worker ? null : worker);
  } else {
    scene.pinWorker(null);
    select(null);
  }
}

// Group by atespace or by worker (header toggle, g, ?group=; remembered).
function setGroup(mode, remember = true) {
  scene.setGroup(mode);
  document.querySelectorAll('#group button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.group === scene.group)));
  if (remember) rememberGroup(scene.group);
}
$('#group').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-group]');
  if (b) setGroup(b.dataset.group);
});
setGroup(looks0.group, false);

// Layout: two decks or one island (header toggle, ?layout=; remembered).
// The decks group by atespace, so the grouping toggle hides there.
function setLayout(id, remember = true) {
  scene.setLayout(layoutId(id));
  document.querySelectorAll('#layout button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.layout === scene.layout)));
  document.body.classList.toggle('layout-decks', scene.layout === 'decks');
  document.querySelectorAll('#group button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.group === scene.group)));
  if (remember) rememberLayout(scene.layout);
}
$('#layout').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-layout]');
  if (b) setLayout(b.dataset.layout);
});
setLayout(looks0.layout, false);

// Decks: linked or independent moves (chain button, Shift+L), reset (button, r).
function showDeckLink() {
  const on = scene.decksLinked;
  const b = $('#deck-link');
  b.setAttribute('aria-pressed', String(on));
  b.classList.toggle('unlinked', !on);
  b.title = on
    ? 'Decks linked: dragging a deck moves both (Shift+L to unlink). Drag a deck by its rim or Option/Alt-drag it; hold Shift while dragging to change its height'
    : 'Decks unlinked: each deck moves on its own (Shift+L to link). Drag a deck by its rim or Option/Alt-drag it; hold Shift while dragging to change its height';
}
$('#deck-link').addEventListener('click', () => scene.setDecksLinked(!scene.decksLinked));
$('#deck-reset').addEventListener('click', () => scene.resetDecks());
showDeckLink();

// Beams: focus (default) or all (header toggle, ?beams=; remembered).
function setBeams(mode, remember = true) {
  scene.setBeamMode(beamModeId(mode));
  document.querySelectorAll('#beams button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.beams === scene.beamMode)));
  if (remember) rememberBeams(scene.beamMode);
}
$('#beams').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-beams]');
  if (b) setBeams(b.dataset.beams);
});
setBeams(looks0.beams, false);

function select(key, fly = true) {
  // Another workload (or none) takes the slot back from the thread view.
  if (drawer.isOpen && key !== drawer.key) closeThread();
  selected = key;
  scene.select(key);
  if (key) {
    panel.show(key);
    if (fly) scene.flyTo(key);
    history.replaceState(null, '', `#agent=${encodeURIComponent(key)}`);
  } else {
    panel.hide();
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }
  document.body.classList.toggle('panel-open', !!key);
}

const tip = $('#tooltip');
/** A far tile under the pointer (decks): what flows through it. */
function hoverTile(tile, info) {
  if (!tile || !info) {
    if (!hovered) tip.style.display = 'none';
    return;
  }
  const at = scene.hoverAt;
  if (!at) return;
  tip.style.display = 'block';
  tip.style.left = `${at.x + 14}px`;
  tip.style.top = `${at.y + 14}px`;
  tip.innerHTML =
    tile.kind === 'atespace'
      ? `<div class="t-name">cluster <b>${esc(tile.name)}</b></div><div>${compact(info.total)} workloads · ${compact(info.agents)} watched</div>`
      : `<div class="t-name"><b>${esc(tile.name)}</b></div><div>${compact(info.workers)} agents · watching ${compact(info.agents)} workloads</div><div class="muted">in ${info.ends} cluster${info.ends === 1 ? '' : 's'}</div>`;
}
let hovered = null;
function hover(key, x, y) {
  const a = key && model.agents.get(key);
  hovered = a ? key : null;
  updateCursor();
  if (!a) {
    if (!scene.hoverTile) tip.style.display = 'none';
    return;
  }
  tip.style.display = 'block';
  tip.style.left = `${x + 14}px`;
  tip.style.top = `${y + 14}px`;
  const wk = a.worker && model.workers.get(a.worker);
  const replicas = a.replicas || a.ready ? ` · ${a.ready ?? 0}/${a.replicas ?? 0} ready` : '';
  tip.innerHTML = `<div class="t-name">${esc(a.atespace)}/<b>${esc(a.name)}</b></div>
    <div><span class="dot" style="background:${cssColor(a.state)}"></span>${esc(stateWords(a))} for ${duration(since(a.stateSince))}</div>
    ${a.kind || a.namespace ? `<div class="muted">${esc(a.kind || 'workload')}${a.namespace ? ` in ${esc(a.namespace)}` : ''}${replicas}</div>` : ''}
    ${a.worker ? `<div class="muted">watched by ${esc(wk ? workerLabel(wk) : a.worker)}</div>` : ''}`;
}

// ----------------------------------------------------------------- filters

function applyFilters() {
  const all = filterState.classes.size === CLASSES.length;
  scene.setFilter(makeFilter({ atespace: filterState.atespace, classes: all ? null : filterState.classes, prefix: filterState.prefix }));
  document.querySelectorAll('#legend .chip').forEach((el) => {
    el.classList.toggle('off', !filterState.classes.has(el.dataset.cls));
  });
}

$('#atespace').addEventListener('change', (e) => {
  filterState.atespace = e.target.value;
  applyFilters();
});
$('#prefix').addEventListener('input', (e) => {
  filterState.prefix = e.target.value;
  applyFilters();
});
$('#prefix').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  // Enter flies to the first match.
  const f = makeFilter({ atespace: filterState.atespace, prefix: filterState.prefix });
  const hit = [...model.agents.entries()].find(([, a]) => f(a));
  if (hit) select(hit[0], true);
});
$('#legend').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  const cls = chip.dataset.cls;
  const s = filterState.classes;
  if (e.shiftKey || e.metaKey) {
    // Shift-click: only this class (or back to all).
    if (s.size === 1 && s.has(cls)) CLASSES.forEach((c) => s.add(c));
    else {
      s.clear();
      s.add(cls);
    }
  } else if (s.has(cls)) s.delete(cls);
  else s.add(cls);
  if (!s.size) CLASSES.forEach((c) => s.add(c));
  applyFilters();
});
document.addEventListener('keydown', (e) => {
  const typing = document.activeElement?.tagName === 'INPUT';
  if (e.key === 'Escape') {
    // Esc closes the thread view first, then the selection.
    if (drawer.isOpen) closeThread();
    else {
      scene.pinWorker(null);
      select(null);
    }
  }
  if (e.key === 'g' && !typing && scene.layout !== 'decks') setGroup(scene.group === 'worker' ? 'atespace' : 'worker');
  if (e.key === '/' && !typing) {
    e.preventDefault();
    $('#prefix').focus();
  }
  if (e.key === 'f' && !typing && selected) scene.flyTo(selected);
  if (e.key === 'h' && !typing) scene.fitCamera();
  if (e.key === 'l' && !typing) cycleLabels();
  if (e.key === 'e' && !typing) setFeedCollapsed(!feedCollapsed());
  if (e.key === 'x' && !typing) looks.toggleExtras();
  // Decks: 1 agent deck only, 2 worker deck only, 3 both.
  if (DECK_KEYS[e.key] && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) scene.setDeckView(DECK_KEYS[e.key]);
  // b switches the beams between focus and all.
  if (e.key === 'b' && !typing && !e.metaKey && !e.ctrlKey && scene.layout === 'decks') setBeams(scene.beamMode === 'focus' ? 'all' : 'focus');
  // Shift+L links or unlinks the decks; r resets their layout.
  if (e.key === 'L' && !typing && scene.layout === 'decks') scene.setDecksLinked(!scene.decksLinked);
  if ((e.key === 'r' || e.key === 'R') && !typing && !e.metaKey && !e.ctrlKey && scene.layout === 'decks') scene.resetDecks();
  // Arrow keys pan the view (Shift: further).
  const arrow = { ArrowLeft: [1, 0], ArrowRight: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[e.key];
  if (arrow && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    const step = e.shiftKey ? 180 : 60;
    scene.panScreen(arrow[0] * step, arrow[1] * step, scene.camera.position.distanceTo(scene.controls.target));
  }
});
$('#home').addEventListener('click', () => scene.fitCamera());

// ------------------------------------------------------------------ chrome

// The header (counts per state, totals) refreshes at most four times a
// second: at 1,000 changes a second, recounting per batch costs frames.
let chromeTimer = null;
function refreshChrome(now = false) {
  if (!now) {
    chromeTimer ??= setTimeout(() => {
      chromeTimer = null;
      refreshChrome(true);
    }, 250);
    return;
  }
  $('#cluster').textContent = model.cluster || '';
  const counts = model.counts();
  // Counts stay short (12.3k) so the header keeps to one row at 100,000 agents.
  // Healthy and failing always show; the other states only while some
  // workload is in them (or their filter is off), so the header keeps room
  // for the link pills.
  const legendClasses = CLASSES.filter((c) => c === 'running' || c === 'crashed' || counts[c] > 0 || !filterState.classes.has(c));
  $('#legend').innerHTML = legendClasses.map(
    (c) => `<button class="chip ${c}${filterState.classes.has(c) ? '' : ' off'}" data-cls="${c}" title="${CLASS_LABEL[c]}: ${counts[c].toLocaleString('en-US')}. Click to toggle, shift-click to show only this">
      <span class="sw"></span><span class="lbl">${CLASS_LABEL[c]}</span><span class="ab">${CLASS_ABBR[c]}</span><b>${compact(counts[c])}</b></button>`,
  ).join('');
  $('#total').textContent = `${model.agents.size} workloads · ${model.atespaces.size} clusters · ${model.workers.size} kube-agents agents`;
  const sel = $('#atespace');
  const names = [...model.atespaces.keys()].sort();
  const want = ['', ...names].join('|');
  if (sel.dataset.names !== want) {
    sel.dataset.names = want;
    sel.innerHTML = `<option value="">All clusters</option>${names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('')}`;
    sel.value = filterState.atespace;
  }
  const bad = (model.sources || []).filter((s) => !s.ok);
  $('#health').innerHTML = bad.length
    ? `<span class="warn" title="${esc(bad.map((s) => `${s.name}: ${s.error}`).join('\n'))}">⚠ ${bad.map((s) => esc(s.name)).join(', ')}</span>`
    : '';
  $('#seq').textContent = `seq ${model.seq}`;
}

// -------------------------------------------------------------------- feed

// The live event feed: a collapsible panel on the left, newest on top.
const FEED_MAX = 200;
const FEED_ICON = { added: '+', woke: '↑', suspended: '↓', crashed: '✕', task: '◆', removed: '−', state: '→', worker: '▣', meta: '•' };
const feedEl = $('#feed');
let feedTotal = 0;
let feedUnread = 0;

function feedCollapsed() {
  return document.body.classList.contains('feed-collapsed');
}

function setFeedCollapsed(on) {
  document.body.classList.toggle('feed-collapsed', on);
  try {
    localStorage.setItem('fleet-scope:feed-collapsed', on ? '1' : '0');
  } catch {
    /* storage blocked: still works for this page */
  }
  if (!on) feedUnread = 0;
  updateFeedCounts();
  scene.setLeftInset(feedInset());
}

/** Width the open events panel covers, for framing the island beside it. */
function feedInset() {
  if (feedCollapsed()) return 0;
  const r = $('#feedpanel').getBoundingClientRect();
  return r.right + 12;
}

function updateFeedCounts() {
  $('#feedcount').textContent = feedTotal ? `${feedTotal}` : '';
  $('#feed-unread').textContent = feedUnread ? String(feedUnread > 99 ? '99+' : feedUnread) : '';
}

// Events reach the feed at most a few times a second. A busy cluster
// changes hundreds of agents a second; the feed shows the latest few of
// each batch (crashes first) and a summary line for the rest.
const FEED_EVERY = 400;
const FEED_BURST = 8;
let feedQueue = [];
let feedTimer = null;
function queueFeed(items) {
  feedQueue.push(...items);
  feedTimer ??= setTimeout(flushFeed, FEED_EVERY);
}

function flushFeed() {
  feedTimer = null;
  const q = feedQueue;
  feedQueue = [];
  if (q.length <= FEED_BURST) {
    q.forEach(feed);
    return;
  }
  const crashed = q.filter((i) => i.type === 'crashed');
  const keep = [...crashed.slice(-FEED_BURST / 2), ...q.filter((i) => i.type !== 'crashed' && i.type !== 'worker').slice(-FEED_BURST)].slice(-FEED_BURST);
  const n = {};
  for (const i of q) n[i.type] = (n[i.type] || 0) + 1;
  const parts = [['woke', 'scaled up'], ['suspended', 'scaled to 0'], ['crashed', 'failing'], ['added', 'added'], ['removed', 'removed'], ['state', 'changed health'], ['worker', 'agent updates']]
    .filter(([k]) => n[k])
    .map(([k, label]) => `${n[k]} ${label}`);
  feed({ type: 'meta', text: `${q.length - keep.length} more events: ${parts.join(', ')}` });
  keep.forEach(feed);
}

/** A signal's feed line: icon, title, actor, relative time, and a ↗ to Slack or GitHub. */
function signalLine(div, item) {
  div.className = `item signal sig-${item.sig}${item.thread && item.sig !== 'alert' ? ' reply' : ''}${item.failed ? ' failed' : ''}`;
  div.dataset.sig = item.sig;
  const name = item.key.split('/').slice(1).join('/');
  const where = name && !item.title.includes(name) ? `<b>${esc(name)}</b>: ` : '';
  const link = item.link ? ` <a class="ext" href="${esc(item.link)}" target="_blank" rel="noopener" title="Open in a new tab">↗</a>` : '';
  const t = item.time || new Date().toISOString();
  const thread = item.thread ? '<span class="thread-tag" title="Open the Slack thread">thread ›</span>' : '';
  div.innerHTML = `<span class="icon" title="${esc(SIGNAL_LABEL[item.sig] || item.sig)}">${SIGNAL_ICON[item.sig] || '•'}</span>
    <span class="body"><span class="txt">${where}${item.text}${link}</span><span class="ts">${item.actor ? `<span class="who">${esc(item.actor)}</span> · ` : ''}<span data-ago="${esc(t)}" title="${esc(new Date(t).toLocaleString())}">${esc(ago(t))}</span>${thread}</span></span>`;
  paintSignal(div.querySelector('.icon'), item.sig);
  div.querySelector('a.ext')?.addEventListener('click', (e) => e.stopPropagation());
}

function feed(item) {
  const div = document.createElement('div');
  if (item.type === 'signal') signalLine(div, item);
  else {
    const type = FEED_ICON[item.type] ? item.type : 'meta';
    div.className = `item ${type}`;
    const now = new Date();
    const color = type === 'state' && item.state ? cssColor(item.state) : '';
    if (color) div.dataset.state = item.state;
    div.innerHTML = `<span class="icon"${color ? ` style="--c:${color};--ci:${inkOn(color)}"` : ''}>${FEED_ICON[type]}</span>
      <span class="body"><span class="txt">${item.text}</span><span class="ts" title="${esc(now.toLocaleString())}">${clock(now.toISOString())}</span></span>`;
  }
  if (item.thread) {
    // A line in an incident's thread opens the thread (and flies to the workload).
    div.classList.add('link');
    div.title = item.key ? 'Open the Slack thread and fly to this workload' : 'Open the Slack thread';
    div.addEventListener('click', () => {
      if (item.key && model.agents.has(item.key)) select(item.key, true);
      openThread(item.thread);
    });
  } else if (item.key) {
    div.classList.add('link');
    div.title = 'Select and fly to this workload';
    div.addEventListener('click', () => model.agents.has(item.key) && select(item.key, true));
  }
  // Newest on top. If the user has scrolled down to read older events,
  // keep what they are reading where it is.
  const keep = feedEl.scrollTop > 0;
  feedEl.prepend(div);
  if (keep) feedEl.scrollTop += div.offsetHeight;
  while (feedEl.children.length > FEED_MAX) feedEl.lastChild.remove();
  feedTotal++;
  if (feedCollapsed() && item.type !== 'meta') feedUnread++;
  updateFeedCounts();
}

// Relative times ("5m ago") in the feed stay current.
setInterval(() => {
  for (const t of feedEl.querySelectorAll('[data-ago]')) {
    const s = ago(t.dataset.ago);
    if (t.textContent !== s) t.textContent = s;
  }
}, 5000);

scene.setLeftInset(feedInset());
$('#feed-collapse').addEventListener('click', () => setFeedCollapsed(true));
$('#feed-tab').addEventListener('click', () => setFeedCollapsed(false));
try {
  if (localStorage.getItem('fleet-scope:feed-collapsed') === '1') setFeedCollapsed(true);
} catch {
  /* storage blocked */
}

// Agent labels: auto, all or off (remembered).
const LABEL_MODES = ['auto', 'all', 'off'];
function setLabelMode(mode) {
  if (!LABEL_MODES.includes(mode)) mode = 'auto';
  scene.setLabelMode(mode);
  $('#labels').textContent = `Labels: ${mode}`;
  $('#labels').dataset.mode = mode;
  try {
    localStorage.setItem('fleet-scope:labels', mode);
  } catch {
    /* storage blocked */
  }
}
function cycleLabels() {
  const cur = $('#labels').dataset.mode || 'auto';
  setLabelMode(LABEL_MODES[(LABEL_MODES.indexOf(cur) + 1) % LABEL_MODES.length]);
}
$('#labels').addEventListener('click', cycleLabels);
try {
  setLabelMode(localStorage.getItem('fleet-scope:labels') || 'auto');
} catch {
  setLabelMode('auto');
}

setInterval(() => {
  $('#clock').textContent = clock();
}, 1000);

// ?perf=1: the performance overlay (p toggles it); ?bench=1 runs the
// benchmark once the scene has settled. See docs/design.md, "Scale".
const perf = new PerfOverlay(
  document.body,
  scene,
  () => ({
    url: window.location.search || '(none)',
    agents: model.agents.size,
    workers: model.workers.size,
    atespaces: model.atespaces.size,
    theme: themes.theme?.id || '',
    shape: scene.shape.id,
    group: scene.group,
    layout: scene.layout,
    ...(scene.layout === 'decks' ? { beams: scene.beamMode } : {}),
    lod: scene.stats().lod,
    quality: scene.stats().quality,
  }),
  { visible: params.get('perf') === '1' || params.get('bench') === '1' },
);
// Scroll: auto (wheel zooms, trackpad scroll pans), zoom (every scroll zooms,
// Shift+scroll pans; for a Magic Mouse), or pan. ?scroll= overrides; remembered.
const SCROLL_KEY = 'fleet-scope:scroll';
function setScroll(mode, remember = true) {
  const m = scrollModeId(mode);
  scene.gestures.wheel.mode = m;
  document.querySelectorAll('#zoomctl [data-scroll]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.scroll === m)));
  if (remember) localStorage.setItem(SCROLL_KEY, m);
}
setScroll(new URLSearchParams(location.search).get('scroll') || localStorage.getItem(SCROLL_KEY) || 'auto', false);
document.querySelectorAll('#zoomctl [data-scroll]').forEach((b) => b.addEventListener('click', () => setScroll(b.dataset.scroll)));
$('#zoom-in').addEventListener('click', () => scene.zoomBy(1 / 1.25));
$('#zoom-out').addEventListener('click', () => scene.zoomBy(1.25));
document.addEventListener('keydown', (e) => {
  const typing = document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'SELECT';
  if (typing || e.metaKey || e.ctrlKey) return;
  if (e.key === '+' || e.key === '=') scene.zoomBy(1 / 1.25);
  if (e.key === '-' || e.key === '_') scene.zoomBy(1.25);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'p' && document.activeElement?.tagName !== 'INPUT') perf.el.hidden = !perf.el.hidden;
});
if (params.get('bench') === '1') {
  const start = () => (model.seq > 0 && scene.island ? setTimeout(() => perf.runBench(), 3000) : setTimeout(start, 500));
  start();
}

// The controls tour: every way to move around, performed on the live scene
// with captions (the ? button or key; ?demo=controls loops it, &loop=0 runs
// it once). It puts the user's camera, decks, beams and layout back after.
const tour = new ControlsTour(scene, {
  ready: () => model.seq > 0 && !!scene.island,
  selected: () => selected,
  scrollMode: () => scene.gestures.wheel.mode,
  select,
  setLayout,
  setGroup,
  setBeams,
  setScroll,
});
$('#tour-btn').addEventListener('click', () => tour.toggle({ loop: params.get('loop') === '1' }));
if (params.get('demo') === 'controls') tour.startWhenReady({ loop: params.get('loop') !== '0' });

// For debugging and screenshots.
window.scope = { model, scene, panel, select, stateClass, eventCounts, themes, looks, stream, perf, tour, drawer, openThread, closeThread, signalEvents, trackers, controls };
