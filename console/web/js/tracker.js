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

// The incident tracker's logic (fleet-scope): from one console press to the
// workload being healthy again, as a list of steps derived from the press,
// the model (workload state, each cluster's Config Sync commit) and the
// signal events (alert, triage, report, fix, PRs). Pure: no DOM, no timers,
// no storage, so a tracker rebuilds the same after a resync or a reload.

import { chosenLetter } from './thread.js';

/** Step states. */
export const PENDING = 'pending';
export const ACTIVE = 'active';
export const DONE = 'done';
export const FAILED = 'failed';

/** Press states: the POST is in flight, answered, or refused. */
export const SENDING = 'sending';
export const SENT = 'sent';
export const PRESS_FAILED = 'failed';

/** How far before the press an event may be stamped and still count (clock skew, ms). */
export const SKEW_TOLERANCE_MS = 5000;
/** How far back an action event may be and still be this press's, before its commit is known (ms). */
export const ACTION_MATCH_MS = 120e3;
/** A step running this many times its usual time is flagged as slow. */
export const SLOW_FACTOR = 2;
/** Short SHA length for links. */
const SHORT_SHA = 7;
/** Seconds per minute (for m:ss). */
const MINUTE = 60;
/** Clusters a reset applies to when the model names none with Config Sync. */
export const RESET_CLUSTERS = ['boutique-prod', 'bank-prod'];

/** Workload states that mean "failing" (CRASHED) or "pending" (UNSPECIFIED: unschedulable). */
const FAILING_STATES = new Set(['CRASHED', 'UNSPECIFIED']);
const HEALTHY_STATE = 'RUNNING';

/** Usual durations (ms), from the watcher's and agents' timing; the UI says they are estimates. */
const SYNC_MS = 90e3;
const FAIL_MS = { oom: 120e3, image: 60e3, unschedulable: 60e3, other: 120e3 };
const WATCH_MS = { oom: 300e3, image: 20e3, unschedulable: 180e3, other: 300e3 };
const TRIAGE_MS = 360e3;
const PR_MS = 120e3;
const HEAL_MS = 180e3;
const RESET_HEAL_MS = 180e3;

/** What the watcher waits for, per kind of failure. */
export const WATCH_HINT = {
  oom: 'waiting for 3 restarts + 2 min settle (≈3–5 min)',
  image: 'a bad image tag alerts immediately (≈10–20 s)',
  unschedulable: 'waiting for 5 scheduling attempts over 2 min (≈2–3 min)',
  other: 'waiting for the failure to settle before alerting (≈2–5 min)',
};

/** How the change makes the workload fail, per kind. */
const FAIL_HINT = {
  oom: 'New pods start with the squeezed memory limit and get OOMKilled under load',
  image: 'New pods try to pull an image tag that does not exist',
  unschedulable: 'New pods ask for 32 CPUs; no node can fit them',
  other: 'The new pods roll out with the change',
};

/** Kind of an action by its name: trigger-oom, trigger-badimage, trigger-unschedulable, reset. */
export function actionKind(name) {
  const n = String(name || '').toLowerCase();
  if (n === 'reset' || n.includes('reset')) return 'reset';
  if (n.includes('oom')) return 'oom';
  if (n.includes('image')) return 'image';
  if (n.includes('unsched')) return 'unschedulable';
  return 'other';
}

/** Kind of a failure by the workload's reason (OOMKilled, CrashLoopBackOff, ImagePullBackOff, Unschedulable). */
export function reasonKind(reason) {
  const r = String(reason || '').toLowerCase();
  if (!r) return '';
  if (r.includes('oom') || r.includes('crashloop')) return 'oom';
  if (r.includes('image') || r.includes('pull')) return 'image';
  if (r.includes('unsched') || r.includes('insufficient')) return 'unschedulable';
  return '';
}

/** Whether two fleet-repo SHAs name the same commit (either may be short). */
export function sameCommit(a, b) {
  if (!a || !b) return false;
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.startsWith(y) || y.startsWith(x);
}

