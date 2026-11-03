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

// JSON values as block YAML, for the panel's raw object view. Only what
// decoded JSON holds (objects, arrays, strings, numbers, booleans, null);
// keys keep their order. Strings that YAML would read as something else are
// double-quoted (JSON string syntax is valid YAML); multi-line strings use
// literal blocks.

// Strings that can't be plain: leading indicators, ": " or " #" inside,
// booleans and nulls (YAML 1.1 too), numbers, dates, control characters.
const PLAIN_UNSAFE =
  /^[\s,[\]{}#&*!|>'"%@`]|^[-?:](\s|$)|[\s:]$|: | #|^(true|false|yes|no|on|off|null|~|y|n)$|^[-+]?(\d[\d_]*(\.\d*)?|\.\d+)([e][-+]?\d+)?$|^0(x[\da-f]+|o[0-7]+)$|^[-+]?\.(inf|nan)$|^\d{4}-\d\d-\d\d|[\u0000-\u001f]/i;

function scalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v !== 'string') return String(v);
  if (v === '' || PLAIN_UNSAFE.test(v)) return JSON.stringify(v);
  return v;
}

function key(k) {
  return k === '' || PLAIN_UNSAFE.test(k) ? JSON.stringify(k) : k;
}

function isEmpty(v) {
  return v && typeof v === 'object' && (Array.isArray(v) ? v.length === 0 : Object.keys(v).length === 0);
}

function multiline(v) {
  return typeof v === 'string' && v.includes('\n') && !/[\u0000-\u0009\u000b-\u001f]/.test(v) && v.trim() !== '';
}

/** Lines for v at indent (a string of spaces); first is what follows "key:" or "- ". */
function lines(v, indent) {
  if (isEmpty(v)) return [Array.isArray(v) ? ' []' : ' {}'];
  if (Array.isArray(v)) {
    const out = [''];
    for (const item of v) {
      const sub = lines(item, indent + '  ');
      // A nested object's first key (or list's first item) goes on the dash line.
      if (sub[0] === '') out.push(`${indent}- ${sub[1].trimStart()}`, ...sub.slice(2));
      else out.push(`${indent}-${sub[0]}`, ...sub.slice(1));
    }
    return out;
  }
  if (v && typeof v === 'object') {
    const out = [''];
    for (const [k, c] of Object.entries(v)) {
      const sub = lines(c, indent + '  ');
      out.push(`${indent}${key(k)}:${sub[0]}`, ...sub.slice(1));
    }
    return out;
  }
  if (multiline(v)) {
    const body = v.replace(/\n$/, '').split('\n').map((l) => (l ? indent + l : ''));
    return [v.endsWith('\n') ? ' |' : ' |-', ...body];
  }
  return [' ' + scalar(v)];
}

/** v as a YAML document (no leading "---"), ending in a newline. */
export function toYAML(v) {
  const out = lines(v, '');
  const text = out[0] === '' ? out.slice(1).join('\n') : out[0].trimStart();
  return text + '\n';
}
