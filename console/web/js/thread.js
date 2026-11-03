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

// An incident's Slack thread, rebuilt from signal events for the thread
// view: its messages in ts order (one per ts and type: an edit re-emits a
// ts, the latest wins), the fix someone chose, the pull requests for the
// workload since the alert, and a status. Pure, no DOM.

/** Pull request events, which come from GitHub and carry no Slack ts or thread. */
export const PR_TYPES = new Set(['pr_opened', 'pr_merged', 'pr_closed']);

/** Status chips in the order an incident moves through them. */
export const STATUS = {
  investigating: 'Investigating',
  report: 'Report ready',
  chosen: 'Fix chosen',
  pr: 'PR open',
  closed: 'PR closed',
  merged: 'Merged',
  recovered: 'Recovered',
};
const RANK = { investigating: 0, report: 1, chosen: 2, pr: 3, closed: 3, merged: 4, recovered: 5 };

/** A message that says the incident is over: healthy again, or the watcher's ":zzz: Quiet since". */
const RECOVERED_RE = /healthy again|\brecovered\b|\bresolved\b|^\s*:zzz:|quiet since/i;
/** "Option B" in a choice ("Apply Option B", "Option B: raise to 64Mi"). */
const OPTION_RE = /\boption\s+([A-Z])\b/i;
/** A person's bare "apply" (the recommended option). */
const APPLY_RE = /^\s*apply\b/i;
/** The PR number in a GitHub pull request URL. */
const PR_NUMBER_RE = /\/pull\/(\d+)/;

/** Actors shown as the kube-agents bot. */
export function isBot(actor) {
  return /^(kube-agents|platform-agent|planning-agent|cluster-agent-|event-watcher)/.test(actor || '');
}

/** A Slack ts ("1793641808.988429") in ms, or NaN. */
export function tsMillis(ts) {
  const n = Number(ts);
  return ts && Number.isFinite(n) ? Math.round(n * 1000) : NaN;
}

/** When an event happened, in ms: its Slack ts, else its time. */
function when(e) {
  const t = tsMillis(e.ts);
  return Number.isFinite(t) ? t : Date.parse(e.time || '') || 0;
}

function timeMs(e) {
  return Date.parse(e.time || '') || when(e);
}

/** The PR number from an event's link ("9"), or ''. */
export function prNumber(e) {
  return PR_NUMBER_RE.exec(e?.link || '')?.[1] || '';
}

/** The thread a workload's latest threaded signal belongs to, or ''. */
export function latestThread(events, key) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.thread && e.key === key) return e.thread;
  }
  return '';
}

/**
 * The letter of the option a fix_chosen picked, given the thread's report
 * options: "Option B" in its title or text, or the recommended option for
 * a bare "apply".
 */
export function chosenLetter(fix, options = []) {
  const m = OPTION_RE.exec(fix.title || '') || OPTION_RE.exec(fix.message || '') || OPTION_RE.exec(fix.text || '');
  if (m) return m[1].toUpperCase();
  if (APPLY_RE.test(fix.title || '')) return options.find((o) => o.recommended)?.letter || '';
  // A button's label as the choice ("Revert Frontend Image Tag to v0.10.7").
  const title = (fix.title || '').trim().toLowerCase();
  const byLabel = title && options.find((o) => o.label && (title.includes(o.label.toLowerCase()) || o.label.toLowerCase().includes(title)));
  return byLabel?.letter || '';
}

/**
 * Rebuilds a thread from signal events (any order; later entries win on
 * the same ts and type).
 * @param {any[]} events signal events, as received
 * @param {string} thread the alert's ts
 * @param {{healthy?: (key: string) => boolean}} [opts] healthy says a workload is healthy now (merged + healthy = recovered)
 * @returns {{thread: string, alert: any, key: string, cluster: string, title: string, permalink: string,
 *   status: string, statusId: string, chosen: null | {letter: string, label: string, actor: string, ev: any},
 *   items: {kind: 'msg'|'choice'|'pr', ev: any, at: number, options?: any[], number?: string}[]}}
 */