/** "1:05" for 65 s. */
export function mmss(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / MINUTE)}:${String(s % MINUTE).padStart(2, '0')}`;
}

/** A short SHA. */
export function shortSha(sha) {
  return String(sha || '').slice(0, SHORT_SHA);
}

/**
 * A new press, before the POST answers.
 * @param {{action: string, title?: string, target?: string, key?: string, cluster?: string, time: number, id?: string}} p
 */
export function newPress(p) {
  return {
    id: p.id || `${p.action}-${p.time}`,
    action: p.action,
    title: p.title || p.action,
    target: p.target || '',
    key: p.key || '',
    cluster: p.cluster || (p.key ? p.key.split('/')[0] : ''),
    commit: '',
    link: '',
    result: '',
    time: p.time,
    status: SENDING,
    error: '',
    respondedAt: 0,
    serverTime: '',
    seen: { synced: {}, failingAt: 0, failReason: '' },
  };
}

/** The press after the POST answered with {title, link, key, cluster, commit}. */
export function pressAnswered(press, res, now) {
  const key = res?.key || press.key;
  return {
    ...press,
    status: SENT,
    result: res?.title || '',
    link: res?.link || press.link,
    commit: res?.commit || press.commit,
    key,
    cluster: res?.cluster || press.cluster || (key ? key.split('/')[0] : ''),
    respondedAt: now,
  };
}

/** The press after the POST failed. */
export function pressFailed(press, error, now) {
  return { ...press, status: PRESS_FAILED, error: String(error || 'failed'), respondedAt: now };
}

/** Whether an action event is this press's (by commit when both have one, else by action and workload). */
export function isPressAction(press, ev) {
  if (ev?.type !== 'action' || ev.reason !== press.action) return false;
  if (press.commit && ev.commit) return sameCommit(press.commit, ev.commit);
  if (!ev.key) return true;
  // Before the POST answers, the press's cluster is a guess: match the workload's name.
  if (press.status === SENDING || !press.key) return !press.target || ev.key.endsWith(`/${press.target}`);
  return press.key === ev.key;
}

/** Server time minus browser time for this press, when known (ms). */
function skewOf(press, action) {
  const t = Date.parse(press.serverTime || action?.time || '');
  return Number.isFinite(t) && press.respondedAt ? t - press.respondedAt : 0;
}

/** This press's action event in the signals, or null. */
export function findAction(press, signals) {
  let best = null;
  for (const e of signals || []) {
    if (!isPressAction(press, e)) continue;
    const t = Date.parse(e.time || '');
    if (Number.isFinite(t) && t < press.time - ACTION_MATCH_MS) continue;
    if (press.commit && e.commit && sameCommit(press.commit, e.commit)) return e;
    if (!best) best = e;
  }
  return best;
}

/**
 * Folds live events into what a press has seen, so a passing state (the
 * workload failing, a cluster syncing) survives the model moving on.
 * Returns the press (a copy when something changed).
 */
export function observe(press, events, now = Date.now()) {
  if (!events?.length) return press;
  let p = press;
  const seen = () => {
    if (p === press) p = { ...press, seen: { ...press.seen, synced: { ...press.seen?.synced } } };
    return p.seen;
  };
  const skew = skewOf(press, null);
  const local = (iso) => {
    const t = Date.parse(iso || '');
    return Number.isFinite(t) ? t - skew : now;
  };
  const from = press.time - SKEW_TOLERANCE_MS;
  for (const ev of events) {
    if (ev.type === 'action' && isPressAction(p, ev)) {
      if (ev.message === 'failed' && p.status !== PRESS_FAILED) p = { ...pressFailed(p, ev.title, p.respondedAt || now), seen: p.seen };
      else if (!p.serverTime) {
        p = { ...p, serverTime: ev.time || '', respondedAt: p.respondedAt || now };
        if (!p.commit && ev.commit) p.commit = ev.commit;
        if (!p.link && ev.link) p.link = ev.link;
        if (!p.key && ev.key) p.key = ev.key;
        if (!p.cluster && ev.cluster) p.cluster = ev.cluster;
      }
      continue;
    }
    const t = local(ev.time);
    if (t < from) continue;
    if (ev.type === 'cluster_synced') {
      // Only a sync after the commit was pushed can carry it (Config Sync
      // applies the branch head, so a later commit carries ours too).
      const c = ev.cluster || ev.key;
      const pushed = p.respondedAt && p.status !== PRESS_FAILED && t >= p.respondedAt - SKEW_TOLERANCE_MS;
      if (c && pushed && !p.seen?.synced?.[c]) seen().synced[c] = t;
    } else if (p.key && ev.key === p.key && ev.agent && FAILING_STATES.has(ev.agent.state) && !p.seen?.failingAt) {
      const s = seen();
      s.failingAt = t;
      s.failReason = ev.agent.reason || ev.agent.crash?.message || ev.message || '';
    }
  }
  return p;
}

/**
 * The steps of a press.
 * @param {object} press see newPress
 * @param {{agents: Map<string, any>, atespaces: Map<string, any>}} model
 * @param {any[]} signals signal events, oldest first
 * @param {number} now browser time (ms)
 * @returns {{kind: string, status: 'running'|'done'|'failed', steps: any[], active: number, doneAt: number,
 *   thread: string, key: string, cluster: string, workload: string, error: string, commit: string, link: string}}
 */
export function deriveSteps(press, model, signals, now) {
  const sigs = signals || [];
  const action = findAction(press, sigs);
  const skew = skewOf(press, action);
  const local = (iso) => {
    const t = Date.parse(iso || '');
    return Number.isFinite(t) ? t - skew : NaN;
  };
  const from = press.time - SKEW_TOLERANCE_MS;
  const commit = press.commit || action?.commit || '';
  const link = press.link || action?.link || '';
  const key = press.key || action?.key || '';
  const cluster = press.cluster || action?.cluster || (key ? key.split('/')[0] : '');
  const workload = key ? key.split('/').slice(1).join('/') : press.target || '';
  const kind = actionKind(press.action);
  const failedAction = action?.message === 'failed' ? action : null;
  const error = press.status === PRESS_FAILED ? press.error : failedAction ? failedAction.title || 'the action failed' : '';
  const sent = press.status === SENT || (press.status !== PRESS_FAILED && !!action && !failedAction);
  const after = (e) => {
    const t = local(e.time);
    return !Number.isFinite(t) || t >= from;
  };
  const ctx = { press, model, sigs, now, local, after, commit, link, key, cluster, workload, kind, error, sent };
  const steps = kind === 'reset' ? resetSteps(ctx) : incidentSteps(ctx);
  // Nothing was pushed: nothing after the push happened because of it.
  if (error) for (const s of steps.slice(1)) Object.assign(s, { state: PENDING, at: 0, detail: '', hint: '', link: '', linkText: '' });
  finish(steps, press, now);
  const failed = steps.some((s) => s.state === FAILED);
  const last = steps[steps.length - 1];
  const active = steps.findIndex((s) => s.state === ACTIVE);
  return {
    kind,
    status: failed ? 'failed' : last.state === DONE ? 'done' : 'running',
    steps,
    active,
    doneAt: last.state === DONE ? last.at || now : 0,
    thread: ctx.thread || '',
    key,
    cluster,
    workload,
    error,
    commit,
    link,
  };
}

/** A step. */
function step(id, label, extra = {}) {
  return { id, label, state: PENDING, detail: '', hint: '', at: 0, since: 0, link: '', linkText: '', usual: 0, slow: false, ...extra };
}

/** The workload's step 1: the change pushed to the fleet repo. */
function pushStep(ctx, label) {
  const { press, commit, link, error, sent } = ctx;
  const s = step('pushed', label, { link, linkText: commit ? shortSha(commit) : link ? 'commit' : '' });
  if (error) {
    s.state = FAILED;
    s.detail = error;
  } else if (sent) {
    s.state = DONE;
    s.at = press.respondedAt || press.time;
    s.detail = press.result || 'Committed to the fleet repo';
  } else {
    s.state = ACTIVE;
    s.detail = 'Pushing change…';
  }
  return s;
}

/** Whether a cluster has applied the press's commit (or synced anything since the press). */
function syncedAt(ctx, cluster) {
  const { model, commit, press } = ctx;
  const seenAt = press.seen?.synced?.[cluster];
  if (seenAt) return seenAt;
  const as = model?.atespaces?.get(cluster);
  if (as && commit && sameCommit(as.syncCommit, commit)) return -1;
  return 0;
}

function incidentSteps(ctx) {
  const { press, model, sigs, local, after, key, cluster, workload, kind } = ctx;
  const where = workload || 'the workload';
  const steps = [];

  steps.push(pushStep(ctx, 'Change pushed to the fleet repo'));

  const sync = step('synced', `Config Sync applying on ${cluster || 'the cluster'}`, { usual: SYNC_MS, hint: 'Config Sync pulls the fleet repo and applies it (≈30–90 s)' });
  const sAt = cluster ? syncedAt(ctx, cluster) : 0;
  if (sAt) {
    sync.state = DONE;
    sync.label = `Config Sync applied on ${cluster}`;
    sync.at = sAt > 0 ? sAt : 0;
    sync.detail = ctx.commit ? `Running commit ${shortSha(ctx.commit)}` : 'Applied';
    sync.hint = '';
  }
  steps.push(sync);

  // The workload failing after the press: seen live, or its state now.
  const agent = key ? model?.agents?.get(key) : null;
  let failAt = press.seen?.failingAt || 0;
  let failReason = press.seen?.failReason || '';
  if (!failAt && agent && FAILING_STATES.has(agent.state)) {
    const t = local(agent.stateSince);
    if (!Number.isFinite(t) || t >= press.time - SKEW_TOLERANCE_MS) failAt = Number.isFinite(t) ? t : -1;
    failReason = agent.reason || agent.crash?.message || '';
  }
  if (!failReason && agent && FAILING_STATES.has(agent.state)) failReason = agent.reason || '';
  const fkind = reasonKind(failReason) || (kind === 'reset' ? 'other' : kind);
  const fail = step('failing', `${where} failing`, { usual: FAIL_MS[fkind] || FAIL_MS.other, hint: FAIL_HINT[fkind] || FAIL_HINT.other });
  if (failAt) {
    fail.state = DONE;
    fail.at = failAt > 0 ? failAt : 0;
    fail.label = `${where} failing${failReason ? `: ${failReason}` : ''}`;
    fail.detail = agent?.crash?.message && agent.crash.message !== failReason ? agent.crash.message : '';
    fail.hint = '';
  }
  steps.push(fail);

  // Signals about the workload since the press.
  const mine = sigs.filter((e) => e.key && e.key === key && after(e));
  const alert = mine.find((e) => e.type === 'alert');
  const thread = alert?.thread || '';
  ctx.thread = thread;
  const alertAt = alert ? local(alert.time) || 0 : 0;
  const atOf = (e) => {
    const t = local(e?.time);
    return Number.isFinite(t) ? t : 0;
  };

  const watch = step('watching', 'kube-agents watching', { usual: WATCH_MS[fkind] || WATCH_MS.other, hint: WATCH_HINT[fkind] || WATCH_HINT.other });
  if (failReason) watch.detail = `The event watcher saw ${failReason}`;
  if (alert) {
    watch.state = DONE;
    watch.at = atOf(alert);
    watch.detail = 'The event watcher raised an alert';
    watch.hint = '';
  }
  steps.push(watch);

  const slack = step('alert', 'Alert in Slack', { usual: 0 });
  if (alert) {
    slack.state = DONE;
    slack.at = atOf(alert);
    slack.detail = alert.title || '';
    slack.link = alert.permalink || alert.link || '';
    slack.linkText = 'Slack';
  }
  steps.push(slack);

  // The incident's thread: its Slack messages, and the workload's signals since the alert.
  const threaded = alert ? sigs.filter((e) => (thread && e.thread === thread) || (e.key === key && after(e) && atOf(e) >= alertAt)) : [];
  const notes = threaded.filter((e) => e.type === 'triage');
  const report = [...threaded].reverse().find((e) => e.type === 'triage_report');
  const inv = step('investigating', 'Cluster Agent investigating', { usual: TRIAGE_MS, hint: "The Cluster Agent's triage typically takes 3–6 min" });
  const lastNote = notes.filter((e) => !report || atOf(e) <= atOf(report)).pop();
  if (lastNote) inv.detail = lastNote.title || '';
  if (report) {
    inv.state = DONE;
    inv.at = atOf(report);
    inv.hint = '';
    inv.detail = `${notes.length} note${notes.length === 1 ? '' : 's'} in the thread`;
  }
  steps.push(inv);

  const options = report?.options || [];
  const rec = options.find((o) => o.recommended);
  const rep = step('report', 'Report ready', { usual: 0 });
  if (report) {
    rep.state = DONE;
    rep.at = atOf(report);
    rep.detail = rec ? `Recommended: Option ${rec.letter} — ${rec.label}` : report.title || '';
    rep.link = report.permalink || report.link || '';
    rep.linkText = 'Slack';
    rep.thread = thread;
  }
  steps.push(rep);

  const reportAt = report ? atOf(report) : alertAt;
  const fix = report ? threaded.find((e) => e.type === 'fix_chosen' && (atOf(e) >= reportAt || (thread && e.thread === thread))) : null;
  const chosen = step('fix', 'Fix chosen', { usual: 0, hint: 'The agent opens its recommended fix itself, or choose one in Slack (a button on the report, or reply "apply")', thread });
  if (fix) {
    const letter = chosenLetter(fix, options);
    const opt = options.find((o) => o.letter === letter);
    chosen.state = DONE;
    chosen.at = atOf(fix);
    chosen.label = `Fix chosen${fix.actor ? ` by ${fix.actor}` : ''}`;
    chosen.detail = opt ? `Option ${opt.letter}: ${opt.label}` : fix.title || '';
    chosen.hint = '';
  }
  steps.push(chosen);

  const prs = mine.filter((e) => (e.type === 'pr_opened' || e.type === 'pr_merged' || e.type === 'pr_closed') && (!alert || atOf(e) >= alertAt));
  const opened = prs.find((e) => e.type === 'pr_opened');
  if (!fix && opened && chosen.state !== DONE) {
    // No one chose: the agent opened its recommended fix itself
    // (INCIDENT_TRIAGE_OPEN_PULL_REQUEST).
    chosen.state = DONE;
    chosen.at = atOf(opened);
    chosen.label = 'Recommended fix, opened by the agent';
    chosen.hint = '';
  }
  const prLink = opened?.link || '';
  const samePR = (e) => !prLink || !e.link || e.link === prLink;
  const merged = prs.find((e) => e.type === 'pr_merged' && samePR(e));
  const closed = !merged && prs.find((e) => e.type === 'pr_closed' && samePR(e));
  const prNum = (u) => /\/pull\/(\d+)/.exec(u || '')?.[1] || '';

  const pr = step('pr', 'PR opened', { usual: PR_MS, hint: 'The Platform Agent opens a GitOps pull request on the fleet repo' });
  if (opened || merged) {
    const e = opened || merged;
    pr.state = DONE;
    pr.at = atOf(e);
    pr.label = prNum(e.link) ? `PR #${prNum(e.link)} opened` : 'PR opened';
    pr.detail = opened?.title || '';
    pr.link = e.link || '';
    pr.linkText = 'GitHub';
    pr.hint = '';
  }
  steps.push(pr);

  const mg = step('merged', 'Merged', { usual: 0, hint: 'Review and merge the pull request on GitHub' });
  if (merged) {
    mg.state = DONE;
    mg.at = atOf(merged);
    mg.detail = merged.actor ? `Merged by ${merged.actor}; Config Sync applies it next` : 'Config Sync applies it next';
    mg.link = merged.link || prLink;
    mg.linkText = 'GitHub';
    mg.hint = '';
  } else if (closed) {
    mg.state = FAILED;
    mg.at = atOf(closed);
    mg.label = 'PR closed without merging';
    mg.detail = closed.title || '';
    mg.link = closed.link || prLink;
    mg.linkText = 'GitHub';
    mg.hint = '';
  }
  steps.push(mg);

  const heal = step('healthy', 'Healthy again', { usual: HEAL_MS, hint: 'Config Sync applies the fix (≈30–90 s), then the new pods roll out' });
  if (merged && agent?.state === HEALTHY_STATE) {
    const t = local(agent.stateSince);
    const mAt = atOf(merged);
    if (!Number.isFinite(t) || t >= mAt - SKEW_TOLERANCE_MS) {
      heal.state = DONE;
      heal.at = Number.isFinite(t) ? Math.max(t, mAt) : mAt;
      heal.label = `${where} healthy again`;
      heal.detail = agent.replicas ? `${agent.ready ?? agent.replicas}/${agent.replicas} ready` : '';
      heal.hint = '';
    }
  } else if (merged && agent) {
    heal.detail = `Now: ${agent.reason || agent.state.toLowerCase()}`;
  }
  steps.push(heal);
  return steps;
}

