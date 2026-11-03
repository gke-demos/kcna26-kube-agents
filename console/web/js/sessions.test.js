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
import { apiBase, mastWebURL, sessionLine, emptySessionsNote, attachError } from './sessions.js';
import * as S from './sessions.js';

test('paths are relative and escaped', () => {
  assert.equal(apiBase('cred-test/lookout-1'), 'api/agents/cred-test/lookout-1');
  assert.equal(mastWebURL('cred-test/a b'), 'mast-web/a/cred-test/a%20b/');
});

test('sessionLine shows title and last activity', () => {
  const now = Date.parse('2026-10-08T12:00:00Z');
  const l = sessionLine({ sessionID: 'incident-1', title: 'checkout crash', status: 'idle', last_touched_at: '2026-10-08T11:57:00Z' }, now);
  assert.deepEqual(l, { id: 'incident-1', title: 'checkout crash', status: 'idle', when: 'last activity 3m 00s ago' });
  assert.equal(sessionLine({ id: 'x', title: 'x' }, now).title, '');
});

test('empty list after a wake explains in-memory listing', () => {
  assert.match(emptySessionsNote(true), /in memory/);
  assert.match(emptySessionsNote(true), /woken/);
  assert.doesNotMatch(emptySessionsNote(false), /woken/);
});

test('attachError recognises the wake refusal', () => {
  const e = attachError(409, JSON.stringify({ error: 'agent is SUSPENDED', state: 'SUSPENDED', wakes: true }));
  assert.equal(e.suspended, true);
  assert.match(e.text, /suspended now/);
  assert.deepEqual(attachError(502, 'attach proxy: boom'), { suspended: false, text: '502: attach proxy: boom' });
});

// A cold wake can outlast the router's wait (504 after ~10 s on a default
// Substrate v0.4 router) while the resume carries on, so Wake retries gateway
// and network errors with a growing delay, and stops on anything else.
test('wake retries gateway and network errors, not other failures', () => {
  assert.equal(S.wakeRetryDelay(504, 1), 1000);
  assert.equal(S.wakeRetryDelay(503, 2), 2000);
  assert.equal(S.wakeRetryDelay(502, 3), 3000);
  assert.equal(S.wakeRetryDelay(0, 9), 5000, 'network error; delay capped at 5 s');
  for (const status of [401, 403, 404, 409, 500]) assert.equal(S.wakeRetryDelay(status, 1), null, `HTTP ${status} is final`);
  assert.ok(S.WAKE_RETRY_MS >= 30000, 'long enough for a cold resume');
});
