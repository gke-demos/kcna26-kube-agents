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

// Partial instance-buffer uploads. A state change touches one instance; with
// 100,000 agents re-uploading whole buffers for it costs megabytes per frame.
// DirtyRanges collects the instances written since the last upload and turns
// them into a few coalesced ranges (or "everything" when that is cheaper),
// and uploadRanges hands them to three.js (BufferAttribute update ranges).
// Pure apart from the attribute calls, so node tests check the bookkeeping.

export class DirtyRanges {
  constructor() {
    /** @type {number[]} */
    this.marks = [];
    this.all = false;
  }

  /** Marks instance i as written. */
  mark(i) {
    if (!this.all) this.marks.push(i);
  }

  /** Marks every instance (a resize, a clear, a theme change). */
  markAll() {
    this.all = true;
    this.marks.length = 0;
  }

  get dirty() {
    return this.all || this.marks.length > 0;
  }

  /**
   * The ranges to upload for instances [0, count), and resets. Returns null
   * for "upload everything" (marked all, too many ranges, or the ranges
   * would cover more than fullFrac of the buffer), else [{start, count}] in
   * instances, sorted, with runs closer than gap merged.
   */
  take(count, { gap = 16, maxRanges = 48, fullFrac = 0.3 } = {}) {
    if (this.all) {
      this.all = false;
      this.marks.length = 0;
      return null;
    }
    const m = this.marks;
    if (!m.length) return [];
    m.sort((a, b) => a - b);
    const out = [];
    let covered = 0;
    let s = -1;
    let e = -1;
    for (const i of m) {
      if (i < 0 || i >= count) continue;
      if (s < 0) {
        s = e = i;
      } else if (i <= e + gap) {
        e = Math.max(e, i);
      } else {
        out.push({ start: s, count: e - s + 1 });
        covered += e - s + 1;
        s = e = i;
      }
    }
    if (s >= 0) {
      out.push({ start: s, count: e - s + 1 });
      covered += e - s + 1;
    }
    m.length = 0;
    if (out.length > maxRanges || covered > count * fullFrac) return null;
    return out;
  }
}

/**
 * Schedules an upload of attrs: the given instance ranges, or the whole
 * buffer for null. An empty list uploads nothing.
 * @param {{itemSize: number, needsUpdate: boolean, addUpdateRange: Function, clearUpdateRanges: Function}[]} attrs
 * @param {{start: number, count: number}[]|null} ranges
 */
export function uploadRanges(attrs, ranges) {
  if (ranges && !ranges.length) return;
  for (const a of attrs) {
    a.clearUpdateRanges();
    if (ranges) for (const r of ranges) a.addUpdateRange(r.start * a.itemSize, r.count * a.itemSize);
    a.needsUpdate = true;
  }
}
