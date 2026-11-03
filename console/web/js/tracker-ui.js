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

// The incident tracker card (fleet-scope): top center under the header, one
// card per console press (two at most, newest on top), from "Pushing
// change…" to the workload healthy again. The steps come from tracker.js;
// this file keeps the presses (sessionStorage, so a reload rebuilds them),
// feeds them the live events, and draws the cards. A press made in another
// browser shows up too, from its action event on the stream.

import { esc } from './format.js';
import {
  deriveSteps, newPress, pressAnswered, pressFailed, observe, isPressAction, mmss, actionKind,
  SENDING, DONE, ACTIVE, FAILED, SKEW_TOLERANCE_MS,
} from './tracker.js';

/** sessionStorage key for the presses being tracked. */
const STORE_KEY = 'fleet-scope:trackers';
/** Cards shown at once. */
const MAX_CARDS = 2;
/** A done step folds into the summary line after this long (ms). */
const COLLAPSE_MS = 10e3;
/** A finished incident's card goes away after this long (ms). */
const AUTO_DISMISS_MS = 60e3;
/** A press still "sending" after this long (a reload lost its answer, and no action event came) has failed (ms). */
const LOST_PRESS_MS = 90e3;
/** A press older than this is not rebuilt on reload (ms). */
const MAX_AGE_MS = 3 * 3600e3;
/** An action event from elsewhere starts a card only while this fresh (ms). */
const FOREIGN_FRESH_MS = 30e3;
/** Timer refresh (ms). */
const TICK_MS = 1000;
/** Pending steps drawn as rows; the rest are named on one line. */
const PENDING_ROWS = 1;
/** Space between the stack and the control panel it sits on (px). */
const DOCK_GAP = 10;

/** Short names for the folded summary line. */
const SHORT = {
  pushed: 'Pushed',
  synced: 'Synced',
  failing: 'Failing',
  watching: 'Detected',
  alert: 'Alert',
  investigating: 'Triaged',
  report: 'Report',
  fix: 'Fix chosen',
  pr: 'PR',
  merged: 'Merged',
  healthy: 'Healthy',
};

/** An http(s) URL, or ''. */
function webURL(u) {
  return /^https?:\/\//i.test(u || '') ? u : '';
}

function loadPresses() {
  try {
    const list = JSON.parse(sessionStorage.getItem(STORE_KEY) || '[]');
    return Array.isArray(list) ? list.filter((p) => p && p.id && p.action && Date.now() - p.time < MAX_AGE_MS) : [];
  } catch {
    return [];
  }
}

export class TrackerStack {
  /**
   * @param {HTMLElement} el
   * @param {{model: () => any, signals: () => any[], onThread?: (thread: string, key: string) => void, onSelect?: (key: string) => void,
   *   resolveKey?: (target: string) => string, actionTitle?: (name: string) => string, dock?: () => HTMLElement|null}} opts
   */
  constructor(el, opts) {
    this.el = el;
    this.opts = opts;
    /** @type {{press: any, min: boolean, view: any, el: HTMLElement|null, html: Map<string, string>}[]} */
    this.cards = loadPresses().map((press) => this.card(press));
    for (const c of this.cards.slice(1)) c.min = true;
    el.addEventListener('click', (e) => this.onClick(e));
    this.timer = setInterval(() => this.tick(), TICK_MS);
    window.addEventListener('resize', () => this.place());
    this.render();
  }

  card(press) {
    return { press, min: false, view: null, el: null, html: new Map() };
  }

  save() {
    try {
      sessionStorage.setItem(STORE_KEY, JSON.stringify(this.cards.map((c) => c.press)));
    } catch {
      /* storage blocked: the card still works for this page */
    }
  }

  /**
   * A button was pressed: a new card right away ("Pushing change…").
   * @returns {string} the press id, for answered() / failed()
   */
  pressed(action, title, target) {
    const key = target && this.opts.resolveKey ? this.opts.resolveKey(target) : '';
    const press = newPress({ action, title, target, key, time: Date.now() });
    this.add(press);
    return press.id;
  }

  add(press) {
    // A reset puts everything back, so it replaces every card.
    if (actionKind(press.action) === 'reset') this.cards = [];
    for (const c of this.cards) c.min = true;
    this.cards.unshift(this.card(press));
    this.cards = this.cards.slice(0, MAX_CARDS);
    this.save();
    this.render();
  }

  update(id, fn) {
    const c = this.cards.find((x) => x.press.id === id);
    if (!c) return;
    c.press = fn(c.press);
    this.save();
    this.render();
  }

  /** The POST answered {title, link, key, cluster, commit}. */
  answered(id, res) {
    this.update(id, (p) => pressAnswered(p, res, Date.now()));
  }

  /** The POST failed. */
  failed(id, err) {
    this.update(id, (p) => pressFailed(p, err?.message || err, Date.now()));
  }

