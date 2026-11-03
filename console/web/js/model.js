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

// The browser's copy of the collector's picture, kept current from the
// stream. Pure data, no DOM or three.js.

/** Visual classes: one InstancedMesh each. */
export const CLASSES = ['running', 'transition', 'suspended', 'crashed', 'pending'];

/** Maps a Substrate state to its visual class. */
export function stateClass(state) {
  switch (state) {
    case 'RUNNING':
      return 'running';
    case 'RESUMING':
    case 'SUSPENDING':
    case 'PAUSING':
    case 'REVERTING':
    case 'DELETING':
      return 'transition';
    case 'SUSPENDED':
    case 'PAUSED':
      return 'suspended';
    case 'CRASHED':
      return 'crashed';
    default:
      return 'pending';
  }
}

/** Human label of a visual class. */
export const CLASS_LABEL = {
  running: 'Running',
  transition: 'Changing',
  suspended: 'Suspended',
  crashed: 'Crashed',
  pending: 'Pending',
};

export class Model {
  constructor() {
    this.reset();
  }

  reset() {
    this.cluster = '';
    this.source = '';
    this.seq = 0;
    this.features = {};
    this.sources = [];
    /** @type {Map<string, any>} */
    this.agents = new Map();
    /** @type {Map<string, any>} */
    this.workers = new Map();
    /** @type {Map<string, any>} */
    this.atespaces = new Map();
  }

  applySnapshot(snap) {
    this.reset();
    this.cluster = snap.cluster;
    this.source = snap.source;
    this.seq = snap.seq;
    this.features = snap.features || {};
    this.sources = snap.sources || [];
    for (const a of snap.atespaces || []) this.atespaces.set(a.name, a);
    for (const a of snap.agents || []) this.agents.set(`${a.atespace}/${a.name}`, a);
    for (const w of snap.workers || []) this.workers.set(w.name, w);
  }

  /**
   * Applies a batch of events. Returns false if the batch doesn't follow the
   * last sequence number (the caller should resync).
   */
  applyEvents(events) {
    if (!events.length) return true;
    if (events[0].seq !== this.seq + 1) return false;
    for (const ev of events) {
      this.seq = ev.seq;
      switch (ev.type) {
        case 'atespace_added':
          this.atespaces.set(ev.key, ev.atespace);
          break;
        case 'atespace_removed':
          this.atespaces.delete(ev.key);
          break;
        case 'worker_added':
        case 'worker_updated':
          this.workers.set(ev.key, ev.worker);
          break;
        case 'worker_removed':
          this.workers.delete(ev.key);
          break;
        case 'agent_removed':
          this.agents.delete(ev.key);
          break;
        default:
          if (ev.agent) this.agents.set(ev.key, ev.agent);
      }
    }
    return true;
  }

  /** Counts agents per visual class. */
  counts() {
    const c = Object.fromEntries(CLASSES.map((k) => [k, 0]));
    for (const a of this.agents.values()) c[stateClass(a.state)]++;
    return c;
  }

  /** Agents per atespace (including empty atespaces). */
  atespaceCounts() {
    const m = new Map();
    for (const name of this.atespaces.keys()) m.set(name, 0);
    for (const a of this.agents.values()) m.set(a.atespace, (m.get(a.atespace) || 0) + 1);
    return m;
  }
}

/** Builds a predicate from the filter state. */
export function makeFilter({ atespace = '', classes = null, prefix = '' } = {}) {
  const p = prefix.trim().toLowerCase();
  return (a) => {
    if (atespace && a.atespace !== atespace) return false;
    if (classes && !classes.has(stateClass(a.state))) return false;
    if (p && !a.name.toLowerCase().startsWith(p) && !`${a.atespace}/${a.name}`.toLowerCase().startsWith(p)) {
      return false;
    }
    return true;
  };
}
