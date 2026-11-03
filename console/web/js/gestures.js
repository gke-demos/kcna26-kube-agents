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

// Direct manipulation on top of OrbitControls. OrbitControls keeps what it
// does well (left-drag orbits, the wheel and pinches zoom toward the
// cursor, one finger orbits, two fingers pan and pinch); this takes the
// gestures it would get wrong or doesn't have, by listening on the
// viewport in the capture phase, before the controls see the event:
//
// - pan in the screen plane, with the point under the cursor staying under
//   it: right-drag, Shift+drag, or a two-finger trackpad scroll (a mouse
//   wheel still zooms);
// - move a deck: drag its rim (highlighted on hover) or Option/Alt-drag
//   anywhere on it; Shift while dragging changes its height instead (the
//   gap between the decks); on touch, long-press a rim, then drag.
//
// A press without movement is still a click (Shift+click selects).

import { WheelKind } from './decks.js';

/** Pixels a press may move and still be a click. */
const CLICK_PX = 5;
/** Touch: how long to hold a deck's rim before it can be dragged, and how far the finger may wander meanwhile. */
const LONG_PRESS_MS = 450;
const LONG_PRESS_PX = 8;

export class Gestures {
  /**
   * @param {HTMLElement} el the viewport (parent of the canvas and the label layer)
   * @param {import('./scene.js').Scene} scene
   * @param {{onDrag?: (kind: string|null) => void}} handlers
   */
  constructor(el, scene, handlers = {}) {
    this.el = el;
    this.scene = scene;
    this.h = handlers;
    this.g = null;
    this.wheel = new WheelKind();
    this.wheelDepth = null;
    this.press = null;
    this.onMove = (e) => this.move(e);
    this.onUp = (e) => this.up(e);
    el.addEventListener('pointerdown', (e) => this.down(e), { capture: true });
    el.addEventListener('wheel', (e) => this.onWheel(e), { capture: true, passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    const mods = (e) => {
      if (scene.altDown === e.altKey) return;
      scene.altDown = e.altKey;
      // Option/Alt shows the grab outline on the deck under the pointer right away.
      scene.lastHoverPick = -1;
    };
    window.addEventListener('keydown', mods);
    window.addEventListener('keyup', mods);
    window.addEventListener('blur', () => (scene.altDown = false));
  }

  down(e) {
    if (this.g) return;
    if (e.pointerType === 'touch') {
      this.touchDown(e);
      return;
    }
    const sc = this.scene;
    if (e.button === 0) {
      const hit = sc.deckHandleAt(e.clientX, e.clientY, e.altKey);
      if (hit && (hit.zone === 'rim' || e.altKey)) {
        this.stop(e);
        this.begin(e, 'deck', hit);
        return;
      }
      if (e.shiftKey) {
        this.stop(e);
        this.begin(e, 'pan');
      }
      return;
    }
    if (e.button === 2) {
      this.stop(e);
      this.begin(e, 'pan');
    }
  }

  stop(e) {
    e.stopPropagation();
    e.preventDefault();
  }

  begin(e, kind, hit = null) {
    const sc = this.scene;
    this.g = { kind, id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, moved: false, button: e.button, shift: e.shiftKey, touch: e.pointerType === 'touch' };
    sc.flyAnim = null;
    sc.dragging = kind;
    if (kind === 'deck') sc.startDeckDrag(hit, e.clientX, e.clientY, e.shiftKey);
    else this.g.depth = sc.grabDepth(e.clientX, e.clientY);
    try {
      this.el.setPointerCapture(e.pointerId);
    } catch {
      /* the pointer is gone already */
    }
    window.addEventListener('pointermove', this.onMove, true);
    window.addEventListener('pointerup', this.onUp, true);
    window.addEventListener('pointercancel', this.onUp, true);
    this.h.onDrag?.(kind);
  }

  move(e) {
    const g = this.g;
    if (!g || e.pointerId !== g.id) return;
    e.stopPropagation();
    if (Math.hypot(e.clientX - g.x0, e.clientY - g.y0) > CLICK_PX) g.moved = true;
    const sc = this.scene;
    if (g.kind === 'deck') {
      // Shift pressed or released mid-drag: carry on from here in the other mode.
      if (e.shiftKey !== g.shift) {
        g.shift = e.shiftKey;
        sc.startDeckDrag(null, e.clientX, e.clientY, g.shift);
      }
      sc.dragDeck(e.clientX, e.clientY);
    } else {
      sc.panScreen(e.clientX - g.x, e.clientY - g.y, g.depth);
    }
    g.x = e.clientX;
    g.y = e.clientY;
  }

  up(e) {
    const g = this.g;
    if (!g || e.pointerId !== g.id) return;
    // Not stopped: the controls (touch) track their pointers to the end.
    this.g = null;
    window.removeEventListener('pointermove', this.onMove, true);
    window.removeEventListener('pointerup', this.onUp, true);
    window.removeEventListener('pointercancel', this.onUp, true);
    try {
      this.el.releasePointerCapture(e.pointerId);
    } catch {
      /* released already */
    }
    const sc = this.scene;
    sc.dragging = null;
    if (g.kind === 'deck') sc.endDeckDrag();
    if (g.touch) sc.controls.enabled = !sc.cameraDriver;
    // Shift+click (a pan that didn't move) still selects.
    if (g.kind === 'pan' && !g.moved && g.button === 0 && e.type === 'pointerup') sc.clickAt(e.clientX, e.clientY);
    sc.lastHoverPick = -1;
    this.h.onDrag?.(null);
  }

  /** Touch: the controls orbit and pinch as usual; holding still on a deck's rim picks the deck up. */
  touchDown(e) {
    const sc = this.scene;
    this.cancelPress();
    const hit = sc.deckHandleAt(e.clientX, e.clientY, false);
    if (!hit || hit.zone !== 'rim') return;
    const p = { id: e.pointerId, x: e.clientX, y: e.clientY, hit };
    const track = (m) => {
      if (m.pointerId !== p.id) {
        // A second finger: a pinch or pan, not a deck move.
        if (m.type === 'pointerdown') this.cancelPress();
        return;
      }
      if (m.type !== 'pointermove' || Math.hypot(m.clientX - p.x, m.clientY - p.y) > LONG_PRESS_PX) this.cancelPress();
    };
    p.track = track;
    p.timer = setTimeout(() => {
      this.cancelPress();
      // Take the finger from the controls (they ignore moves while disabled).
      sc.controls.enabled = false;
      sc.suppressClick = true;
      navigator.vibrate?.(12);
      this.begin({ pointerId: p.id, clientX: p.x, clientY: p.y, button: 0, shiftKey: false, pointerType: 'touch' }, 'deck', p.hit);
    }, LONG_PRESS_MS);
    for (const t of ['pointermove', 'pointerup', 'pointercancel', 'pointerdown']) window.addEventListener(t, track, true);
    this.press = p;
  }

  cancelPress() {
    const p = this.press;
    if (!p) return;
    this.press = null;
    clearTimeout(p.timer);
    for (const t of ['pointermove', 'pointerup', 'pointercancel', 'pointerdown']) window.removeEventListener(t, p.track, true);
  }

  /** Two-finger trackpad scrolls pan (directly, at the depth under the cursor); mouse wheels and pinches zoom (the controls). */
  onWheel(e) {
    if (this.scene.cameraDriver) return;
    const now = performance.now();
    if (this.wheel.classify(e, now) !== 'pan') {
      this.wheelDepth = null;
      return;
    }
    this.stop(e);
    const sc = this.scene;
    // One depth per scroll stream, so a long scroll moves evenly.
    if (!this.wheelDepth || now - this.wheelDepth.at > 300) this.wheelDepth = { depth: sc.grabDepth(e.clientX, e.clientY) };
    this.wheelDepth.at = now;
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    sc.flyAnim = null;
    sc.panScreen(-e.deltaX * k, -e.deltaY * k, this.wheelDepth.depth);
  }
}
