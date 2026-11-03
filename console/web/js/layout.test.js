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
import { squarify, planIsland, slotPosition, SlotTable } from './layout.js';

test('squarify covers the rect with areas proportional to weight', () => {
  const rect = { x: 0, y: 0, w: 16, h: 10 };
  const out = squarify(
    [
      { key: 'a', weight: 6 },
      { key: 'b', weight: 3 },
      { key: 'c', weight: 1 },
    ],
    rect,
  );
  assert.equal(out.length, 3);
  const area = Object.fromEntries(out.map((r) => [r.key, r.w * r.h]));
  assert.ok(Math.abs(area.a - 96) < 1e-6);
  assert.ok(Math.abs(area.b - 48) < 1e-6);
  assert.ok(Math.abs(area.c - 16) < 1e-6);
  for (const r of out) {
    assert.ok(r.x >= -1e-9 && r.y >= -1e-9 && r.x + r.w <= 16 + 1e-9 && r.y + r.h <= 10 + 1e-9);
  }
});

test('planIsland gives every atespace room for its agents', () => {
  const atespaces = [
    { name: 'big', count: 900 },
    { name: 'mid', count: 40 },
    { name: 'small', count: 1 },
    { name: 'empty', count: 0 },
  ];
  const plan = planIsland(atespaces);
  for (const a of atespaces) {
    const d = plan.districts.get(a.name);
    assert.ok(d, a.name);
    assert.ok(d.capacity >= a.count, `${a.name}: ${d.capacity} < ${a.count}`);
  }
  assert.ok(plan.districts.get('big').capacity > plan.districts.get('mid').capacity);
});

test('slots stay inside their district', () => {
  const plan = planIsland([{ name: 'x', count: 30 }]);
  const d = plan.districts.get('x');
  for (let s = 0; s < 30; s++) {
    const p = slotPosition(d, s);
    assert.ok(p.x > d.x && p.x < d.x + d.w && p.z > d.z && p.z < d.z + d.d);
  }
});

test('SlotTable reuses freed slots and reports full', () => {
  const t = new SlotTable(2);
  assert.equal(t.assign('a'), 0);
  assert.equal(t.assign('b'), 1);
  assert.equal(t.assign('a'), 0);
  assert.equal(t.assign('c'), -1);
  t.release('a');
  assert.equal(t.assign('c'), 0);
});
