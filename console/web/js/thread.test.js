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
import { buildThread, threadStatus, chosenLetter, latestThread, isBot, tsMillis } from './thread.js';

const KEY = 'boutique-prod/recommendationservice';
const T = '1793641808.988429';
const at = (s) => new Date(tsMillis(T) + s * 1000).toISOString();
const tsAt = (s) => (Number(T) + s).toFixed(6);
const OPTIONS = [
  { letter: 'A', label: 'Revert to working 32Mi' },
  { letter: 'B', label: 'Increase to 64Mi with headroom', recommended: true },
];

/** The real incident's shape: alert, cards, a report, the button press (an edit of the report), PR events from GitHub. */
function incident() {
  return [
    { type: 'alert', key: KEY, cluster: 'boutique-prod', title: 'recommendationservice crashloop', thread: T, ts: T, time: at(0), actor: 'kube-agents', text: ':rotating_light: *recommendationservice in boutique-prod keeps crashing.*', permalink: 'https://s/p1' },
    { type: 'triage', key: KEY, thread: T, ts: tsAt(60), time: at(60), actor: 'kube-agents', text: 'Triage pod (BackOff)', title: 'Triage pod' },
    // The card is edited: same ts, new text; the latest wins.
    { type: 'triage', key: KEY, thread: T, ts: tsAt(60), time: at(60), actor: 'kube-agents', text: 'Found rev 3 at 20Mi', title: 'Found rev 3' },
    { type: 'triage_report', key: KEY, thread: T, ts: tsAt(120), time: at(120), actor: 'kube-agents', text: "*What's wrong*", title: 'OOMKilled', options: OPTIONS, permalink: 'https://s/p3' },
    { type: 'fix_chosen', key: KEY, thread: T, ts: tsAt(120), time: at(300), actor: 'Gari Singh', title: 'Option B: Increase to 64Mi with headroom', text: "*What's wrong*" },
    { type: 'pr_opened', key: KEY, cluster: 'boutique-prod', time: at(330), actor: 'kube-agents-bot', title: 'PR #1: increase memory', link: 'https://github.com/o/r/pull/1' },
  ];
}

test('messages in ts order, one per ts and type; a report press is a choice row', () => {
  const t = buildThread(incident(), T);
  assert.deepEqual(
    t.items.map((i) => `${i.kind}:${i.ev.type}`),
    ['msg:alert', 'msg:triage', 'msg:triage_report', 'choice:fix_chosen', 'pr:pr_opened'],
  );
  assert.equal(t.items[1].ev.text, 'Found rev 3 at 20Mi');
  assert.equal(t.items[4].number, '1');
  assert.deepEqual(t.items[2].options, OPTIONS);
  assert.equal(t.key, KEY);
  assert.equal(t.permalink, 'https://s/p1');
  assert.equal(t.title, 'recommendationservice crashloop');
});

test('the chosen option, by letter or by a bare apply', () => {
  const t = buildThread(incident(), T);
  assert.deepEqual({ ...t.chosen, ev: undefined }, { letter: 'B', label: 'Increase to 64Mi with headroom', actor: 'Gari Singh', ev: undefined });
  assert.equal(chosenLetter({ title: 'Apply' }, OPTIONS), 'B');
  assert.equal(chosenLetter({ title: 'Apply Option A' }, OPTIONS), 'A');
  assert.equal(chosenLetter({ title: 'checking' }, OPTIONS), '');
  assert.equal(chosenLetter({ title: 'Revert to working 32Mi' }, OPTIONS), 'A');
});

test('a person\'s apply reply is its own message', () => {
  const evs = [...incident().slice(0, 4), { type: 'fix_chosen', key: KEY, thread: T, ts: tsAt(200), time: at(200), actor: 'Gari Singh', title: 'Apply Option A', text: 'apply Option A' }];
  const t = buildThread(evs, T);
  assert.equal(t.items.at(-1).kind, 'msg');
  assert.equal(t.chosen.letter, 'A');
});

test('PRs: the workload\'s, after the alert and before its next alert', () => {
  const evs = [
    { type: 'pr_merged', key: KEY, time: at(-60), link: 'https://github.com/o/r/pull/0' },
    ...incident(),
    { type: 'pr_opened', key: 'bank-prod/frontend', time: at(400), link: 'https://github.com/o/r/pull/2' },
    { type: 'pr_merged', key: KEY, time: at(500), link: 'https://github.com/o/r/pull/1', actor: 'Gari Singh' },
    { type: 'alert', key: KEY, thread: '1793650000.000100', ts: '1793650000.000100', time: at(9000) },
    { type: 'pr_opened', key: KEY, time: at(9100), link: 'https://github.com/o/r/pull/3' },
  ];
  const t = buildThread(evs, T);
  assert.deepEqual(t.items.filter((i) => i.kind === 'pr').map((i) => `${i.ev.type}#${i.number}`), ['pr_opened#1', 'pr_merged#1']);
  assert.equal(t.statusId, 'merged');
  assert.equal(buildThread(evs, T, { healthy: () => true }).status, 'Recovered');
});

test('status: the furthest stage reached', () => {
  const s = (types, o) => threadStatus(types.map((type) => (typeof type === 'string' ? { type } : type)), o);
  assert.equal(s(['alert', 'triage']), 'investigating');
  assert.equal(s(['alert', 'triage_report', 'triage']), 'report');
  assert.equal(s(['alert', 'triage_report', 'fix_chosen']), 'chosen');
  assert.equal(s(['alert', 'fix_chosen', 'pr_opened']), 'pr');
  assert.equal(s(['pr_opened', 'pr_closed']), 'closed');
  assert.equal(s(['pr_opened', 'pr_closed', 'pr_opened']), 'pr');
  assert.equal(s(['pr_opened', 'pr_merged']), 'merged');
  assert.equal(s(['pr_merged', 'pr_closed']), 'merged');
  assert.equal(s(['pr_merged', { type: 'chat', text: 'recommendationservice is healthy again; closing' }]), 'recovered');
  assert.equal(s([{ type: 'triage', text: ':zzz: *Quiet since 18:25 UTC:* no new events' }]), 'recovered');
});

test('a thread with no alert in the buffer still has a title and a link', () => {
  const t = buildThread(incident().slice(1), T);
  assert.equal(t.alert, null);
  assert.equal(t.title, 'Found rev 3');
  assert.equal(t.key, KEY);
});

test('latestThread and isBot', () => {
  assert.equal(latestThread(incident(), KEY), T);
  assert.equal(latestThread(incident(), 'x/y'), '');
  assert.ok(isBot('kube-agents') && isBot('cluster-agent-boutique-prod'));
  assert.ok(!isBot('Gari Singh') && !isBot(''));
});
