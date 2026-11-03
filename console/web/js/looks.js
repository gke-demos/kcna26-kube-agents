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

// The Router and Agents pickers next to the theme picker: two small selects
// that switch the router's look and the agents' shape live. Each takes a URL
// parameter (?router=portal|lighthouse|core|tower, ?agents=orb|spark|meeple|
// droid|box) and is remembered in localStorage. ?extras=0 turns off the
// agents' idle rings, light pools and particles (also remembered; key x).
// ?group=worker groups agents by worker instead of atespace (remembered; key g).
// ?layout=decks|combined: agents and workers on two decks (default), or one
// island (remembered). ?beams=focus|all: beams only for what is in focus
// (default), or every beam up to the budget (remembered). The decks'
// offsets and link state are remembered too (no URL parameter).

import { ROUTERS, DEFAULT_ROUTER, routerId } from './routers.js';
import { SHAPES, DEFAULT_SHAPE, shapeById } from './shapes.js';
import { groupId } from './workers.js';
import { layoutId, beamModeId, parseOffsets, serializeOffsets } from './decks.js';

const STORE = {
  router: 'substrate-scope:router',
  agents: 'substrate-scope:agents',
  extras: 'substrate-scope:extras',
  group: 'substrate-scope:group',
  layout: 'substrate-scope:layout',
  beams: 'substrate-scope:beams',
  decks: 'substrate-scope:decks',
};

function stored(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage blocked: still works for this page */
  }
}

/** The initial choices: URL parameter, then localStorage, then the defaults. */
export function initialLooks(search = window.location.search) {
  const params = new URLSearchParams(search);
  const router = routerId(params.get('router') || stored(STORE.router) || DEFAULT_ROUTER);
  const agents = shapeById(params.get('agents') || stored(STORE.agents) || DEFAULT_SHAPE).id;
  const ex = params.get('extras') ?? stored(STORE.extras);
  const extras = !(ex === '0' || ex === 'off' || ex === 'false');
  const group = groupId(params.get('group') || stored(STORE.group));
  const layout = layoutId(params.get('layout') || stored(STORE.layout));
  const beams = beamModeId(params.get('beams') || stored(STORE.beams));
  return { router, agents, extras, group, layout, beams };
}

/** Remembers the beam mode (localStorage and the URL). */
export function rememberBeams(mode) {
  store(STORE.beams, mode);
  const url = new URL(window.location.href);
  url.searchParams.set('beams', mode);
  history.replaceState(null, '', url);
}

/** The decks' offsets and link state from the last visit (the default when none). */
export function storedDecks() {
  return parseOffsets(stored(STORE.decks));
}

/** Remembers the decks' offsets and link state. */
export function storeDecks(o) {
  store(STORE.decks, serializeOffsets(o));
}

/** Remembers the layout (localStorage and the URL). */
export function rememberLayout(id) {
  store(STORE.layout, id);
  const url = new URL(window.location.href);
  url.searchParams.set('layout', id);
  history.replaceState(null, '', url);
}

/** Remembers the grouping (localStorage and the URL). */
export function rememberGroup(mode) {
  store(STORE.group, mode);
  const url = new URL(window.location.href);
  url.searchParams.set('group', mode);
  history.replaceState(null, '', url);
}

export class LookPicker {
  /**
   * @param {{router: HTMLSelectElement, agents: HTMLSelectElement}} els
   * @param {{onRouter: (id: string) => void, onAgents: (id: string) => void, onExtras: (on: boolean) => void}} handlers
   */
  constructor(els, handlers) {
    this.els = els;
    this.h = handlers;
    const init = initialLooks();
    this.router = init.router;
    this.agents = init.agents;
    this.extras = init.extras;
    els.router.innerHTML = ROUTERS.map((r) => `<option value="${r.id}">${r.name}</option>`).join('');
    els.agents.innerHTML = SHAPES.map((x) => `<option value="${x.id}">${x.name}</option>`).join('');
    els.router.value = this.router;
    els.agents.value = this.agents;
    els.router.addEventListener('change', () => this.setRouter(els.router.value, true));
    els.agents.addEventListener('change', () => this.setAgents(els.agents.value, true));
  }

  setRouter(id, remember = false) {
    this.router = routerId(id);
    this.els.router.value = this.router;
    if (remember) this.remember('router', STORE.router, this.router);
    this.h.onRouter(this.router);
  }

  setAgents(id, remember = false) {
    this.agents = shapeById(id).id;
    this.els.agents.value = this.agents;
    if (remember) this.remember('agents', STORE.agents, this.agents);
    this.h.onAgents(this.agents);
  }

  toggleExtras() {
    this.extras = !this.extras;
    this.remember('extras', STORE.extras, this.extras ? '1' : '0');
    this.h.onExtras(this.extras);
  }

  remember(param, key, value) {
    store(key, value);
    const url = new URL(window.location.href);
    url.searchParams.set(param, value);
    history.replaceState(null, '', url);
  }

  /** One step of ?tour=shapes: the next agent shape and the next router. */
  tourStep() {
    const si = SHAPES.findIndex((x) => x.id === this.agents);
    const ri = ROUTERS.findIndex((r) => r.id === this.router);
    this.setAgents(SHAPES[(si + 1) % SHAPES.length].id);
    this.setRouter(ROUTERS[(ri + 1) % ROUTERS.length].id);
    return `${shapeById(this.agents).name} agents · ${ROUTERS.find((r) => r.id === this.router).name} router`;
  }
}