function resetSteps(ctx) {
  const { model } = ctx;
  const steps = [pushStep(ctx, 'Reset pushed to the fleet repo')];
  const synced = [...(model?.atespaces?.values() || [])].filter((a) => a.syncCommit).map((a) => a.name);
  const clusters = synced.length ? synced.sort() : RESET_CLUSTERS;
  const ats = clusters.map((c) => syncedAt(ctx, c));
  const all = ats.every((t) => t);
  const sync = step('synced', `Config Sync applied on ${clusters.join(' and ')}`, { usual: SYNC_MS, hint: 'Config Sync pulls the fleet repo and applies it (≈30–90 s)' });
  sync.detail = clusters.map((c, i) => `${c} ${ats[i] ? '✓' : '…'}`).join(' · ');
  if (all) {
    sync.state = DONE;
    sync.at = Math.max(0, ...ats);
    sync.hint = '';
  }
  steps.push(sync);

  const agents = [...(model?.agents?.values() || [])];
  const healthy = agents.filter((a) => a.state === HEALTHY_STATE);
  const heal = step('healthy', 'All workloads healthy', { usual: RESET_HEAL_MS, hint: 'Workloads roll back to the demo baseline' });
  heal.detail = `${healthy.length}/${agents.length} healthy`;
  if (all && agents.length && healthy.length === agents.length) {
    const times = healthy.map((a) => ctx.local(a.stateSince)).filter((t) => Number.isFinite(t) && t >= ctx.press.time);
    heal.state = DONE;
    heal.at = Math.max(sync.at, ...times);
    heal.hint = '';
  }
  steps.push(heal);
  return steps;
}

/**
 * Fills in what the steps imply: a later step done means the earlier ones
 * are done too (a reload may not know when); the first open step is
 * active, timed from the step before it; and a step past its usual time
 * twice over is slow.
 */
function finish(steps, press, now) {
  let lastDone = -1;
  steps.forEach((s, i) => {
    if (s.state === DONE) lastDone = i;
  });
  for (let i = 0; i < lastDone; i++) {
    const s = steps[i];
    if (s.state === PENDING || s.state === ACTIVE) {
      s.state = DONE;
      s.hint = '';
      if (s.id === 'pushed' && s.detail === 'Pushing change…') s.detail = 'Committed to the fleet repo';
    }
  }
  if (steps.some((s) => s.state === FAILED)) return;
  let prev = press.time;
  for (const s of steps) {
    if (s.state === DONE) {
      if (s.at) prev = Math.max(prev, s.at);
      continue;
    }
    if (s.state === PENDING) {
      s.state = ACTIVE;
      s.since = prev;
      if (s.usual && now - prev > s.usual * SLOW_FACTOR) s.slow = true;
    } else if (s.state === ACTIVE) s.since = press.time;
    break;
  }
}
