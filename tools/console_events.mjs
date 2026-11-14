// Print the signal events a running fleet-scope holds (its snapshot's "recent"
// list), oldest first, for checking what the console made of an incident.
//
// Usage: node tools/console_events.mjs [URL] [SINCE_ISO]
//   URL defaults to ws://localhost:18080/api/stream (scripts/console.sh open);
//   SINCE_ISO keeps only events at or after that time.
const DEFAULT_URL = 'ws://localhost:18080/api/stream';
const TIMEOUT_MS = 15000;
const TITLE_CHARS = 110;
// Workload state changes: the feed's other half, not signals.
const STATE_EVENTS = new Set(['agent_state', 'agent_crashed', 'cluster_synced', 'agent_added', 'agent_removed']);

const url = process.argv[2] || DEFAULT_URL;
const since = process.argv[3] ? Date.parse(process.argv[3]) : 0;
const ws = new WebSocket(url);
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  const snap = msg.snapshot || msg;
  if (!Array.isArray(snap.recent)) return;
  for (const e of snap.recent) {
    if (STATE_EVENTS.has(e.type) || Date.parse(e.time) < since) continue;
    console.log(e.time, e.type, e.key || '-', e.actor || '-', '|', (e.title || '').slice(0, TITLE_CHARS));
  }
  process.exit(0);
};
ws.onerror = (e) => {
  console.error('ws error:', e.message || e);
  process.exit(1);
};
setTimeout(() => {
  console.error('no snapshot within', TIMEOUT_MS, 'ms');
  process.exit(1);
}, TIMEOUT_MS);
