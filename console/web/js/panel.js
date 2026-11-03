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

// The side panel for the selected agent: Substrate state, ax task details,
// the runner's live idle time (running agents only) and its sessions, with
// a button that opens the agent in mast-web (served by the collector and
// attached through its attach proxy).
//
// The panel is built once per selected agent. Refreshes after that patch
// only the live fields (state, age, idle bar, phase, conditions); the
// sessions section is rebuilt only by the user's own actions or when the
// agent starts or stops running. Nothing here scrolls the panel.
//
// The Substrate and ax sections end in a collapsed "YAML" block with the raw
// objects behind them (Actor; Task and Workspaces), fetched when a block is
// opened. The collector redacts them before they leave it.

import { esc, duration, since, parseGoDuration, workerLabel, clock } from './format.js';
import { toYAML } from './yaml.js';
import { cssColor } from './scene.js';
import { stateClass } from './model.js';
import { apiBase, mastWebURL, sessionLine, emptySessionsNote, attachError, wakeRetryDelay, WAKE_RETRY_MS } from './sessions.js';

const REASON_CLASS = {
  IdleSuspended: 'r-idle',
  CompletedSuspended: 'r-done',
  ResumedByRequest: 'r-woke',
  ActorSuspended: 'r-ext',
  TaskSuspended: 'r-ext',
};

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
   * @param {{onClose: Function, features: () => any, detail?: Function, raw?: Function}} opts
   */
  constructor(el, opts) {
    this.el = el;
    this.opts = opts;
    this.key = null;
    this.detail = null;
    this.fetchedAt = 0;
    this.loadingKey = null;
    this.raw = null;
    this.rawLoading = null;
    this.resetSessions();
    this.timer = setInterval(() => this.tick(), 1000);
    el.addEventListener('click', (e) => this.onClick(e));
    // toggle doesn't bubble; listen in the capture phase.
    el.addEventListener('toggle', (e) => e.target.matches?.('details.raw') && e.target.open && this.loadRaw(), true);
  }

  resetSessions() {
    this.sessions = null;
    this.sessionsLoading = false;
    this.sessionError = '';
    // wake: '' | 'confirm' | 'waking' | 'waiting'
    this.wake = '';
    this.woke = false;
  }

  show(key) {
    if (key !== this.key) {
      this.resetSessions();
      this.detail = null;
      this.raw = null;
      this.el.innerHTML = '';
    }
    this.key = key;
    this.el.classList.add('open');
    this.load();
  }

  hide() {
    this.key = null;
    this.detail = null;
    this.el.classList.remove('open');
  }

  /** Called when the model changed for this agent. */
  agentChanged(agent) {
    if (!this.detail || !agent) return;
    const was = this.detail.agent.state;
    this.detail.agent = { ...this.detail.agent, ...agent };
    if (was !== agent.state) {
      this.stateChanged(was, agent.state);
      this.load();
    }
    this.updateLive();
  }

  /** Running-ness flipped: the sessions section offers different things. */
  stateChanged(from, to) {
    const running = to === 'RUNNING';
    if ((from === 'RUNNING') === running) return;
    if (running) {
      if (this.wake) this.woke = true;
      this.wake = '';
    } else {
      this.sessions = null;
      this.sessionError = '';
      if (this.wake !== 'waking' && this.wake !== 'waiting') this.wake = '';
    }
    this.renderSessions();
  }

  async load() {
    const key = this.key;
    // One load at a time per agent; a load for another agent (the previous
    // selection) doesn't block this one, and its result is dropped.
    if (!key || this.loadingKey === key) return;
    this.loadingKey = key;
    try {
      // opts.detail stands in for the collector (synthetic mode).
      let d = null;
      if (this.opts.detail) d = this.opts.detail(key);
      else {
        const resp = await fetch(apiBase(key), { cache: 'no-store' });
        if (key !== this.key) return;
        if (resp.ok) d = await resp.json();
      }
      if (key !== this.key) return;
      if (!d) {
        this.detail = null;
        this.el.innerHTML = `<div class="panel-head"><h2>${esc(key)}</h2><button class="close" data-act="close" title="Close">×</button></div><p class="note">This agent is gone.</p>`;
        return;
      }
      const prev = this.detail;
      this.detail = d;
      this.fetchedAt = Date.now();
      if (!prev || !this.el.querySelector('[data-sessions]') || !!prev.agent.task !== !!d.agent.task) {
        this.render();
      } else {
        if (prev.agent.state !== d.agent.state) this.stateChanged(prev.agent.state, d.agent.state);
        this.updateLive();
      }
    } catch (err) {
      console.warn('agent detail', err);
    } finally {
      if (this.loadingKey === key) this.loadingKey = null;
    }
  }

  tick() {
    if (!this.key || !this.detail) return;
    // Running ax agents: refresh runner status every 3s (the collector
    // confirms the actor is still running first). Others: just the ages.
    if (this.detail.agent.state === 'RUNNING' && this.detail.agent.task && Date.now() - this.fetchedAt > 3000) {
      this.load();
    } else {
      this.updateLive();
    }
  }

  idleNow() {
    const d = this.detail;
    if (!d?.runner || !d.runnerTime) return null;
    if (d.runner.inFlight > 0) return 0;
    return d.runner.idleSeconds + Math.max(0, (Date.now() - Date.parse(d.runnerTime)) / 1000);
  }

  /** Sets an element's HTML only when it changed (keeps selections, hover). */
  patch(sel, html) {
    const el = this.el.querySelector(sel);
    if (el && el.innerHTML !== html) el.innerHTML = html;
  }

  /** Updates the fields that change while the panel is open. */
  updateLive() {
    const d = this.detail;
    if (!d) return;
    const a = d.agent;
    const badge = this.el.querySelector('[data-live="state"]');
    if (badge) {
      if (badge.textContent !== a.state) badge.textContent = a.state;
      badge.style.setProperty('--c', cssColor(a.state));
      badge.dataset.cls = stateClass(a.state);
    }
    this.patch('[data-live="age"]', esc(duration(since(a.stateSince))));
    this.patch('[data-live="substrate"]', this.substrateHTML());
    if (a.task) {
      this.patch('[data-live="phase"]', this.phaseHTML());
      this.patch('[data-live="idle"]', this.idleRowHTML());
      this.patch('[data-live="conds"]', this.condsHTML());
    }
  }

  idleHTML(idle, after) {
    const r = this.detail.runner;
    if (r.inFlight > 0) return `<span class="busy">serving ${r.inFlight} request${r.inFlight === 1 ? '' : 's'}</span>`;
    if (r.busy) return `<span class="busy">busy (reported by the agent)</span> · idle ${duration(idle)}`;
    if (!after) return `idle ${duration(idle)} <span class="muted">(no idle policy)</span>`;
    const pct = Math.min(100, (idle / after) * 100);
    const left = Math.max(0, after - idle);
    return `<div class="idlebar"><div style="width:${pct.toFixed(1)}%"></div></div>
      <div class="idletext">idle ${duration(idle)} of ${duration(after)} · ${left > 0 ? 'suspends in ~' + duration(left) : 'suspending now'}</div>`;
  }

  idleRowHTML() {
    const d = this.detail;
    const t = d.agent.task;
    if (d.runner && d.agent.state === 'RUNNING') {
      let out = row('Idle', this.idleHTML(this.idleNow(), parseGoDuration(t.idleSuspendAfter)), 'wide');
      if (d.runner.exited) out += row('Command', `exited with code ${d.runner.exitCode}`);
      return out;
    }
    if (d.runnerNote && d.agent.state === 'RUNNING') return row('Idle', `<span class="muted">${esc(d.runnerNote)}</span>`);
    return '';
  }

  phaseHTML() {
    const t = this.detail.agent.task;
    const ready = (t.conditions || []).find((c) => c.type === 'Ready');
    return row('Phase', `<b>${esc(t.phase || '?')}</b>${ready?.reason ? ` <span class="reason ${REASON_CLASS[ready.reason] || ''}">${esc(ready.reason)}</span>` : ''}`);
  }

  condsHTML() {
    const conds = (this.detail.agent.task.conditions || [])
      .map(
        (c) => `<tr><td>${esc(c.type)}</td><td class="st-${esc(c.status)}">${esc(c.status)}</td>
        <td><span class="reason ${REASON_CLASS[c.reason] || ''}">${esc(c.reason || '')}</span>
        ${c.message ? `<div class="msg">${esc(c.message)}</div>` : ''}</td>
        <td class="muted">${c.lastTransitionTime ? duration(since(c.lastTransitionTime)) + ' ago' : ''}</td></tr>`,
      )
      .join('');
    return conds ? `<table class="conds"><thead><tr><th>Condition</th><th></th><th>Reason</th><th></th></tr></thead><tbody>${conds}</tbody></table>` : '';
  }

  substrateHTML() {
    const d = this.detail;
    const a = d.agent;
    return [
      row(
        'Worker',
        a.worker
          ? `${esc(workerLabel(d.worker) || a.workerPod || a.worker)}${a.workerNode ? `<span class="muted"> on ${esc(a.workerNode)}</span>` : ''}${this.opts.onShowWorker ? ` <button class="linkbtn" data-act="show-worker" data-worker="${esc(a.worker)}" title="Light up this worker and the agents on it">show worker</button>` : ''}`
          : '<span class="muted">none</span>',
      ),
      a.worker && a.workerIPs?.length ? row('Worker IP', a.workerIPs.map((ip) => mono(ip)).join(' ')) : '',
      // A PAUSED actor (derived by the collector since Substrate v0.5) has no
      // worker but stays attached to the node holding its local snapshot.
      !a.worker && a.assignedNode ? row('Node', `${esc(a.assignedNode)}<span class="muted"> (holds its local snapshot)</span>`) : '',
      row('Template', a.template && mono(a.template)),
      row('Snapshot', a.snapshotURI ? mono(a.snapshotURI.replace(/^gs:\/\/[^/]+\//, '…/')) : '<span class="muted">none yet</span>'),
      a.snapshotInProgress ? row('Snapshot', '<span class="busy">in progress</span>') : '',
      a.crash ? row('Crash', `<span class="crash">${esc(a.crash.message || 'crashed')}</span>${a.crash.time ? `<span class="muted"> at ${esc(clock(a.crash.time))}</span>` : ''}`) : '',
      row('Created', a.createTime && `${esc(new Date(a.createTime).toLocaleString())}`),
      row('UID', a.uid && mono(a.uid)),
    ].join('');
  }

  /** Builds the whole panel. Only on selection (and if the agent's shape changes). */
  render() {
    const d = this.detail;
    if (!d) return;
    const a = d.agent;
    const t = a.task;
    const parts = [];
    parts.push(`<div class="panel-head">
      <div><div class="atespace">${esc(a.atespace)}</div><h2>${esc(a.name)}</h2></div>
      <button class="close" data-act="close" title="Close">×</button></div>
      <div class="state-line"><span class="state-badge" data-live="state" data-cls="${stateClass(a.state)}" style="--c:${cssColor(a.state)}">${esc(a.state)}</span>
      <span class="muted">for <span data-live="age">${duration(since(a.stateSince))}</span></span></div>`);
    parts.push(`<section><h3>Agent Substrate</h3><div data-live="substrate">${this.substrateHTML()}</div>${this.rawBlockHTML('substrate')}</section>`);
    if (t) {
      const policy = [];
      if (t.idleSuspendAfter) policy.push(`suspend after ${esc(t.idleSuspendAfter)} idle`);
      if (t.idleBusyPath) policy.push(`busy check ${mono(t.idleBusyPath)}`);
      if (t.onCompletion) policy.push(`on completion: ${esc(t.onCompletion)}`);
      parts.push(`<section><h3>ax task</h3>
        <div data-live="phase">${this.phaseHTML()}</div>
        <div data-live="idle">${this.idleRowHTML()}</div>
        ${row('Idle policy', policy.join(' · ') || '<span class="muted">none (never suspended for idleness)</span>')}
        ${row('Image', t.image && mono(t.image.replace(/@sha256:([0-9a-f]{12})[0-9a-f]+/, '@sha256:$1…')))}
        ${row('Serves', t.httpPort ? `API on port ${t.httpPort} through the router` : '')}
        ${row('Workspaces', (t.workspaces || []).map(esc).join(', '))}
        <div data-live="conds">${this.condsHTML()}</div>
        ${this.rawBlockHTML('task')}
      </section>`);
    } else {
      parts.push(`<section><h3>ax task</h3><p class="muted">Not an ax task.</p></section>`);
    }
    parts.push(`<section data-sessions></section>`);
    this.el.innerHTML = parts.join('');
    this.renderSessions();
  }

  /** The collapsed YAML block for a section ("substrate" or "task"), if the collector serves raw objects. */
  rawBlockHTML(section) {
    if (!this.opts.raw && !this.opts.features?.()?.raw) return '';
    return `<details class="raw" data-raw="${section}"><summary>YAML</summary><div class="raw-body">${this.rawBodyHTML(section)}</div></details>`;
  }

  rawBodyHTML(section) {
    if (!this.raw) return '<p class="muted">Loading…</p>';
    if (this.raw.error) return `<p class="crash">${esc(this.raw.error)}</p>`;
    const items = [];
    this.raw.objects.forEach((o, i) => {
      if (o.section !== section) return;
      const head = `<div class="raw-head"><span>${esc(o.kind)} ${mono(o.name)}</span>${o.object ? `<button class="linkbtn" data-act="copy-yaml" data-i="${i}" title="Copy this YAML">copy</button>` : ''}</div>`;
      items.push(head + (o.error ? `<p class="crash">${esc(o.error)}</p>` : `<pre class="yaml">${esc(toYAML(o.object))}</pre>`));
    });
    if (!items.length) return '<p class="muted">Nothing to show.</p>';
    return items.join('') + '<p class="hint">Sensitive values (env values, tokens, file contents) are redacted by the collector.</p>';
  }

  /** Fetches the raw objects (on every open, so they're current) and fills the open blocks. */
  async loadRaw() {
    const key = this.key;
    if (!key || this.rawLoading === key) return;
    this.rawLoading = key;
    let raw;
    try {
      if (this.opts.raw) raw = this.opts.raw(key) || { objects: [] };
      else {
        const resp = await fetch(`${apiBase(key)}/raw`, { cache: 'no-store' });
        raw = resp.ok ? await resp.json() : { error: `HTTP ${resp.status}` };
      }
    } catch (err) {
      raw = { error: String(err.message || err) };
    } finally {
      if (this.rawLoading === key) this.rawLoading = null;
    }
    if (key !== this.key) return;
    this.raw = raw;
    for (const d of this.el.querySelectorAll('details.raw')) {
      const body = d.querySelector('.raw-body');
      const html = this.rawBodyHTML(d.dataset.raw);
      if (body.innerHTML !== html) body.innerHTML = html;
    }
  }

  copyYAML(btn) {
    const o = this.raw?.objects?.[Number(btn.dataset.i)];
    if (!o?.object) return;
    const done = (label) => {
      btn.textContent = label;
      setTimeout(() => (btn.textContent = 'copy'), 1500);
    };
    navigator.clipboard?.writeText(toYAML(o.object)).then(() => done('copied'), () => done('copy failed')) ?? done('copy failed');
  }

  renderSessions() {
    const el = this.el.querySelector('[data-sessions]');
    if (!el || !this.detail) return;
    el.innerHTML = this.sessionsHTML();
  }

  sessionsHTML() {
    const a = this.detail.agent;
    const t = a.task;
    const f = this.opts.features() || {};
    const head = `<h3>Sessions</h3>`;
    if (!f.attach) {
      return `${head}<p class="muted">The attach proxy is not configured on this collector.</p>`;
    }
    const running = a.state === 'RUNNING';
    let body = '';
    if (!t?.httpPort) body += `<p class="muted">This agent doesn't declare an API through the router (no spec.http.port), so it may not answer.</p>`;

    // Open, or wake first.
    if (running) {
      body += f.mastWeb
        ? `<a class="btn primary" data-act="open" href="${esc(mastWebURL(this.key))}" target="_blank" rel="noopener">Open in mast-web ↗</a>`
        : `<p class="muted">mast-web is not bundled with this collector.</p>`;
    } else if (this.wake === 'confirm') {
      body += `<div class="wake-warning"><b>Wake ${esc(a.name)}?</b> This resumes the agent: Agent Substrate's router restores it
        on a worker. It stays awake while a mast-web session is open, and suspends again once it has been idle for its idle policy.</div>
        <button class="btn warn" data-act="wake-yes">Yes, wake it</button> <button class="btn ghost" data-act="wake-no">Cancel</button>`;
    } else if (this.wake === 'waking') {
      body += this.wakeAttempt > 1
        ? `<p class="progress">Still waking (attempt ${this.wakeAttempt}): the router gave up waiting, but the resume carries on, so asking again…</p>`
        : `<p class="progress">Waking: sent a session-list request through the router…</p>`;
    } else if (this.wake === 'waiting') {
      body += `<p class="progress">Woken. Waiting for Agent Substrate to report RUNNING (it says ${esc(a.state.toLowerCase())})…</p>`;
    } else {
      body += `<p class="muted">It is ${esc(a.state.toLowerCase())}. Opening it needs a request through the router, which wakes it.</p>
        <button class="btn warn" data-act="wake">Wake agent…</button>`;
    }
    if (!running && f.mastWeb && this.wake !== 'confirm') body += ` <span class="btn primary disabled" title="Wake the agent first">Open in mast-web</span>`;

    body += `<p class="operator-note">mast-web acts as the agent's operator: the collector adds the agent's shared token,
      so there is no per-user identity, and anyone using this UI can send messages, approve or deny actions, and interrupt.
      While a session is open in mast-web the agent is serving a request, so ax won't idle-suspend it.</p>`;

    // The session list (running agents only).
    if (running) {
      let list = '';
      if (this.sessions) {
        const now = Date.now();
        list = this.sessions
          .map((s) => {
            const l = sessionLine(s, now);
            return `<div class="session"><div class="s-main"><code>${esc(l.id)}</code>${l.title ? ` <span class="s-title">${esc(l.title)}</span>` : ''}</div>
              <div class="s-meta muted">${esc([l.status, l.when].filter(Boolean).join(' · '))}</div></div>`;
          })
          .join('');
        if (!list) list = `<p class="muted">${esc(emptySessionsNote(this.woke))}</p>`;
      }
      const label = this.sessionsLoading ? 'Listing…' : this.sessions ? 'Refresh' : 'List sessions';
      body += `<div class="sessions-head"><span class="muted small">${this.sessions ? `${this.sessions.length} in memory` : 'via the attach proxy'}</span>
        <button class="btn small ghost" data-act="sessions"${this.sessionsLoading ? ' disabled' : ''}>${label}</button></div>${list}`;
      if (!this.sessions) body += `<p class="hint">Listing goes through ax's pass-through, which counts as activity and restarts the idle timer.</p>`;
    }
    if (this.sessionError) body += `<p class="error">${esc(this.sessionError)}</p>`;
    return head + body;
  }

  /** Lists sessions; wake=true sends the wake consent with the request, and retries while the wake is in progress. */
  async listSessions(wake) {
    const key = this.key;
    if (this.sessionsLoading) return;
    this.sessionsLoading = true;
    this.sessionError = '';
    this.wakeAttempt = 0;
    this.renderSessions();
    let ok = false;
    const deadline = Date.now() + WAKE_RETRY_MS;
    try {
      for (let attempt = 1; ; attempt++) {
        if (wake) {
          this.wakeAttempt = attempt;
          this.renderSessions();
        }
        let status = 0;
        let text = '';
        try {
          const resp = await fetch(`${apiBase(key)}/attach/sessions${wake ? '?scope_wake=1' : ''}`, { cache: 'no-store' });
          status = resp.status;
          text = await resp.text();
        } catch (err) {
          text = String(err);
        }
        if (key !== this.key) return;
        if (status >= 200 && status < 300) {
          this.sessions = JSON.parse(text).sessions || [];
          this.sessionError = '';
          ok = true;
          break;
        }
        // A cold wake can outlast the router's wait (504 after ~10 s on a
        // default Substrate v0.4 router) while the resume itself carries on,
        // so a wake keeps asking until the agent answers or time runs out.
        const delay = wake ? wakeRetryDelay(status, attempt) : null;
        if (delay === null || Date.now() + delay > deadline) {
          const e = status ? attachError(status, text) : { text, suspended: false };
          this.sessionError = e.text;
          if (e.suspended) this.load();
          break;
        }
        await new Promise((r) => setTimeout(r, delay));
        if (key !== this.key) return;
      }
    } finally {
      if (key === this.key) {
        this.sessionsLoading = false;
        if (wake) {
          this.woke = this.woke || ok;
          this.wake = ok && this.detail?.agent.state !== 'RUNNING' ? 'waiting' : '';
          this.load();
        }
        this.renderSessions();
      }
    }
  }

  onClick(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    switch (btn.dataset.act) {
      case 'close':
        this.opts.onClose();
        break;
      case 'show-worker':
        this.opts.onShowWorker?.(btn.dataset.worker);
        break;
      case 'copy-yaml':
        this.copyYAML(btn);
        break;
      case 'sessions':
        this.listSessions(false);
        break;
      case 'wake':
        this.wake = 'confirm';
        this.sessionError = '';
        this.renderSessions();
        break;
      case 'wake-no':
        this.wake = '';
        this.renderSessions();
        break;
      case 'wake-yes':
        this.wake = 'waking';
        this.renderSessions();
        this.listSessions(true);
        break;
      default:
        break;
    }
  }
}