  /** Live events (after the model applied them). */
  onEvents(events) {
    const now = Date.now();
    let changed = false;
    for (const c of this.cards) {
      const p = observe(c.press, events, now);
      if (p !== c.press) {
        c.press = p;
        changed = true;
      }
    }
    // A press from another console: its action event starts a card here.
    for (const ev of events) {
      if (ev.type !== 'action' || ev.message === 'failed' || !ev.reason) continue;
      if (this.cards.some((c) => isPressAction(c.press, ev))) continue;
      const t = Date.parse(ev.time || '');
      if (Number.isFinite(t) && Math.abs(now - t) > FOREIGN_FRESH_MS) continue;
      const title = this.opts.actionTitle?.(ev.reason) || ev.reason;
      const press = pressAnswered(newPress({ action: ev.reason, title, key: ev.key, time: now - SKEW_TOLERANCE_MS / 2 }), ev, now);
      press.serverTime = ev.time || '';
      press.by = ev.actor || '';
      this.add(press);
      changed = true;
    }
    if (changed) this.save();
    this.render();
  }

  /** A fresh snapshot (connect or resync): the steps rebuild from the model and the feed buffer. */
  refresh() {
    this.render();
  }

  tick() {
    if (!this.cards.length) return;
    const now = Date.now();
    let changed = false;
    for (const c of this.cards) {
      if (c.press.status === SENDING && now - c.press.time > LOST_PRESS_MS && !c.view?.commit) {
        c.press = pressFailed(c.press, 'No answer from the console server', now);
        changed = true;
      }
    }
    const before = this.cards.length;
    this.cards = this.cards.filter((c) => !(c.view?.status === 'done' && now - c.view.doneAt > AUTO_DISMISS_MS));
    if (changed || this.cards.length !== before) this.save();
    this.render();
  }

  onClick(e) {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const cardEl = b.closest('[data-id]');
    const c = cardEl && this.cards.find((x) => x.press.id === cardEl.dataset.id);
    if (!c) return;
    const act = b.dataset.act;
    if (act === 'close') {
      this.cards = this.cards.filter((x) => x !== c);
      this.save();
    } else if (act === 'min') {
      c.min = !c.min;
    } else if (act === 'thread') {
      this.opts.onThread?.(b.dataset.thread, c.view?.key || '');
      return;
    } else if (act === 'select') {
      if (c.view?.key) this.opts.onSelect?.(c.view.key);
      return;
    }
    this.render();
  }

  render() {
    const now = Date.now();
    const model = this.opts.model();
    const signals = this.opts.signals();
    const live = new Set();
    for (const c of this.cards) {
      c.view = deriveSteps(c.press, model, signals, now);
      if (!c.el) {
        c.el = document.createElement('article');
        c.el.className = 'trk';
        c.el.dataset.id = c.press.id;
        c.el.innerHTML = '<header class="trk-head"></header><div class="trk-fold"></div><ol class="trk-steps"></ol><div class="trk-foot"></div>';
      }
      this.draw(c, now);
      live.add(c.el);
    }
    // Order: newest on top; drop dismissed cards.
    for (const child of [...this.el.children]) if (!live.has(child)) child.remove();
    this.cards.forEach((c, i) => {
      if (this.el.children[i] !== c.el) this.el.insertBefore(c.el, this.el.children[i] || null);
    });
    this.el.hidden = !this.cards.length;
    this.place();
  }

  /** Docks the stack above the control panel (it moves when the side panel or the thread opens). */
  place() {
    const d = this.opts.dock?.();
    const st = this.el.style;
    if (!d || d.hidden || this.el.hidden) {
      st.right = '';
      st.bottom = '';
      return;
    }
    const r = d.getBoundingClientRect();
    const right = `${Math.max(DOCK_GAP, window.innerWidth - r.right)}px`;
    const bottom = `${window.innerHeight - r.top + DOCK_GAP}px`;
    if (st.right !== right) st.right = right;
    if (st.bottom !== bottom) st.bottom = bottom;
  }

