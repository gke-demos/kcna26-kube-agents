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

// The side panel for the selected workload (fleet-scope): cluster,
// namespace, kind, replicas, health and why, image, memory limit, the
// Cluster Agent watching it, and the incident's latest signals for it (from
// the feed's buffer) with their links. Everything comes from the snapshot
// and the stream, so the panel never fetches.
//
// (substrate-scope's panel had Substrate/ax sections, a raw YAML view,
// sessions and mast-web; sessions.js and yaml.js stay for their tests.)

import { esc, duration, since, ago, clock } from './format.js';
import { cssColor } from './scene.js';
import { stateClass, CLASS_LABEL } from './model.js';
import { SIGNAL_ICON } from './signals-ui.js';

/** Signals listed for the selected workload. */
const PANEL_SIGNALS = 8;

function row(k, v, cls = '') {
  if (v === undefined || v === null || v === '') return '';
  return `<div class="kv ${cls}"><span class="k">${esc(k)}</span><span class="v">${v}</span></div>`;
}

function mono(s) {
  return `<code>${esc(s)}</code>`;
}

export class Panel {
  /**
   * @param {HTMLElement} el
   * @param {{onClose: Function, onShowWorker?: Function, agent: (key: string) => any, worker: (name: string) => any, signals: (key: string) => any[],
   *   threadFor?: (key: string) => string, onThread?: (thread: string) => void}} opts
   */
  constructor(el, opts) {
    this.el = el;
    this.opts = opts;
    this.key = null;
    this.timer = setInterval(() => this.updateLive(), 1000);
    el.addEventListener('click', (e) => this.onClick(e));
  }

  show(key) {
    const fresh = key !== this.key;
    this.key = key;
    this.el.classList.add('open');
    if (fresh) this.render();
    else this.updateLive();
  }

  hide() {
    this.key = null;
    this.el.classList.remove('open');
  }

  /** The model changed for this workload. */
  agentChanged() {
    if (this.key) this.render();
  }

  /** New signals arrived (any workload). */
  signalsChanged(key) {
    if (this.key && (!key || key === this.key)) this.patch('[data-live="signals"]', this.signalsHTML());
  }

  patch(sel, html) {
    const el = this.el.querySelector(sel);
    if (el && el.innerHTML !== html) el.innerHTML = html;
  }

  updateLive() {
    const a = this.key && this.opts.agent(this.key);
    if (!a) return;
    this.patch('[data-live="age"]', esc(duration(since(a.stateSince))));
    for (const t of this.el.querySelectorAll('[data-ago]')) {
      const s = ago(t.dataset.ago);
      if (t.textContent !== s) t.textContent = s;
    }
  }

  signalsHTML() {
    const list = (this.opts.signals(this.key) || []).slice(0, PANEL_SIGNALS);
    if (!list.length) return '<p class="muted">No alerts, triage or pull requests for this workload yet.</p>';
    const thread = this.opts.threadFor?.(this.key);
    const view = thread && this.opts.onThread ? `<button class="btn view-thread" data-act="thread" data-thread="${esc(thread)}" title="The incident's Slack thread: the agent's report, its options and the pull requests">View thread ›</button>` : '';
    return `${view}<ol class="sig-list">${list
      .map((s) => {
        const icon = SIGNAL_ICON[s.sig] || '•';
        const link = s.link ? ` <a class="ext" href="${esc(s.link)}" target="_blank" rel="noopener" title="Open in a new tab">↗</a>` : '';
        return `<li class="sig ${esc(s.sig)}"><span class="icon"${this.opts.iconStyle ? ` style="${this.opts.iconStyle(s.sig)}"` : ''}>${icon}</span><span class="body"><span class="txt">${s.text}${link}</span>
          <span class="meta">${s.actor ? `${esc(s.actor)} · ` : ''}<span data-ago="${esc(s.time)}" title="${esc(s.time ? new Date(s.time).toLocaleString() : '')}">${esc(ago(s.time))}</span></span></span></li>`;
      })
      .join('')}</ol>`;
  }

  render() {
    const key = this.key;
    const a = key && this.opts.agent(key);
    if (!a) {
      this.el.innerHTML = `<div class="panel-head"><h2>${esc(key || '')}</h2><button class="close" data-act="close" title="Close">×</button></div><p class="note">This workload is gone.</p>`;
      return;
    }
    const cls = stateClass(a.state);
    const wk = a.worker && this.opts.worker(a.worker);
    const why = cls === 'running' ? '' : a.reason;
    const replicas = a.replicas || a.ready ? `<b>${a.ready ?? 0}</b> / ${a.replicas ?? 0} ready` : '';
    const parts = [];
    parts.push(`<div class="panel-head">
      <div><div class="atespace">${esc(a.atespace)}${a.namespace ? ` · ${esc(a.namespace)}` : ''}</div><h2>${esc(a.name)}</h2></div>
      <button class="close" data-act="close" title="Close">×</button></div>
      <div class="state-line"><span class="state-badge" data-cls="${cls}" style="--c:${cssColor(a.state)}">${esc(CLASS_LABEL[cls])}</span>
      ${why ? `<span class="reason r-bad">${esc(why)}</span>` : ''}
      <span class="muted">for <span data-live="age">${duration(since(a.stateSince))}</span></span></div>`);
    parts.push(`<section><h3>Workload</h3>
      ${row('Cluster', esc(a.atespace))}
      ${row('Namespace', a.namespace && mono(a.namespace))}
      ${row('Kind', esc(a.kind || ''))}
      ${row('Replicas', replicas)}
      ${a.crash?.message ? row('Why', `<span class="crash">${esc(a.crash.message)}</span>${a.crash.time ? `<span class="muted"> at ${esc(clock(a.crash.time))}</span>` : ''}`, 'wide') : ''}
      ${row('Image', a.image && mono(a.image.replace(/@sha256:([0-9a-f]{12})[0-9a-f]+/, '@sha256:$1…')), 'wide')}
      ${row('Memory limit', a.memoryLimit && mono(a.memoryLimit))}
      ${row(
        'Watched by',
        a.worker
          ? `${esc(wk?.pod || a.worker)}${this.opts.onShowWorker ? ` <button class="linkbtn" data-act="show-worker" data-worker="${esc(a.worker)}" title="Light up this agent and the workloads it watches">show</button>` : ''}`
          : '',
      )}
    </section>`);
    parts.push(`<section><h3>Incident</h3><div data-live="signals">${this.signalsHTML()}</div></section>`);
    this.el.innerHTML = parts.join('');
  }

  onClick(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    if (btn.dataset.act === 'close') this.opts.onClose();
    else if (btn.dataset.act === 'show-worker') this.opts.onShowWorker?.(btn.dataset.worker);
    else if (btn.dataset.act === 'thread') this.opts.onThread?.(btn.dataset.thread);
  }
}
