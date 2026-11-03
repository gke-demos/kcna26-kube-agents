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

// Connection to the collector: GET /api/stream (WebSocket). The server sends
// a snapshot, then event batches. A gap in sequence numbers or a dropped
// connection leads to a reconnect, which starts with a fresh snapshot.

export class Stream {
  /**
   * @param {string} url
   * @param {{onSnapshot: Function, onEvents: Function, onStatus: Function}} handlers
   *   onEvents returns false when the batch doesn't apply (gap).
   */
  constructor(url, handlers) {
    this.url = url;
    this.h = handlers;
    this.backoff = 500;
    this.closed = false;
    this.connect();
  }

  connect() {
    if (this.closed) return;
    this.h.onStatus('connecting');
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 500;
    };
    ws.onmessage = (msg) => {
      let m;
      try {
        m = JSON.parse(msg.data);
      } catch {
        return;
      }
      if (m.type === 'snapshot') {
        this.h.onStatus('live');
        this.h.onSnapshot(m.snapshot, !!m.resync);
      } else if (m.type === 'events') {
        if (this.h.onEvents(m.events) === false) {
          // Out of order: start over from a snapshot.
          ws.close();
        }
      }
    };
    ws.onclose = () => {
      if (this.closed) return;
      this.h.onStatus('reconnecting');
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 10000);
    };
  }

  close() {
    this.closed = true;
    this.ws?.close();
  }
}

/** URL of the stream endpoint relative to the page. */
export function streamURL(loc = window.location) {
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${loc.host}${loc.pathname.replace(/[^/]*$/, '')}api/stream`;
}
