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

// The thread view: an incident's Slack thread as chat bubbles in a drawer
// on the right (in the side panel's slot), with the report's options as
// buttons that open the report in Slack, the chosen fix, and the workload's
// pull requests inline. It follows the stream: new messages in the open
// thread append in place.

import { esc, ago, clock } from './format.js';
import { mrkdwn } from './mrkdwn.js';
import { buildThread, isBot } from './thread.js';

/** How close to the bottom (px) still counts as reading the latest message. */
const STICK_PX = 48;
// A second scroll after this, for layout that settles late.
const SETTLE_MS = 250;
/** How often relative times refresh (ms). */
const AGO_EVERY = 5000;
/** One day, in ms (older messages show their date). */
const DAY_MS = 86400e3;
const OPTION_HINT = 'Choose in Slack — the agent acts on your click there';
/** A report's evidence section, folded under a toggle so the findings and options fit. */
const EVIDENCE_RE = /\*Evidence for verified claims\*/;
const FENCE_RE = /```/g;
/** A command in the evidence: a code block that starts with "$ ". */
const COMMAND_RE = /```\s*\$\s/g;

/** An http(s) URL, or '' (event links are shown only when they are web links). */
function webURL(u) {
  return /^https?:\/\//i.test(u || '') ? u : '';
}

function extLink(href, text, cls = 'ext', title = 'Open in a new tab') {
  const u = webURL(href);
  return u ? `<a class="${cls}" href="${esc(u)}" target="_blank" rel="noopener noreferrer" title="${esc(title)}">${text}</a>` : '';
}

/** "AB" for "Alice Bob", "SR" for "sre-oncall". */
function initials(name) {
  const parts = String(name || '?').split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] || '?') + (parts[1]?.[0] || '')).toUpperCase();
}

