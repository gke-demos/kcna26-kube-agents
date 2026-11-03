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

// Turns collector events into the lines of the event feed.

import { esc } from './format.js';

const REASON_TEXT = {
  IdleSuspended: 'idle',
  CompletedSuspended: 'command finished',
  ActorSuspended: 'outside ax',
  ResumedByRequest: 'by a request',
};

/**
 * One feed line per agent and kind of change. agent_state is left out when
 * the same batch says more about that agent (woke, suspended, crashed).
 * @returns {{type: string, key?: string, state?: string, text: string}[]}
 */
export function describe(events) {
  const out = [];
  const semantic = new Set(events.filter((e) => ['agent_woke', 'agent_suspended', 'agent_crashed', 'agent_added'].includes(e.type)).map((e) => e.key));
  for (const e of events) {
    const [as, ...rest] = (e.key || '').split('/');
    const name = rest.length ? `<span class="as">${esc(as)}/</span>${esc(rest.join('/'))}` : esc(e.key);
    switch (e.type) {
      case 'agent_added':
        out.push({ type: 'added', key: e.key, state: e.agent.state, text: `${e.agent.task ? 'new ax task' : 'new agent'} <b>${name}</b>` });
        break;
      case 'agent_removed':
        out.push({ type: 'removed', key: e.key, state: 'DELETING', text: `<b>${name}</b> removed` });
        break;
      case 'agent_woke':
        out.push({ type: 'woke', key: e.key, state: 'RUNNING', text: `<b>${name}</b> woke${e.reason ? ' ' + esc(REASON_TEXT[e.reason] || e.reason) : ''}` });
        break;
      case 'agent_suspended':
        out.push({ type: 'suspended', key: e.key, state: 'SUSPENDED', text: `<b>${name}</b> suspending${e.reason ? ' (' + esc(REASON_TEXT[e.reason] || e.reason) + ')' : ''}` });
        break;
      case 'agent_crashed':
        out.push({ type: 'crashed', key: e.key, state: 'CRASHED', text: `<b>${name}</b> crashed${e.message ? ': ' + esc(e.message.slice(0, 80)) : ''}` });
        break;
      case 'agent_state':
        if (!semantic.has(e.key)) {
          out.push({ type: 'state', key: e.key, state: e.to, text: `<b>${name}</b> ${esc(e.from.toLowerCase())} → ${esc(e.to.toLowerCase())}` });
        }
        break;
      case 'task_updated':
        if (e.reason) out.push({ type: 'task', key: e.key, state: e.agent.state, text: `<b>${name}</b> ax: ${esc(e.reason)}` });
        break;
      case 'worker_added':
        out.push({ type: 'worker', text: `worker <b>${esc(e.worker.pod || e.key)}</b> joined` });
        break;
      case 'worker_removed':
        out.push({ type: 'worker', text: `worker <b>${esc(e.worker.pod || e.key)}</b> left` });
        break;
      default:
        break;
    }
  }
  return out;
}