  draw(c, now) {
    const v = c.view;
    const p = c.press;
    const el = c.el;
    el.classList.toggle('min', c.min);
    el.classList.toggle('done', v.status === 'done');
    el.classList.toggle('failed', v.status === 'failed');
    el.classList.toggle('reset', v.kind === 'reset');
    const active = v.steps[v.active];
    // The total stops when the incident is over, or when the press failed.
    const end = v.status === 'done' ? v.doneAt : v.status === 'failed' ? v.steps.find((s) => s.state === FAILED)?.at || p.respondedAt || now : 0;
    const where = v.key
      ? `<span class="trk-where link" data-act="select" role="button" tabindex="0" title="Fly to this workload"><b>${esc(v.workload)}</b> <span class="cl">· ${esc(v.cluster)}</span></span>`
      : v.kind === 'reset'
        ? '<span class="trk-where">the whole fleet</span>'
        : v.workload
          ? `<span class="trk-where"><b>${esc(v.workload)}</b></span>`
          : '';
    const statusWord = v.status === 'done' ? (v.kind === 'reset' ? 'Fleet reset' : 'Recovered') : v.status === 'failed' ? 'Failed' : '';
    const minLine = c.min && active ? `<span class="trk-minstep">${esc(active.label)}</span>` : '';
    const head = `<span class="trk-icon">${v.status === 'done' ? '✓' : v.status === 'failed' ? '✗' : '◆'}</span>
      <div class="trk-title"><div class="trk-action">${esc(p.title)}${p.by ? ` <span class="trk-by">by ${esc(p.by)}</span>` : ''}</div>${where || statusWord ? `<div class="trk-sub">${statusWord ? `<span class="trk-status">${statusWord}</span> ` : ''}${where}</div>` : ''}${minLine}</div>
      <span class="trk-total" title="Time since the press" data-from="${p.time}"${end ? ` data-to="${end}"` : ''}></span>
      <button class="trk-btn" data-act="min" title="${c.min ? 'Expand' : 'Minimize'}">${c.min ? '▾' : '▴'}</button>
      <button class="trk-btn" data-act="close" title="Dismiss">×</button>`;
    this.patch(c, 'head', el.querySelector('.trk-head'), head);

    // Done steps past COLLAPSE_MS fold into one line; the rest are rows.
    const folded = [];
    const rows = [];
    let pendingShown = 0;
    const later = [];
    for (const s of v.steps) {
      if (s.state === DONE && (!s.at || now - s.at > COLLAPSE_MS) && v.status !== 'done') folded.push(s);
      else if (s.state === DONE && v.status === 'done' && s.id !== 'healthy') folded.push(s);
      else if (s.state === 'pending') {
        if (v.status === 'failed') continue;
        if (pendingShown++ < PENDING_ROWS) rows.push(s);
        else later.push(s);
      } else rows.push(s);
    }
    const fold = folded
      .map((s) => `<span class="f">✓ ${esc(SHORT[s.id] || s.label)}${s.at ? ` <i>${mmss(s.at - p.time)}</i>` : ''}</span>`)
      .join('');
    this.patch(c, 'fold', el.querySelector('.trk-fold'), fold);
    el.querySelector('.trk-fold').hidden = !folded.length;

    const html = rows.map((s) => this.rowHTML(s, v, p)).join('') + (later.length ? `<li class="step later"><span class="mark"></span><div class="body"><span class="lbl">Then: ${later.map((s) => esc(SHORT[s.id] || s.label)).join(' › ')}</span></div></li>` : '');
    this.patch(c, 'steps', el.querySelector('.trk-steps'), html);

    const thread = v.thread && this.opts.onThread ? `<button class="btn trk-thread" data-act="thread" data-thread="${esc(v.thread)}">View thread ›</button>` : '';
    const foot = thread;
    this.patch(c, 'foot', el.querySelector('.trk-foot'), foot);
    el.querySelector('.trk-foot').hidden = !foot;
    this.timers(el, now);
  }

  rowHTML(s, v, p) {
    const mark = s.state === DONE ? '✓' : s.state === FAILED ? '✗' : s.state === ACTIVE ? '<span class="spin"></span>' : '';
    const link = webURL(s.link) ? ` <a href="${esc(s.link)}" target="_blank" rel="noopener noreferrer" class="trk-link">${esc(s.linkText || 'open')} ↗</a>` : '';
    const time = s.state === DONE && s.at ? `<span class="t">${mmss(s.at - p.time)}</span>` : s.state === ACTIVE ? `<span class="t live" data-from="${s.since}"></span>` : '';
    const detail = s.detail;
    const hint = s.state === ACTIVE && s.hint ? s.hint : '';
    // The watcher's and agents' timing are estimates; say so where they show.
    const est = hint && /≈|typically/.test(hint) ? ' <span class="est">estimate</span>' : '';
    const slow = s.state === ACTIVE && s.slow ? '<span class="slow">taking longer than usual</span>' : '';
    const lines = [detail && `<div class="det">${esc(detail)}</div>`, hint && `<div class="hint">${esc(hint)}${est}${slow ? ' · ' : ''}${slow}</div>`, !hint && slow && `<div class="hint">${slow}</div>`].filter(Boolean).join('');
    return `<li class="step s-${s.state}" data-step="${esc(s.id)}"><span class="mark">${mark}</span><div class="body"><div class="row"><span class="lbl">${esc(s.label)}</span>${link}${time}</div>${lines}</div></li>`;
  }

  /** Sets a part's HTML only when it changed (spinners keep turning). */
  patch(c, part, el, html) {
    if (c.html.get(part) === html) return;
    c.html.set(part, html);
    el.innerHTML = html;
  }

  /** Live timers: "1:23" since data-from (until data-to when set). */
  timers(root, now) {
    for (const t of root.querySelectorAll('[data-from]')) {
      const to = Number(t.dataset.to) || now;
      const s = mmss(to - Number(t.dataset.from));
      if (t.textContent !== s) t.textContent = s;
    }
  }
}
