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

// The control panel (fleet-scope): "Break something" buttons and Reset,
// shown only when the snapshot says this user may press them
// (features.actions). No keyboard shortcuts on purpose: nothing fires from
// a stray key press on stage.

import { esc } from './format.js';

/** Header every POST carries (the server refuses a cross-site form without it). */
export const ACTION_HEADER = 'X-Fleet-Scope';

/** The collector's action API, relative to the page. */
export const httpActions = {
  async actions() {
    const r = await fetch('api/actions', { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  },
  async runAction(name, target) {
    const r = await fetch(`api/actions/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [ACTION_HEADER]: '1' },
      body: JSON.stringify(target ? { target } : {}),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(text.trim() || `HTTP ${r.status}`);
    try {
      return JSON.parse(text);
    } catch {
      return { title: text.trim() };
    }
  },
};

/** Whether an action is the reset (it gets its own button and a confirm). */
export function isReset(a) {
  return a.name === 'reset' || (!a.targets?.length && /reset/i.test(a.name + a.title));
}

export class ControlPanel {
  /**
   * @param {HTMLElement} el
   * @param {{actions: Function, runAction: Function}} api
   * @param {{onPress?: (action: any, target: string) => any, onResult?: (token: any, result: any) => void, onError?: (token: any, err: any) => void}} [hooks]
   *   follow a press (the incident tracker): onPress returns a token the other two get back
   */
  constructor(el, api, hooks = {}) {
    this.el = el;
    this.api = api;
    this.hooks = hooks;
    this.list = null;
    this.busy = '';
    this.result = null;
    this.enabled = false;
    this.collapsed = false;
    el.addEventListener('click', (e) => this.onClick(e));
  }

  /** An action's button title, or ''. */
  titleOf(name) {
    return (this.list || []).find((a) => a.name === name)?.title || '';
  }

  /** Shows or hides the panel (features.actions); loads the actions once shown. */
  setEnabled(on) {
    on = !!on;
    if (on === this.enabled) return;
    this.enabled = on;
    this.el.hidden = !on;
    if (on && !this.list) this.load();
    this.render();
  }

  async load() {
    try {
      this.list = await this.api.actions();
    } catch (err) {
      this.list = [];
      this.result = { error: `Could not list actions: ${err.message || err}` };
    }
    this.render();
  }

  render() {
    if (!this.enabled) return;
    const keep = {};
    for (const s of this.el.querySelectorAll('select[data-for]')) keep[s.dataset.for] = s.value;
    const list = this.list || [];
    const breakers = list.filter((a) => !isReset(a));
    const reset = list.find(isReset);
    const dis = this.busy ? ' disabled' : '';
    const rows = breakers
      .map((a) => {
        const sel = a.targets?.length
          ? `<select data-for="${esc(a.name)}" aria-label="Target for ${esc(a.title)}"${dis}>${a.targets.map((t) => `<option value="${esc(t)}"${keep[a.name] === t ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select>`
          : '';
        return `<div class="ctl-row"><button class="btn warn" data-run="${esc(a.name)}"${dis}>${this.busy === a.name ? 'Working…' : esc(a.title)}</button>${sel}</div>`;
      })
      .join('');
    let res = '';
    if (this.result?.error) res = `<p class="ctl-result error">${esc(this.result.error)}</p>`;
    else if (this.result) res = `<p class="ctl-result ok">${esc(this.result.title || 'Done')}${this.result.link ? ` <a href="${esc(this.result.link)}" target="_blank" rel="noopener">↗</a>` : ''}</p>`;
    this.el.innerHTML = `<div class="ctl-head"><h3>Break something</h3><button class="close" data-act="collapse" title="${this.collapsed ? 'Show' : 'Hide'} the controls">${this.collapsed ? '+' : '−'}</button></div>
      <div class="ctl-body"${this.collapsed ? ' hidden' : ''}>
        ${this.list ? rows || '<p class="muted small">No actions configured.</p>' : '<p class="muted small">Loading…</p>'}
        ${reset ? `<div class="ctl-row reset"><button class="btn ghost" data-run="${esc(reset.name)}" data-confirm="1"${dis}>${this.busy === reset.name ? 'Resetting…' : esc(reset.title || 'Reset')}</button></div>` : ''}
        ${res}
      </div>`;
  }

  async run(name, confirmFirst) {
    if (this.busy) return;
    const a = (this.list || []).find((x) => x.name === name);
    if (!a) return;
    if (confirmFirst && !window.confirm(`${a.title || 'Reset'}?\n\nThis puts every workload back to the demo baseline.`)) return;
    const target = this.el.querySelector(`select[data-for="${CSS.escape(name)}"]`)?.value || '';
    this.busy = name;
    this.result = null;
    this.render();
    const token = this.hooks.onPress?.(a, target);
    try {
      this.result = (await this.api.runAction(name, target)) || {};
      this.hooks.onResult?.(token, this.result);
    } catch (err) {
      this.result = { error: String(err.message || err) };
      this.hooks.onError?.(token, err);
    } finally {
      this.busy = '';
      this.render();
    }
  }

  onClick(e) {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    if (b.dataset.act === 'collapse') {
      this.collapsed = !this.collapsed;
      this.render();
    } else if (b.dataset.run) this.run(b.dataset.run, b.dataset.confirm === '1');
  }
}
