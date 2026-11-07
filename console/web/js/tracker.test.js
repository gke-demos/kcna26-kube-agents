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
import {
  deriveSteps, newPress, pressAnswered, pressFailed, observe, actionKind, reasonKind, sameCommit, mmss,
  DONE, ACTIVE, PENDING, FAILED, WATCH_HINT,
} from './tracker.js';

const T0 = Date.parse('2026-11-03T18:00:00Z');
const at = (s) => new Date(T0 + s * 1000).toISOString();
const ms = (s) => T0 + s * 1000;
const KEY = 'boutique-prod/recommendationservice';
const SHA = '9f2c1ab4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0';
const OLD = '1111111111111111111111111111111111111111';
const THREAD = '1793641808.988429';
const OPTIONS = [
  { letter: 'A', label: 'Scale to 2 replicas' },
  { letter: 'B', label: 'Increase to 440Mi with headroom', recommended: true },
];

function model({ state = 'RUNNING', reason = '', since = -3600, sync = { 'boutique-prod': OLD, 'bank-prod': OLD }, others = [] } = {}) {
  const agents = new Map([[KEY, { atespace: 'boutique-prod', name: 'recommendationservice', state, reason, stateSince: at(since), replicas: 1, ready: state === 'RUNNING' ? 1 : 0 }]]);
  for (const a of others) agents.set(`${a.atespace}/${a.name}`, a);
  const atespaces = new Map([['kube-agents-hub', { name: 'kube-agents-hub' }], ...Object.entries(sync).map(([n, c]) => [n, { name: n, syncCommit: c }])]);
  return { agents, atespaces };
}

function pressed(action = 'trigger-oom', target = 'recommendationservice') {
  const p = newPress({ action, title: 'OOMKill a service', target, time: ms(0) });
  return pressAnswered(p, { title: 'Squeezed recommendationservice memory', link: `https://github.com/o/r/commit/${SHA}`, key: KEY, cluster: 'boutique-prod', commit: SHA }, ms(2));
}

const action = (extra = {}) => ({ type: 'action', reason: 'trigger-oom', key: KEY, cluster: 'boutique-prod', commit: SHA, link: `https://github.com/o/r/commit/${SHA}`, title: 'Squeezed', time: at(2), ...extra });

function incident(upTo = Infinity) {
  const all = [
    action(),
    { type: 'alert', key: KEY, thread: THREAD, ts: THREAD, time: at(240), title: 'recommendationservice: OOMKilled, 4 restarts', permalink: 'https://slack/p1' },
    { type: 'triage', key: KEY, thread: THREAD, time: at(260), title: 'Looking at recommendationservice' },
    { type: 'triage', key: KEY, thread: THREAD, time: at(300), title: 'Memory peaked at 220Mi' },
    { type: 'triage_report', key: KEY, thread: THREAD, time: at(420), title: 'OOM-killed on every start', options: OPTIONS, permalink: 'https://slack/p3' },
    { type: 'fix_chosen', key: KEY, thread: THREAD, time: at(480), title: 'Option B: Increase to 440Mi with headroom', actor: 'sre-oncall' },
    { type: 'pr_opened', key: KEY, time: at(520), title: 'PR #12: raise memory', link: 'https://github.com/o/r/pull/12' },
    { type: 'pr_merged', key: KEY, time: at(600), title: 'PR #12 merged', link: 'https://github.com/o/r/pull/12', actor: 'gari' },
  ];
  return all.filter((e) => Date.parse(e.time) <= ms(upTo));
}

const states = (r) => r.steps.map((s) => s.state);
const byId = (r, id) => r.steps.find((s) => s.id === id);

test('kinds and helpers', () => {
  assert.equal(actionKind('trigger-oom'), 'oom');
  assert.equal(actionKind('trigger-badimage'), 'image');
  assert.equal(actionKind('trigger-unschedulable'), 'unschedulable');
  assert.equal(actionKind('reset'), 'reset');
  assert.equal(reasonKind('OOMKilled'), 'oom');
  assert.equal(reasonKind('CrashLoopBackOff'), 'oom');
  assert.equal(reasonKind('ImagePullBackOff'), 'image');
  assert.equal(reasonKind('Unschedulable'), 'unschedulable');
  assert.ok(sameCommit(SHA, SHA.slice(0, 7)));
  assert.ok(!sameCommit(SHA, OLD));
  assert.ok(!sameCommit('', SHA));
  assert.equal(mmss(65e3), '1:05');
});