export function buildThread(events, thread, opts = {}) {
  const own = events.filter((e) => e.thread === thread);
  // Latest per ts and type; events with no ts (a PR event with the thread
  // set) are keyed by type and link.
  const latest = new Map();
  for (const e of own) {
    const id = e.ts ? `${e.ts}|${e.type}` : `|${e.type}|${e.link || ''}|${e.title || ''}`;
    latest.delete(id);
    latest.set(id, e);
  }
  const uniq = [...latest.values()];
  const alert = uniq.find((e) => e.type === 'alert') || null;
  const first = alert || [...uniq].sort((a, b) => when(a) - when(b))[0] || null;
  const key = alert?.key || uniq.find((e) => e.key)?.key || '';
  const cluster = alert?.cluster || uniq.find((e) => e.cluster)?.cluster || (key ? key.split('/')[0] : '');

  // Pull requests for the workload from the alert until the workload's next
  // alert (another incident), plus any carrying this thread.
  const start = first ? when(first) : 0;
  let end = Infinity;
  if (key) {
    for (const e of events) {
      if (e.type === 'alert' && e.key === key && e.thread !== thread && when(e) > start) end = Math.min(end, when(e));
    }
  }
  const prs = new Map();
  const addPR = (e) => {
    const id = `${e.type}|${e.link || e.title || ''}`;
    prs.delete(id);
    prs.set(id, e);
  };
  for (const e of events) {
    if (!PR_TYPES.has(e.type)) continue;
    if (e.thread === thread && !e.ts) addPR(e);
    else if (!e.thread && key && e.key === key && timeMs(e) >= start && timeMs(e) < end) addPR(e);
  }

  // Messages: one per ts (the latest that is not a fix recorded on another
  // message, which becomes a choice row instead: a report's button press
  // re-emits the report's ts as fix_chosen).
  const byTs = new Map();
  const items = [];
  for (const e of uniq) {
    if (PR_TYPES.has(e.type) && !e.ts) continue;
    const id = e.ts || `|${e.type}|${e.link || ''}|${e.title || ''}`;
    const g = byTs.get(id) || { msg: null, fixes: [] };
    byTs.set(id, g);
    if (e.type === 'fix_chosen') g.fixes.push(e);
    else g.msg = e;
  }
  for (const g of byTs.values()) {
    if (g.msg) {
      items.push({ kind: 'msg', ev: g.msg, at: when(g.msg) });
      for (const f of g.fixes) items.push({ kind: 'choice', ev: f, at: timeMs(f) });
    } else {
      for (const f of g.fixes) items.push({ kind: 'msg', ev: f, at: when(f) });
    }
  }
  for (const e of prs.values()) items.push({ kind: 'pr', ev: e, at: timeMs(e), number: prNumber(e) });
  items.sort((a, b) => a.at - b.at || (a.kind === 'msg' ? -1 : 0) - (b.kind === 'msg' ? -1 : 0));
  // The latest report's options (a re-issued report replaces the first).
  let options = [];
  for (const it of items) {
    if (it.kind === 'msg' && it.ev.type === 'triage_report' && it.ev.options?.length) options = it.ev.options;
  }

  let chosen = null;
  for (const it of items) {
    if (it.ev.type !== 'fix_chosen') continue;
    const letter = chosenLetter(it.ev, options);
    chosen = { letter, label: options.find((o) => o.letter === letter)?.label || '', actor: it.ev.actor || '', ev: it.ev };
  }
  for (const it of items) if (it.kind === 'msg' && it.ev.type === 'triage_report') it.options = it.ev.options || [];

  const statusId = threadStatus(items.map((i) => i.ev), { healthy: key && opts.healthy ? opts.healthy(key) : false });
  return {
    thread,
    alert,
    key,
    cluster,
    title: (alert || first)?.title || '',
    permalink: alert?.permalink || (alert?.link && !PR_NUMBER_RE.test(alert.link) ? alert.link : '') || first?.permalink || '',
    status: STATUS[statusId],
    statusId,
    chosen,
    items,
  };
}

/**
 * Where an incident is, from its events in time order: the furthest stage
 * reached (a later progress note does not send a report back to
 * "Investigating"). healthy: the workload is healthy now, which after a
 * merge means it recovered.
 */
export function threadStatus(events, { healthy = false } = {}) {
  let s = 'investigating';
  const bump = (to) => {
    if (RANK[to] > RANK[s] || (RANK[to] === RANK[s] && to !== s)) s = to;
  };
  for (const e of events) {
    switch (e.type) {
      case 'triage_report':
        bump('report');
        break;
      case 'fix_chosen':
        bump('chosen');
        break;
      case 'pr_opened':
        bump('pr');
        break;
      case 'pr_closed':
        if (s !== 'merged' && s !== 'recovered') bump('closed');
        break;
      case 'pr_merged':
        bump('merged');
        break;
      case 'chat':
      case 'triage':
        if (RECOVERED_RE.test(e.text || e.title || '')) bump('recovered');
        break;
      default:
        break;
    }
  }
  if (healthy && s === 'merged') s = 'recovered';
  return s;
}
