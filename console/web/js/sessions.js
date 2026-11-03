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

// Pure helpers for the panel's sessions section and its mast-web link (no
// DOM, so they run under node --test).

import { duration, since } from './format.js';

function splitKey(key) {
  const [as, ...rest] = key.split('/');
  return [as, rest.join('/')];
}

/** The collector API path of an agent, relative to the page. */
export function apiBase(key) {
  const [as, name] = splitKey(key);
  return `api/agents/${encodeURIComponent(as)}/${encodeURIComponent(name)}`;
}

/** Where the collector serves mast-web attached to this agent. */
export function mastWebURL(key) {
  const [as, name] = splitKey(key);
  return `mast-web/a/${encodeURIComponent(as)}/${encodeURIComponent(name)}/`;
}

/** One session row: its name, status and when it was last active. */
export function sessionLine(s, now = Date.now()) {
  const id = s.sessionID || s.id || '';
  const title = s.title && s.title !== id ? s.title : '';
  const when = s.last_touched_at ? `last activity ${duration(since(s.last_touched_at, now))} ago` : '';
  return { id, title, status: s.status || '', when };
}

/** What to say when the session list is empty. */
export function emptySessionsNote(woke) {
  return woke
    ? 'No sessions listed. mast lists only the sessions it holds in memory, and a woken agent starts with none; ' +
        'a session comes back as soon as it is used again (for example when lookout sends it an update). ' +
        'You can start a new session in mast-web.'
    : 'No sessions in memory. mast lists only loaded sessions; older ones come back when they are used again.';
}

/** Turns a failed attach response into a sentence. */
export function attachError(status, text) {
  let msg = text;
  let body = null;
  try {
    body = JSON.parse(text);
    msg = body.error || text;
  } catch {
    /* plain text */
  }
  if (status === 409 && body?.wakes) {
    return {
      suspended: true,
      text: `The agent is ${String(body.state || 'not running').toLowerCase()} now, so the collector sent nothing (that would wake it). Wake it first.`,
    };
  }
  return { suspended: false, text: `${status}: ${String(msg).slice(0, 300)}` };
}

/** How long a wake keeps retrying. */
export const WAKE_RETRY_MS = 60000;

/**
 * Milliseconds to wait before retrying a wake request that got HTTP status
 * (0 = network error), or null if it shouldn't be retried. Gateway errors
 * (502/503/504) and network errors mean the router stopped waiting while the
 * resume may still be running; anything else (401, 409, …) is final.
 */
export function wakeRetryDelay(status, attempt) {
  if (status !== 0 && status !== 502 && status !== 503 && status !== 504) return null;
  return Math.min(1000 * attempt, 5000);
}
