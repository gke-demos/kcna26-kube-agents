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

// Turns collector events into the lines of the event feed: workload changes
// (failing, healthy, scaled) and signals (alerts, triage, pull requests).

import { esc } from './format.js';
import { stateClass, CLASS_LABEL, isSignal } from './model.js';

/** Words for a signal type when its event carries no title. */
export const SIGNAL_TEXT = {
  alert: 'alert',
  triage: 'triage note',
  triage_report: 'triage report',
  fix_chosen: 'fix chosen',
  pr_opened: 'pull request opened',
  pr_merged: 'pull request merged',
  pr_closed: 'pull request closed',
  audit: 'audit',
  chat: 'message',
  action: 'console action',
};

/** A signal's identity across reconnects (the snapshot's recent list repeats what the feed has). */
export function signalId(e) {
  return `${e.type}|${e.key || ''}|${e.time || ''}|${e.title || ''}|${e.link || ''}`;
}

/** One feed line for a signal event (alert, triage, PR, ...). */
export function describeSignal(e) {
  const [cl, ...rest] = (e.key || '').split('/');
  const who = rest.join('/');
  const title = e.title || `${SIGNAL_TEXT[e.type] || e.type}${who ? ` on ${who}` : ''}`;
  return {
    type: 'signal',
    sig: e.type,
    key: e.key || '',
    cluster: e.cluster || (who ? cl : ''),
    text: esc(title),
    title,
    link: e.link || '',
    actor: e.actor || '',
    thread: e.thread || '',
    time: e.time || '',
    failed: e.type === 'action' && e.message === 'failed',
    id: signalId(e),
  };
}

/** A workload's state in words: "failing: OOMKilled", "healthy". */
export function stateWords(agent) {
  if (!agent) return '';
  const cls = stateClass(agent.state);
  const label = CLASS_LABEL[cls].toLowerCase();
  const why = cls === 'running' ? '' : agent.reason || (cls === 'crashed' ? agent.crash?.message : '') || '';
  return why ? `${label}: ${why}` : label;
}

/**
 * One feed line per workload and kind of change, and one per signal.
 * agent_state is left out when the same batch says more about that
 * workload (scaled up, scaled to 0, failing, added).
 * @returns {{type: string, key?: string, state?: string, text: string}[]}
 */
export function describe(events) {
  const out = [];
  const semantic = new Set(events.filter((e) => ['agent_woke', 'agent_suspended', 'agent_crashed', 'agent_added'].includes(e.type)).map((e) => e.key));
  for (const e of events) {
    if (isSignal(e)) {
      out.push(describeSignal(e));
      continue;
    }
    const [cl, ...rest] = (e.key || '').split('/');
    const name = rest.length ? `<span class="as">${esc(cl)}/</span>${esc(rest.join('/'))}` : esc(e.key);
    switch (e.type) {
      case 'agent_added':
        out.push({ type: 'added', key: e.key, state: e.agent.state, text: `new ${esc(e.agent.kind || 'workload')} <b>${name}</b>` });
        break;
      case 'agent_removed':
        out.push({ type: 'removed', key: e.key, state: 'DELETING', text: `<b>${name}</b> removed` });
        break;
      case 'agent_woke':
        out.push({ type: 'woke', key: e.key, state: 'RUNNING', text: `<b>${name}</b> scaled up` });
        break;
      case 'agent_suspended':
        out.push({ type: 'suspended', key: e.key, state: 'SUSPENDED', text: `<b>${name}</b> scaled to 0` });
        break;
      case 'agent_crashed': {
        const why = e.agent?.reason || e.message || '';
        out.push({ type: 'crashed', key: e.key, state: 'CRASHED', text: `<b>${name}</b> failing${why ? ': ' + esc(why.slice(0, 80)) : ''}` });
        break;
      }
      case 'agent_state':
        if (!semantic.has(e.key)) {
          out.push({ type: 'state', key: e.key, state: e.to, text: `<b>${name}</b> ${esc(stateWords(e.agent || { state: e.to }))}` });
        }
        break;
      default:
        break;
    }
  }
  return out;
}