test('optimistic: pushing until the POST answers', () => {
  const p = newPress({ action: 'trigger-oom', title: 'OOMKill', target: 'recommendationservice', time: ms(0) });
  const r = deriveSteps(p, model(), [], ms(1));
  assert.equal(r.steps[0].state, ACTIVE);
  assert.equal(r.steps[0].detail, 'Pushing change…');
  assert.equal(r.steps[0].since, ms(0));
  assert.deepEqual(states(r).slice(1), Array(10).fill(PENDING));
  assert.equal(r.status, 'running');
  assert.equal(r.workload, 'recommendationservice');
});

test('OOM: each step in turn, from the response to healthy again', () => {
  const p = pressed();
  let r = deriveSteps(p, model(), incident(2), ms(10));
  assert.equal(r.steps.length, 11);
  assert.deepEqual(states(r).slice(0, 3), [DONE, ACTIVE, PENDING]);
  assert.equal(r.steps[0].linkText, SHA.slice(0, 7));
  assert.equal(byId(r, 'synced').label, 'Config Sync applying on boutique-prod');
  assert.equal(byId(r, 'synced').since, ms(2));

  // Config Sync applied the commit: in the model, no live event needed.
  r = deriveSteps(p, model({ sync: { 'boutique-prod': SHA, 'bank-prod': OLD } }), incident(2), ms(60));
  assert.deepEqual(states(r).slice(0, 3), [DONE, DONE, ACTIVE]);
  assert.match(byId(r, 'failing').hint, /OOMKilled under load/);

  // Failing: the watcher's wait is the OOM debounce, timed from the failure.
  const failing = model({ state: 'CRASHED', reason: 'OOMKilled', since: 70, sync: { 'boutique-prod': SHA } });
  r = deriveSteps(p, failing, incident(100), ms(100));
  assert.deepEqual(states(r).slice(0, 4), [DONE, DONE, DONE, ACTIVE]);
  assert.equal(byId(r, 'failing').label, 'recommendationservice failing: OOMKilled');
  assert.equal(byId(r, 'failing').at, ms(70));
  assert.equal(byId(r, 'watching').hint, WATCH_HINT.oom);
  assert.equal(byId(r, 'watching').since, ms(70));
  assert.equal(byId(r, 'watching').slow, false);

  // Alert: watching and Slack done, the Cluster Agent's latest note shows.
  r = deriveSteps(p, failing, incident(300), ms(310));
  assert.deepEqual(states(r).slice(3, 7), [DONE, DONE, ACTIVE, PENDING]);
  assert.equal(byId(r, 'alert').link, 'https://slack/p1');
  assert.equal(byId(r, 'investigating').detail, 'Memory peaked at 220Mi');
  assert.equal(r.thread, THREAD);

  // Report: the recommended option; then a person chooses in Slack.
  r = deriveSteps(p, failing, incident(420), ms(430));
  assert.equal(byId(r, 'report').state, DONE);
  assert.equal(byId(r, 'report').detail, 'Recommended: Option B — Increase to 440Mi with headroom');
  assert.equal(byId(r, 'fix').state, ACTIVE);
  assert.match(byId(r, 'fix').hint, /choose one in Slack/);

  r = deriveSteps(p, failing, incident(600), ms(610));
  assert.equal(byId(r, 'fix').label, 'Fix chosen by sre-oncall');
  assert.equal(byId(r, 'fix').detail, 'Option B: Increase to 440Mi with headroom');
  assert.equal(byId(r, 'pr').label, 'PR #12 opened');
  assert.equal(byId(r, 'pr').link, 'https://github.com/o/r/pull/12');
  assert.equal(byId(r, 'merged').state, DONE);
  assert.equal(byId(r, 'healthy').state, ACTIVE);
  assert.equal(r.status, 'running');

  // Healthy after the merge: done.
  const healed = model({ state: 'RUNNING', since: 650, sync: { 'boutique-prod': 'feedface' } });
  r = deriveSteps({ ...p, seen: { ...p.seen, failingAt: ms(70), failReason: 'OOMKilled', synced: { 'boutique-prod': ms(40) } } }, healed, incident(), ms(660));
  assert.ok(states(r).every((s) => s === DONE), states(r).join());
  assert.equal(r.status, 'done');
  assert.equal(r.doneAt, ms(650));
  assert.equal(byId(r, 'synced').at, ms(40));
});

test('OOM: a workload running before the merge is not healthy yet', () => {
  const p = pressed();
  // Healthy since before the press: the press has not made it fail yet.
  const r = deriveSteps(p, model({ state: 'RUNNING', since: -100, sync: { 'boutique-prod': SHA } }), incident(30), ms(30));
  assert.equal(byId(r, 'failing').state, ACTIVE);
  assert.equal(byId(r, 'healthy').state, PENDING);
});