/** A stable hue per person, for their avatar. */
function hue(name) {
  let h = 0;
  for (const c of String(name || '')) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

/**
 * A message's text as HTML; a report's evidence (commands and their output)
 * folds into a <details> unless it starts inside a code block.
 */
function messageHTML(text, id, open) {
  const m = EVIDENCE_RE.exec(text);
  const head = m ? text.slice(0, m.index) : '';
  if (!m || (head.match(FENCE_RE) || []).length % 2) return mrkdwn(text);
  const rest = text.slice(m.index + m[0].length);
  const checks = (rest.match(COMMAND_RE) || []).length;
  const count = checks ? ` <span class="muted">· ${checks} command${checks === 1 ? '' : 's'}</span>` : '';
  return `${mrkdwn(head.trimEnd())}<details class="evidence" data-id="${esc(id)}"${open ? ' open' : ''}><summary>Evidence for verified claims${count}</summary>${mrkdwn(rest.trimStart())}</details>`;
}

/** Relative and absolute time for an item. */
function timeHTML(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const iso = d.toISOString();
  const abs = Date.now() - ms > DAY_MS ? `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${clock(iso)}` : clock(iso);
  return `<span class="when" data-ago="${esc(iso)}" title="${esc(d.toLocaleString())}">${esc(ago(iso))}</span><span class="abs">${esc(abs)}</span>`;
}

export class ThreadDrawer {
  /**
   * @param {HTMLElement} el
   * @param {{events: () => any[], agent: (key: string) => any, healthy: (key: string) => boolean, onClose: Function, onDetails: (key: string) => void}} opts
   */
  constructor(el, opts) {
    this.el = el;
    this.opts = opts;
    this.thread = '';
    this.seen = new Set();
    this.sig = '';
    /** Evidence sections the user opened (by item), kept open across re-renders. */
    this.unfolded = new Set();
    el.innerHTML = `<div class="drawer-head" data-part="head"></div><div class="drawer-body" data-part="body"><ol class="msgs"></ol></div>
      <button class="drawer-new" data-act="bottom" hidden>↓ New messages</button>`;
    this.head = el.querySelector('[data-part="head"]');
    this.body = el.querySelector('[data-part="body"]');
    this.list = el.querySelector('.msgs');
    this.newBtn = el.querySelector('.drawer-new');
    el.addEventListener('click', (e) => this.onClick(e));
    // toggle does not bubble: listen in the capture phase.
    el.addEventListener(
      'toggle',
      (e) => {
        const d = e.target;
        if (!d.matches?.('details.evidence')) return;
        if (d.open) this.unfolded.add(d.dataset.id);
        else this.unfolded.delete(d.dataset.id);
      },
      true,
    );
    // Follow new messages unless the reader scrolled up. Intent comes from the
    // reader's own scrolling (wheel, touch, keys, the scrollbar); scrolls we
    // make ourselves are ignored, so late layout (code blocks, the status
    // chip) can't turn following off.
    this.follow = true;
    this.autoScrolling = false;
    this.body.addEventListener('scroll', () => {
      if (this.autoScrolling) return;
      this.follow = this.atBottom();
      if (this.follow) this.newBtn.hidden = true;
    });
    setInterval(() => this.refreshTimes(), AGO_EVERY);
  }

  get isOpen() {
    return !!this.thread;
  }

  /** The workload the open thread is about ('' when none). */
  get key() {
    return this.view?.key || '';
  }

  open(thread) {
    if (!thread) return;
    const fresh = thread !== this.thread;
    this.thread = thread;
    this.el.classList.add('open');
    this.el.setAttribute('aria-hidden', 'false');
    if (fresh) {
      this.seen = new Set();
      this.sig = '';
      this.unfolded = new Set();
      this.follow = true;
    }
    this.render(true);
  }

  close() {
    this.thread = '';
    this.view = null;
    this.el.classList.remove('open');
    this.el.setAttribute('aria-hidden', 'true');
  }

  /** New signal events arrived: re-render when one belongs to the open thread (or is a PR for its workload). */
  eventsChanged(events) {
    if (!this.thread) return;
    const key = this.key;
    if (!events || events.some((e) => e.thread === this.thread || (key && e.key === key))) this.render(false);
  }

  /** The workload changed (healthy again turns Merged into Recovered). */
  agentChanged(key) {
    if (this.thread && key === this.key) this.render(false);
  }

  /** Scrolls to the newest message, again after layout settles (fonts, code blocks). */
  toBottom() {
    const go = () => {
      if (!this.follow && !this.autoScrolling) return;
      this.autoScrolling = true;
      this.body.scrollTop = this.body.scrollHeight;
      // The scroll event for this lands after us; release on the next frame.
      requestAnimationFrame(() => {
        this.autoScrolling = false;
      });
    };
    this.follow = true;
    go();
    requestAnimationFrame(go);
    setTimeout(go, SETTLE_MS);
  }

  atBottom() {
    const b = this.body;
    return b.scrollHeight - b.scrollTop - b.clientHeight < STICK_PX;
  }

  render(first) {
    const t = buildThread(this.opts.events(), this.thread, { healthy: this.opts.healthy });
    this.view = t;
    this.head.innerHTML = this.headHTML(t);
    const sig = t.items.map((i) => `${i.kind}|${i.ev.seq}|${i.ev.ts}|${i.ev.type}|${i.ev.link}`).join(',') + `|${t.chosen?.letter || ''}`;
    if (!first && sig === this.sig) return;
    this.sig = sig;
    const stick = first || this.follow;
    const prevTop = this.body.scrollTop;
    this.list.innerHTML = t.items.length ? t.items.map((it) => this.itemHTML(it, t)).join('') : '<li class="sys muted">No messages in this thread yet.</li>';
    for (const it of t.items) this.seen.add(this.itemId(it));
    if (stick) {
      this.toBottom();
      this.newBtn.hidden = true;
    } else {
      this.body.scrollTop = prevTop;
      this.newBtn.hidden = false;
    }
  }

  itemId(it) {
    return `${it.kind}|${it.ev.ts || ''}|${it.ev.type}|${it.ev.link || ''}`;
  }

  headHTML(t) {
    const [cl, ...rest] = (t.key || '').split('/');
    const where = t.key ? `${esc(cl)} <span class="slash">/</span> <b>${esc(rest.join('/'))}</b>` : esc(t.cluster || '');
    const details = t.key && this.opts.agent(t.key) ? `<button class="linkbtn back" data-act="details" title="Back to this workload's details">← workload details</button>` : '<span></span>';
    const slack = extLink(t.permalink, 'Open in Slack <span aria-hidden="true">↗</span>', 'slack-open', 'Open the thread in Slack');
    return `<div class="drawer-top">${details}<span class="drawer-kind">Slack thread</span><button class="close" data-act="close" title="Close (Esc)">×</button></div>
      <div class="drawer-where">${where}</div>
      <h2>${esc(t.title || 'Incident thread')}</h2>
      <div class="drawer-meta"><span class="status-chip" data-status="${esc(t.statusId)}">${esc(t.status)}</span>${slack}</div>`;
  }

  itemHTML(it, t) {
    const fresh = this.seen.size && !this.seen.has(this.itemId(it)) ? ' fresh' : '';
    const e = it.ev;
    if (it.kind === 'pr') {
      const n = it.number ? `PR #${esc(it.number)}` : 'Pull request';
      const verb = { pr_opened: 'opened', pr_merged: 'merged', pr_closed: 'closed' }[e.type];
      const by = e.actor ? ` by <b>${esc(e.actor)}</b>` : '';
      return `<li class="sys pr ${esc(e.type)}${fresh}"><span class="sys-icon">${e.type === 'pr_merged' ? '⇥' : e.type === 'pr_closed' ? '×' : '+'}</span>
        <span class="sys-body"><span class="sys-line">${extLink(e.link, `${n} ${verb} <span aria-hidden="true">↗</span>`, 'pr-link', e.title || 'Open the pull request')}${by}</span>
        ${e.title ? `<span class="sys-sub">${esc(e.title)}</span>` : ''}</span><span class="sys-time">${timeHTML(it.at)}</span></li>`;
    }
    if (it.kind === 'choice') {
      const c = t.chosen && t.chosen.ev === e ? t.chosen : null;
      const what = c?.letter ? `Option ${esc(c.letter)}${c.label ? ` — ${esc(c.label)}` : ''}` : esc(e.title || 'a fix');
      return `<li class="sys choice${fresh}"><span class="sys-icon">✓</span><span class="sys-body"><span class="sys-line"><b>${esc(e.actor || 'Someone')}</b> chose ${what}</span></span><span class="sys-time">${timeHTML(it.at)}</span></li>`;
    }
    const bot = isBot(e.actor);
    const who = e.actor || 'unknown';
    const avatar = bot ? '<span class="avatar bot" aria-hidden="true"></span>' : `<span class="avatar" style="background:hsl(${hue(who)} 45% 42%)" aria-hidden="true">${esc(initials(who))}</span>`;
    const id = this.itemId(it);
    const body = e.text
      ? messageHTML(e.text, id, this.unfolded.has(id))
      : `${e.title ? `<strong>${esc(e.title)}</strong>` : ''}${e.title && e.message ? '<br>' : ''}${esc(e.message || '').replace(/\n/g, '<br>')}`;
    const permalink = extLink(e.permalink || (e.ts ? e.link : ''), '↗', 'ext', 'Open this message in Slack');
    return `<li class="msg${bot ? ' bot' : ''} sig-${esc(e.type)}${fresh}">${avatar}<div class="bubble">
      <div class="msg-head"><span class="author">${esc(bot ? 'kube-agents' : who)}</span>${bot ? '<span class="app-tag">APP</span>' : ''}${bot && who !== 'kube-agents' ? `<span class="via">${esc(who)}</span>` : ''}${timeHTML(it.at)}${permalink}</div>
      <div class="msg-text">${body}</div>${it.options?.length ? this.optionsHTML(e, it.options, t.chosen) : ''}</div></li>`;
  }

  optionsHTML(report, options, chosen) {
    const href = webURL(report.permalink) || webURL(report.link);
    const decided = !!chosen?.letter;
    const buttons = options
      .map((o) => {
        const isChosen = decided && o.letter === chosen.letter;
        const cls = `opt${o.recommended ? ' rec' : ''}${isChosen ? ' chosen' : ''}`;
        const inner = `<span class="opt-letter">${esc(o.letter)}</span><span class="opt-label">${esc(o.label || `Option ${o.letter}`)}</span>${o.recommended || isChosen ? `<span class="opt-tags">${o.recommended ? '<span class="opt-badge">Recommended</span>' : ''}${isChosen ? `<span class="opt-chosen">✓ ${esc(chosen.actor || 'chosen')}</span>` : ''}</span>` : ''}`;
        const title = `Open the report in Slack to choose Option ${o.letter}`;
        return href
          ? `<a class="${cls}" href="${esc(href)}" target="_blank" rel="noopener noreferrer" title="${esc(title)}">${inner}</a>`
          : `<span class="${cls}" aria-disabled="true">${inner}</span>`;
      })
      .join('');
    return `<div class="opts${decided ? ' decided' : ''}">${buttons}</div>${decided ? '' : `<p class="opt-hint">${esc(OPTION_HINT)}</p>`}`;
  }

  refreshTimes() {
    if (!this.thread) return;
    for (const t of this.el.querySelectorAll('[data-ago]')) {
      const s = ago(t.dataset.ago);
      if (t.textContent !== s) t.textContent = s;
    }
  }

  onClick(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    if (btn.dataset.act === 'close') this.opts.onClose();
    else if (btn.dataset.act === 'details' && this.key) this.opts.onDetails(this.key);
    else if (btn.dataset.act === 'bottom') {
      this.follow = true;
      this.toBottom();
      this.newBtn.hidden = true;
    }
  }
}
