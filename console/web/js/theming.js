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

// The theme picker in the header: applies a theme to the page (CSS custom
// properties) and the scene, remembers it, and takes ?theme=<id>. With
// ?tour=1 it cycles through every theme (for comparing them); ?tour=shapes
// also steps the agent shape and router look each time (see looks.js).

import { THEMES, themeById, cssVars } from './themes.js';

const STORE = 'substrate-scope:theme';
const TOUR_SECONDS = 8;

function stored() {
  try {
    return localStorage.getItem(STORE);
  } catch {
    return null;
  }
}

/** Little four-color swatch of a theme: background, running, changing, accent. */
function swatch(t) {
  const c = [t.scene.background, t.states.running, t.states.changing, t.ui.accent];
  return `<span class="theme-sw" style="--s0:${c[0]};--s1:${c[1]};--s2:${c[2]};--s3:${c[3]}"><i></i><i></i><i></i></span>`;
}

export class ThemePicker {
  /**
   * @param {HTMLElement} root the picker's container in the header
   * @param {(theme: object) => void} onChange called after the page's CSS is updated
   * @param {{onTourStep?: () => string}} opts onTourStep: ?tour=shapes, returns text for the toast
   */
  constructor(root, onChange, opts = {}) {
    this.root = root;
    this.onChange = onChange;
    this.onTourStep = opts.onTourStep;
    const params = new URLSearchParams(window.location.search);
    const want = params.get('theme') || stored();
    this.theme = themeById(want);

    root.innerHTML = `<button class="theme-btn" aria-haspopup="listbox" aria-expanded="false" title="Theme"></button>
      <div class="theme-menu" role="listbox" aria-label="Theme" hidden>
        ${THEMES.map((t) => `<button role="option" class="theme-opt" data-id="${t.id}">${swatch(t)}<span class="theme-name">${t.name}</span><span class="theme-mode">${t.mode}</span></button>`).join('')}
      </div>`;
    this.btn = root.querySelector('.theme-btn');
    this.menu = root.querySelector('.theme-menu');
    this.btn.addEventListener('click', () => this.open(this.menu.hidden));
    this.menu.addEventListener('click', (e) => {
      const opt = e.target.closest('.theme-opt');
      if (!opt) return;
      this.stopTour();
      this.set(opt.dataset.id, true);
      this.open(false);
      this.btn.focus();
    });
    this.menu.addEventListener('keydown', (e) => {
      const opts = [...this.menu.querySelectorAll('.theme-opt')];
      const i = opts.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') opts[(i + 1) % opts.length].focus();
      else if (e.key === 'ArrowUp') opts[(i - 1 + opts.length) % opts.length].focus();
      else if (e.key === 'Escape') {
        this.open(false);
        this.btn.focus();
      } else return;
      e.preventDefault();
      e.stopPropagation();
    });
    document.addEventListener('pointerdown', (e) => {
      if (!root.contains(e.target)) this.open(false);
    });

    this.apply();
    const tour = params.get('tour');
    if (tour) this.startTour(tour === 'shapes' && this.onTourStep);
  }

  open(on) {
    this.menu.hidden = !on;
    this.btn.setAttribute('aria-expanded', String(on));
    if (on) this.menu.querySelector(`[data-id="${this.theme.id}"]`)?.focus();
  }

  /** Switches theme. remember: store it and put it in the URL. */
  set(id, remember = false) {
    this.theme = themeById(id);
    if (remember) {
      try {
        localStorage.setItem(STORE, this.theme.id);
      } catch {
        /* storage blocked: still works for this page */
      }
      const url = new URL(window.location.href);
      url.searchParams.set('theme', this.theme.id);
      history.replaceState(null, '', url);
    }
    this.apply();
  }

  apply() {
    const t = this.theme;
    const style = document.documentElement.style;
    for (const [k, v] of Object.entries(cssVars(t))) style.setProperty(k, v);
    document.documentElement.dataset.theme = t.id;
    document.documentElement.dataset.mode = t.mode;
    document.documentElement.style.colorScheme = t.mode;
    this.btn.innerHTML = `${swatch(t)}<span class="theme-name">${t.name}</span><span class="caret">▾</span>`;
    this.menu.querySelectorAll('.theme-opt').forEach((o) => o.setAttribute('aria-selected', String(o.dataset.id === t.id)));
    this.onChange?.(t);
  }

  /** Cycles themes; with shapes, also steps the agent shape and router. */
  startTour(shapes = false) {
    this.tour = setInterval(() => {
      const i = THEMES.indexOf(this.theme);
      this.set(THEMES[(i + 1) % THEMES.length].id);
      this.toast(shapes ? `${this.theme.name} · ${this.onTourStep()}` : this.theme.name);
    }, TOUR_SECONDS * 1000);
    this.toast(`${this.theme.name} · touring all themes${shapes ? ', shapes and routers' : ''} every ${TOUR_SECONDS}s`);
  }

  stopTour() {
    if (this.tour) clearInterval(this.tour);
    this.tour = null;
  }

  toast(text) {
    let el = document.getElementById('theme-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'theme-toast';
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
  }
}