test('bad image: alerts immediately', () => {
  const p = { ...pressed('trigger-badimage', 'recommendationservice'), action: 'trigger-badimage' };
  const r = deriveSteps(p, model({ state: 'CRASHED', reason: 'ImagePullBackOff', since: 40, sync: { 'boutique-prod': SHA } }), [action({ reason: 'trigger-badimage' })], ms(45));
  assert.equal(byId(r, 'failing').label, 'recommendationservice failing: ImagePullBackOff');
  assert.equal(byId(r, 'watching').state, ACTIVE);
  assert.equal(byId(r, 'watching').hint, WATCH_HINT.image);
  // Two minutes without an alert is far past "immediately".
  const late = deriveSteps(p, model({ state: 'CRASHED', reason: 'ImagePullBackOff', since: 40, sync: { 'boutique-prod': SHA } }), [], ms(200));
  assert.equal(byId(late, 'watching').slow, true);
});

test('unschedulable: pending counts as failing, with its own wait', () => {
  const p = { ...pressed('trigger-unschedulable'), action: 'trigger-unschedulable' };
  const r = deriveSteps(p, model({ state: 'UNSPECIFIED', reason: 'Unschedulable', since: 50, sync: { 'boutique-prod': SHA } }), [], ms(60));
  assert.equal(byId(r, 'failing').state, DONE);
  assert.equal(byId(r, 'failing').label, 'recommendationservice failing: Unschedulable');
  assert.equal(byId(r, 'watching').hint, WATCH_HINT.unschedulable);
  // Before it fails, the step explains why it will.
  const before = deriveSteps(p, model({ sync: { 'boutique-prod': SHA } }), [], ms(20));
  assert.match(byId(before, 'failing').hint, /32 CPUs/);
});

test('reset: pushed, both clusters synced, every workload healthy', () => {
  const p = pressAnswered(newPress({ action: 'reset', title: 'Reset the demo', time: ms(0) }), { title: 'Reset: restored', link: `https://github.com/o/r/commit/${SHA}`, commit: SHA }, ms(1));
  const crashed = model({ state: 'CRASHED', reason: 'OOMKilled', since: -60 });
  let r = deriveSteps(p, crashed, [], ms(5));
  assert.equal(r.kind, 'reset');
  assert.equal(r.steps.length, 3);
  assert.equal(r.steps[1].label, 'Config Sync applied on bank-prod and boutique-prod');
  assert.equal(r.steps[1].state, ACTIVE);
  assert.equal(r.steps[1].detail, 'bank-prod … · boutique-prod …');

  // One cluster synced (live), the other not yet.
  r = deriveSteps({ ...p, seen: { ...p.seen, synced: { 'boutique-prod': ms(30) } } }, crashed, [], ms(35));
  assert.equal(r.steps[1].detail, 'bank-prod … · boutique-prod ✓');
  assert.equal(r.steps[1].state, ACTIVE);

  // Both on the commit, still one failing workload.
  const synced = { 'boutique-prod': SHA, 'bank-prod': SHA };
  r = deriveSteps(p, model({ state: 'CRASHED', since: -60, sync: synced }), [], ms(60));
  assert.equal(r.steps[1].state, DONE);
  assert.equal(r.steps[2].state, ACTIVE);
  assert.equal(r.steps[2].detail, '0/1 healthy');

  r = deriveSteps(p, model({ state: 'RUNNING', since: 80, sync: synced, others: [{ atespace: 'bank-prod', name: 'frontend', state: 'RUNNING', stateSince: at(-999) }] }), [], ms(90));
  assert.deepEqual(states(r), [DONE, DONE, DONE]);
  assert.equal(r.status, 'done');
  assert.equal(r.doneAt, ms(80));
});

test('a failed press shows the error and stops', () => {
  const p = pressFailed(newPress({ action: 'trigger-oom', target: 'recommendationservice', time: ms(0) }), 'an incident is already running on cartservice', ms(1));
  const r = deriveSteps(p, model(), [], ms(5));
  assert.equal(r.status, 'failed');
  assert.equal(r.steps[0].state, FAILED);
  assert.equal(r.error, 'an incident is already running on cartservice');
  assert.ok(r.steps.slice(1).every((s) => s.state === PENDING));
  // The stream's failed action event says the same before the POST answers.
  const sending = newPress({ action: 'trigger-oom', target: 'recommendationservice', time: ms(0) });
  const viaStream = deriveSteps(sending, model(), [action({ commit: '', message: 'failed', title: 'trigger-oom failed: GitHub said 409' })], ms(5));
  assert.equal(viaStream.status, 'failed');
  assert.equal(viaStream.error, 'trigger-oom failed: GitHub said 409');
});

