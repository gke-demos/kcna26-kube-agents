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
import { Model, stateClass, makeFilter } from './model.js';
import { describe } from './feed.js';

const snap = {
  cluster: 'c',
  seq: 10,
  atespaces: [{ name: 'a' }],
  agents: [{ atespace: 'a', name: 'x', state: 'SUSPENDED' }],
  workers: [],
  features: { attach: true },
};

test('applyEvents follows sequence numbers and rejects gaps', () => {
  const m = new Model();
  m.applySnapshot(snap);
  const woke = { atespace: 'a', name: 'x', state: 'RUNNING' };
  assert.equal(m.applyEvents([{ seq: 11, type: 'agent_state', key: 'a/x', agent: woke, from: 'SUSPENDED', to: 'RUNNING' }]), true);
  assert.equal(m.agents.get('a/x').state, 'RUNNING');
  assert.equal(m.applyEvents([{ seq: 13, type: 'agent_removed', key: 'a/x' }]), false);
  assert.equal(m.agents.size, 1);
  assert.equal(m.applyEvents([{ seq: 12, type: 'agent_removed', key: 'a/x' }]), true);
  assert.equal(m.agents.size, 0);
});

test('state classes and filters', () => {
  assert.equal(stateClass('RUNNING'), 'running');
  assert.equal(stateClass('SUSPENDING'), 'transition');
  // PAUSING and PAUSED are derived by the collector (Substrate v0.5 dropped
  // them); REVERTING is v0.5's crash-recovery state.
  assert.equal(stateClass('PAUSING'), 'transition');
  assert.equal(stateClass('PAUSED'), 'suspended');
  assert.equal(stateClass('REVERTING'), 'transition');
  assert.equal(stateClass('CRASHED'), 'crashed');
  assert.equal(stateClass('UNSPECIFIED'), 'pending');
  const f = makeFilter({ prefix: 'look', classes: new Set(['running']) });
  assert.equal(f({ atespace: 'a', name: 'lookout-1', state: 'RUNNING' }), true);
  assert.equal(f({ atespace: 'a', name: 'lookout-1', state: 'SUSPENDED' }), false);
  assert.equal(f({ atespace: 'a', name: 'mast', state: 'RUNNING' }), false);
});

test('feed prefers the meaningful event over the raw state change', () => {
  const agent = { atespace: 'a', name: 'x', state: 'RUNNING' };
  const lines = describe([
    { seq: 1, type: 'agent_state', key: 'a/x', agent, from: 'SUSPENDED', to: 'RUNNING' },
    { seq: 2, type: 'agent_woke', key: 'a/x', agent, from: 'SUSPENDED', reason: 'ResumedByRequest' },
  ]);
  assert.equal(lines.length, 1);
  assert.match(lines[0].text, /woke by a request/);
});
