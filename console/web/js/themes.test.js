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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { THEMES, TOKENS, OPTIONAL, DEFAULT_THEME, themeById, token, cssVars, contrast, over, parseColor } from './themes.js';

function leaves(o, prefix = '') {
  return Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? leaves(v, `${prefix}${k}.`) : [`${prefix}${k}`]));
}

test('every theme defines every token, and nothing else', () => {
  assert.equal(THEMES.length, 8);
  for (const t of THEMES) {
    for (const path of TOKENS) {
      const v = token(t, path);
      assert.notEqual(v, undefined, `${t.id}: ${path} missing`);
      if (!OPTIONAL.has(path)) assert.notEqual(v, null, `${t.id}: ${path} is null`);
    }
    assert.deepEqual(leaves(t).sort(), [...TOKENS].sort(), `${t.id}: unexpected tokens`);
    for (const path of TOKENS.filter((p) => /^(scene|island|district|worker|router|links|states|effects|marker)\./.test(p))) {
      const v = token(t, path);
      if (typeof v === 'string') assert.doesNotThrow(() => parseColor(v), `${t.id}: ${path} is not a color`);
    }
  }
});

test('ids are unique and the default exists', () => {
  assert.equal(new Set(THEMES.map((t) => t.id)).size, THEMES.length);
  assert.equal(themeById(DEFAULT_THEME).id, DEFAULT_THEME);
  assert.equal(themeById('no-such-theme').id, DEFAULT_THEME);
});

// The validated state palettes: change only as a set, after re-checking them.
const VALIDATED = {
  'orchid-night': ['#140b22', '#9a6cf2', '#b09000', '#e8306b', '#4b3f6b', '#ff7ac8'],
  'abyss-neon': ['#07111f', '#0fa395', '#8f7bff', '#ec3d5a', '#2c3e63', '#2ee6d6'],
  'volt-noir': ['#0c0c0f', '#6aa61a', '#2f95c8', '#e83a8a', '#3a3a44', '#c6ff3d'],
  'cotton-candy': ['#fbf4ff', '#7b3fe4', '#a87a00', '#d11f6f', '#cdbfe6', '#ff5fa2'],
  'riso-paper': ['#f6f1e7', '#009a93', '#3a5bd9', '#e5392b', '#c9c0b0', '#ff48b0'],
  glacier: ['#eef4fb', '#0062e6', '#9a7a00', '#d11f6f', '#b7c6da', '#7c3aed'],
  'google-light': ['#f8f9fa', '#188038', '#9334e6', '#d93025', '#bdc1c6', '#1a73e8'],
  'google-dark': ['#202124', '#34a853', '#af5cf7', '#e52592', '#5f6368', '#8ab4f8'],
};

test('state colors are the validated palettes', () => {
  for (const t of THEMES) {
    const s = t.states;
    assert.deepEqual([t.scene.background, s.running, s.changing, s.crashed, s.suspended, t.ui.accent], VALIDATED[t.id], t.id);
    // Pending is drawn as an outline in muted ink.
    assert.equal(s.pending, t.ui.muted, `${t.id}: pending should be the muted ink`);
  }
});

test('text meets WCAG AA on every surface', () => {
  const AA = 4.5;
  for (const t of THEMES) {
    const u = t.ui;
    const bg = t.scene.background;
    const panels = { glass: over(u.glass, bg), glassStrong: over(u.glassStrong, bg) };
    for (const [surface, c] of Object.entries(panels)) {
      for (const k of ['text', 'text2', 'muted']) {
        assert.ok(contrast(u[k], c) >= AA, `${t.id}: ${k} on ${surface} is ${contrast(u[k], c).toFixed(2)}`);
      }
    }
    // Labels float over the scene: check over the background and a district.
    for (const ground of [bg, t.district.fill]) {
      const label = over(u.labelBg, ground);
      for (const k of ['text', 'text2', 'muted']) assert.ok(contrast(u[k], label) >= AA, `${t.id}: ${k} on a label over ${ground}`);
    }
    assert.ok(contrast(u.accentText, u.accent) >= AA, `${t.id}: accent text`);
    assert.ok(contrast(u.primaryText, u.primaryBg) >= AA, `${t.id}: primary button text`);
    const btn = over(u.btnBg, panels.glassStrong);
    assert.ok(contrast(u.btnText, btn) >= AA, `${t.id}: button text ${contrast(u.btnText, btn).toFixed(2)}`);
    const warn = over(u.warnBg, panels.glassStrong);
    assert.ok(contrast(u.text, warn) >= AA, `${t.id}: text on warnings`);
  }
});

test('the stylesheet uses only variables a theme sets', () => {
  const css = fs.readFileSync(new URL('../style.css', import.meta.url), 'utf8');
  const used = new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]));
  // Set locally in CSS or inline by scripts.
  const local = new Set(['--font', '--mono', '--c', '--ci', '--s0', '--s1', '--s2', '--s3']);
  for (const t of THEMES) {
    const vars = cssVars(t);
    for (const v of used) if (!local.has(v)) assert.ok(v in vars, `${t.id}: ${v} is not set by the theme`);
  }
});