test('a sync before the commit was pushed, or for a refused press, does not count', () => {
  // Another press's commit lands while this one's POST is still out.
  const sending = newPress({ action: 'trigger-badimage', target: 'recommendationservice', time: ms(0) });
  const sync = { type: 'cluster_synced', key: 'boutique-prod', cluster: 'boutique-prod', commit: OLD, time: at(1) };
  assert.deepEqual(observe(sending, [sync], ms(1)).seen.synced, {});
  // The press is refused: nothing after the push shows as done, whatever the cluster does.
  const refused = pressFailed(sending, 'an incident is already running', ms(2));
  assert.deepEqual(observe(refused, [{ ...sync, time: at(5) }], ms(5)).seen.synced, {});
  const r = deriveSteps({ ...refused, seen: { synced: { 'boutique-prod': ms(5) }, failingAt: ms(6), failReason: 'OOMKilled' } }, model({ state: 'CRASHED', since: 6 }), [], ms(8));
  assert.deepEqual(states(r), [FAILED, ...Array(10).fill(PENDING)]);
});

test('PR step: the agent\'s notes after the report show while it writes the fix', () => {
  const p = pressed();
  const failing = model({ state: 'CRASHED', reason: 'OOMKilled', since: 70, sync: { 'boutique-prod': SHA } });
  const working = [...incident(480), { type: 'triage', key: KEY, thread: THREAD, time: at(500), title: 'Editing deployment.yaml' }];
  let r = deriveSteps(p, failing, incident(480), ms(490));
  assert.equal(byId(r, 'pr').detail || '', '');
  r = deriveSteps(p, failing, working, ms(510));
  assert.equal(byId(r, 'pr').detail, 'Editing deployment.yaml');
});

test('a fix PR without a readable report: investigating and report are done', () => {
  const p = pressed();
  const failing = model({ state: 'CRASHED', reason: 'OOMKilled', since: 70, sync: { 'boutique-prod': SHA } });
  const sigs = incident(520).filter((e) => e.type !== 'triage_report' && e.type !== 'fix_chosen');
  const r = deriveSteps(p, failing, sigs, ms(530));
  assert.deepEqual([byId(r, 'investigating').state, byId(r, 'report').state, byId(r, 'fix').state, byId(r, 'pr').state], [DONE, DONE, DONE, DONE]);
  assert.equal(byId(r, 'report').detail, 'In the Slack thread');
  assert.equal(byId(r, 'report').at, ms(520));
});

test('booth auto-merge is named on the merged step', () => {
  const p = pressed();
  const failing = model({ state: 'CRASHED', reason: 'OOMKilled', since: 70, sync: { 'boutique-prod': SHA } });
  const sigs = [...incident(520),
    { type: 'pr_merged', key: KEY, time: at(580), title: 'PR #12 merged', link: 'https://github.com/o/r/pull/12', actor: 'kcna26-bot' },
    { type: 'action', actor: 'auto-merge', time: at(580), title: 'Auto-merged PR #12 after 1 min (booth mode): raise memory', link: 'https://github.com/o/r/pull/12' }];
  let r = deriveSteps(p, failing, sigs, ms(590));
  assert.match(byId(r, 'merged').detail, /booth mode/);
  r = deriveSteps(p, failing, incident(), ms(610));
  assert.equal(byId(r, 'merged').detail, 'Merged by gari; Config Sync applies it next');
});

test('a closed PR fails the merge step', () => {
  const p = pressed();
  const sigs = [...incident(520), { type: 'pr_closed', key: KEY, time: at(560), link: 'https://github.com/o/r/pull/12', title: 'PR #12 closed' }];
  const r = deriveSteps(p, model({ state: 'CRASHED', reason: 'OOMKilled', since: 70 }), sigs, ms(570));
  assert.equal(byId(r, 'merged').state, FAILED);
  assert.equal(r.status, 'failed');
});

