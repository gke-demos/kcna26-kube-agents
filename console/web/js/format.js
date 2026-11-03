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

// Small formatting helpers shared by the panel, the feed and labels.

/** Escapes text for innerHTML. */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Formats seconds as "3m 12s", "2h 05m", "4d 3h". */
export function duration(sec) {
  sec = Math.max(0, Math.floor(sec));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ${String(sec % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Seconds since an ISO time. */
export function since(iso, now = Date.now()) {
  if (!iso) return 0;
  return (now - Date.parse(iso)) / 1000;
}

/** Parses a Go duration such as "10m", "90s", "1h30m" into seconds. */
export function parseGoDuration(s) {
  if (!s) return 0;
  let total = 0;
  const re = /([0-9.]+)(h|ms|m|s)/g;
  let m;
  while ((m = re.exec(s))) {
    const v = parseFloat(m[1]);
    total += m[2] === 'h' ? v * 3600 : m[2] === 'm' ? v * 60 : m[2] === 's' ? v : v / 1000;
  }
  return total;
}

/** Short form of a worker for labels: its pod name without the pool prefix noise. */
export function workerLabel(w) {
  if (!w) return '';
  return w.pod || w.name.slice(0, 8);
}

/** Clock time "18:42:07". */
export function clock(iso) {
  const d = iso ? new Date(iso) : new Date();
  return d.toLocaleTimeString([], { hour12: false });
}

/** A count for tight spaces: 9,876 exactly, then 12.3k, 123k, 1.2M. */
export function compact(n) {
  const v = Math.round(Number(n) || 0);
  const a = Math.abs(v);
  if (a < 10000) return v.toLocaleString('en-US');
  const unit = a < 999500 ? [1e3, 'k'] : [1e6, 'M'];
  const x = v / unit[0];
  const s = Math.abs(x) < 99.95 ? x.toFixed(1) : x.toFixed(0);
  return `${s.replace(/\.0$/, '')}${unit[1]}`;
}
