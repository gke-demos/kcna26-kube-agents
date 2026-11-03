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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toYAML } from './yaml.js';

test('nested objects and arrays, keys in order', () => {
  const v = {
    metadata: { atespace: 'cred-test', name: 't1' },
    spec: {
      image: 'runner:1',
      command: ['run', '--port=8080'],
      env: [{ name: 'GEMINI_API_KEY', value: '<redacted>' }],
      workspaces: [],
      resources: {},
    },
    status: { phase: 'Running', usage: { promptTokens: 1200 }, debug: false },
  };
  assert.equal(
    toYAML(v),
    `metadata:
  atespace: cred-test
  name: t1
spec:
  image: runner:1
  command:
    - run
    - --port=8080
  env:
    - name: GEMINI_API_KEY
      value: <redacted>
  workspaces: []
  resources: {}
status:
  phase: Running
  usage:
    promptTokens: 1200
  debug: false
`,
  );
});

test('quotes strings YAML would read as something else', () => {
  const v = { a: 'true', b: '0042', c: '', d: 'x: y', e: '- dash', f: 'no', g: '1.5', h: 'plain text', i: '#tag', j: 'trailing ', k: null };
  assert.equal(
    toYAML(v),
    `a: "true"
b: "0042"
c: ""
d: "x: y"
e: "- dash"
f: "no"
g: "1.5"
h: plain text
i: "#tag"
j: "trailing "
k: null
`,
  );
});

test('quantities, durations and ids stay plain; numbers and dates are quoted', () => {
  const v = { cpu: '500m', memory: '1Gi', after: '10m', id: '2b3c4b5-x', num: '12', e: '1e3', hex: '0x1F', t: '2026-10-13T14:39:09Z', inf: '.inf' };
  assert.equal(toYAML(v), 'cpu: 500m\nmemory: 1Gi\nafter: 10m\nid: 2b3c4b5-x\nnum: "12"\ne: "1e3"\nhex: "0x1F"\nt: "2026-10-13T14:39:09Z"\ninf: ".inf"\n');
});

test('multi-line strings become literal blocks', () => {
  assert.equal(toYAML({ msg: 'line one\nline two' }), 'msg: |-\n  line one\n  line two\n');
  assert.equal(toYAML({ msg: 'a\n\nb\n' }), 'msg: |\n  a\n\n  b\n');
});

test('arrays of arrays and top-level scalars', () => {
  assert.equal(toYAML({ m: [[1, 2], []] }), 'm:\n  - - 1\n    - 2\n  - []\n');
  assert.equal(toYAML('x'), 'x\n');
  assert.equal(toYAML([]), '[]\n');
});