test('observe keeps passing states: the failure and each sync', () => {
  let p = pressed();
  p = observe(p, [
    { type: 'cluster_synced', key: 'boutique-prod', cluster: 'boutique-prod', commit: SHA, time: at(30) },
    { type: 'cluster_synced', key: 'bank-prod', cluster: 'bank-prod', commit: OLD, time: at(-60) },
    { type: 'agent_state', key: KEY, agent: { state: 'RESUMING', reason: 'Progressing' }, time: at(35) },
    { type: 'agent_crashed', key: KEY, agent: { state: 'CRASHED', reason: 'OOMKilled' }, time: at(70) },
    { type: 'agent_crashed', key: KEY, agent: { state: 'CRASHED', reason: 'CrashLoopBackOff' }, time: at(90) },
  ], ms(90));
  assert.deepEqual(p.seen.synced, { 'boutique-prod': ms(30) });
  assert.equal(p.seen.failingAt, ms(70));
  assert.equal(p.seen.failReason, 'OOMKilled');
  // The workload is back to RUNNING (crash loop between restarts): the step stays done.
  const r = deriveSteps(p, model({ state: 'RUNNING', since: 95, sync: { 'boutique-prod': 'other' } }), incident(100), ms(100));
  assert.deepEqual(states(r).slice(0, 4), [DONE, DONE, DONE, ACTIVE]);
  assert.equal(byId(r, 'synced').at, ms(30));
  // Nothing changes: the same object back.
  assert.equal(observe(p, [], ms(100)), p);
});

test('observe picks up the action event: commit, and a failure', () => {
  const sending = newPress({ action: 'trigger-oom', target: 'recommendationservice', time: ms(0) });
  const p = observe(sending, [action()], ms(2));
  assert.equal(p.commit, SHA);
  assert.equal(p.key, KEY);
  assert.equal(p.serverTime, at(2));
  const f = observe(sending, [action({ message: 'failed', title: 'trigger-oom failed: boom' })], ms(2));
  assert.equal(f.status, 'failed');
  assert.equal(f.error, 'trigger-oom failed: boom');
  // Another press's action (other commit) is not this one's.
  assert.equal(observe(pressed(), [action({ commit: OLD, title: 'x', time: at(1) })], ms(2)).serverTime, '');
});

test('resync and reload: the same steps from the model and the feed buffer alone', () => {
  // A reload mid-incident: the stored press (no live events since), a fresh
  // snapshot (workload failing, cluster on the commit) and its recent signals.
  const stored = JSON.parse(JSON.stringify(pressed()));
  const snapModel = model({ state: 'CRASHED', reason: 'OOMKilled', since: 70, sync: { 'boutique-prod': SHA } });
  const r = deriveSteps(stored, snapModel, incident(430), ms(440));
  assert.deepEqual(states(r), [DONE, DONE, DONE, DONE, DONE, DONE, DONE, ACTIVE, PENDING, PENDING, PENDING]);
  assert.equal(byId(r, 'failing').at, ms(70));

  // A reload that lost the POST's answer: the press is still "sending", the
  // action event in the buffer supplies the commit, and the sync moved on
  // since (another commit), but the alert implies the earlier steps.
  const lost = newPress({ action: 'trigger-oom', target: 'recommendationservice', time: ms(0) });
  const r2 = deriveSteps(lost, model({ state: 'RUNNING', since: 250, sync: { 'boutique-prod': OLD } }), incident(300), ms(310));
  assert.equal(r2.commit, SHA);
  assert.equal(r2.key, KEY);
  assert.deepEqual(states(r2).slice(0, 6), [DONE, DONE, DONE, DONE, DONE, ACTIVE]);
  assert.equal(byId(r2, 'synced').at, 0);

  // Signals from before the press (an earlier incident) do not count.
  const old = [{ type: 'alert', key: KEY, thread: 'old', time: at(-600), title: 'old alert' }, { type: 'pr_merged', key: KEY, time: at(-300), link: 'https://github.com/o/r/pull/3' }];
  const r3 = deriveSteps(pressed(), model({ sync: { 'boutique-prod': SHA } }), old, ms(20));
  assert.equal(byId(r3, 'alert').state, PENDING);
  assert.equal(byId(r3, 'merged').state, PENDING);
});

test('server clock skew: event times are read on the browser clock', () => {
  // The server runs 30 s ahead; its action event is stamped at +32 s.
  const skewed = (s) => new Date(T0 + (s + 30) * 1000).toISOString();
  const p = observe(pressed(), [action({ time: skewed(2) })], ms(2));
  const sigs = [action({ time: skewed(2) }), { type: 'alert', key: KEY, thread: THREAD, time: skewed(100), title: 'alert', permalink: 'https://slack/p1' }];
  const r = deriveSteps(p, model({ state: 'CRASHED', reason: 'OOMKilled', since: 0, sync: { 'boutique-prod': SHA } }), sigs, ms(110));
  assert.equal(byId(r, 'alert').at, ms(100));
});
